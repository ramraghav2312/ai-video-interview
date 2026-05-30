require('dotenv').config();
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { CloudWatchLogsClient, PutLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { createClient } = require('@deepgram/sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const s3 = new S3Client({ region: process.env.AWS_REGION });
const cloudwatchLogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION });
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

async function logToCloudWatch(message, isError = false) {
  const timestamp = Date.now();
  const logMessage = `[${new Date().toISOString()}] ${isError ? 'ERROR' : 'INFO'}: ${message}`;
  if (isError) console.error(logMessage); else console.log(logMessage);
  try {
    await cloudwatchLogs.send(new PutLogEventsCommand({
      logGroupName: '/ai-video-interview/logs',
      logStreamName: 'worker-stream',
      logEvents: [{ message: logMessage, timestamp }],
    }));
  } catch (err) { console.error("⚠️ CloudWatch log failed:", err.message); }
}

// Convert AWS SDK v3 S3 stream to Buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Download all chunks for a session from S3
async function downloadChunksFromS3(sessionId, tmpDir) {
  await logToCloudWatch(`📥 Listing S3 chunks for session: ${sessionId}`);

  const { Contents } = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.AWS_BUCKET_NAME,
    Prefix: `chunks/${sessionId}/`,
  }));

  if (!Contents || Contents.length === 0) throw new Error(`No chunks found for session: ${sessionId}`);

  await logToCloudWatch(`📦 Found ${Contents.length} chunks`);

  const sorted = Contents.sort((a, b) => {
    const seqA = parseInt(a.Key.split('_')[2]) || 0;
    const seqB = parseInt(b.Key.split('_')[2]) || 0;
    return seqA - seqB;
  });

  const localPaths = [];
  for (const obj of sorted) {
    const localPath = path.join(tmpDir, path.basename(obj.Key));
    await logToCloudWatch(`⬇️ Downloading: ${obj.Key}`);
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: process.env.AWS_BUCKET_NAME, Key: obj.Key }));
    fs.writeFileSync(localPath, await streamToBuffer(Body));
    localPaths.push(localPath);
  }

  await logToCloudWatch(`✅ Downloaded ${localPaths.length} chunks`);
  return { localPaths, s3Keys: sorted.map(c => c.Key) };
}

// Binary concat + FFmpeg timestamp fix (correct approach for MediaRecorder WebM chunks)
async function mergeChunksWithFFmpeg(chunkPaths, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const normalize = p => p.replace(/\\/g, '/');
      const combinedPath = outputPath.replace('.webm', '_combined.webm');

      // Step 1: Binary stitch — only chunk 0 has the WebM header, so we must concat raw bytes first
      const combinedBuffer = Buffer.concat(chunkPaths.map(p => fs.readFileSync(p)));
      fs.writeFileSync(combinedPath, combinedBuffer);

      // Step 2: FFmpeg fixes broken timestamps on the combined file
      ffmpeg(normalize(combinedPath))
        .outputOptions(['-c', 'copy'])
        .output(normalize(outputPath))
        .on('start', cmd => console.log('FFmpeg:', cmd))
        .on('stderr', line => console.log('FFmpeg:', line))
        .on('error', err => { try { fs.unlinkSync(combinedPath); } catch (_) {} reject(err); })
        .on('end', () => { try { fs.unlinkSync(combinedPath); } catch (_) {} resolve(); })
        .run();
    } catch (err) { reject(err); }
  });
}

// Upload the merged video to S3 and return a presigned URL (7-day expiry)
async function uploadMergedVideoToS3(sessionId, mergedPath) {
  await logToCloudWatch(`☁️ Uploading merged video to S3...`);
  const key = `videos/${sessionId}/interview.webm`;
  const buffer = fs.readFileSync(mergedPath);

  await s3.send(new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: 'video/webm',
  }));

  // Generate presigned URL valid for 7 days
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
  }), { expiresIn: 604800 });

  await logToCloudWatch(`✅ Merged video uploaded: ${key}`);
  return url;
}

// Transcribe with Deepgram nova-2
async function transcribeWithDeepgram(mergedPath) {
  await logToCloudWatch(`🎙️ Sending to Deepgram...`);
  const audioBuffer = fs.readFileSync(mergedPath);

  const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
    audioBuffer,
    { model: 'nova-2', smart_format: true, punctuate: true, language: 'en' }
  );

  if (error) throw new Error(`Deepgram error: ${error.message}`);
  const transcript = result.results.channels[0].alternatives[0].transcript;
  await logToCloudWatch(`📝 Transcript length: ${transcript.length} chars`);
  return transcript;
}

// Delete raw chunks from S3 after successful processing
async function cleanupChunks(s3Keys) {
  if (!s3Keys?.length) return;
  await s3.send(new DeleteObjectsCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Delete: { Objects: s3Keys.map(Key => ({ Key })) },
  }));
  await logToCloudWatch(`🧹 Deleted ${s3Keys.length} raw chunks from S3`);
}

// Post completed results back to server so dashboard can show them
async function postResultToServer(sessionId, transcript, videoUrl) {
  try {
    const res = await fetch(`http://localhost:${process.env.PORT || 5000}/api/session-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, transcript, videoUrl, score: 75 }),
    });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    await logToCloudWatch(`📤 Results posted to dashboard for: ${sessionId}`);
  } catch (err) {
    await logToCloudWatch(`⚠️ Could not post results to server: ${err.message}`, true);
  }
}

async function processJob(taskData) {
  const { sessionId } = taskData;
  if (!sessionId) throw new Error("Missing sessionId");

  const tmpDir = path.join('/tmp', `interview_${sessionId}_${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const mergedPath = path.join(tmpDir, 'merged.webm');
  let s3Keys = [];

  try {
    const { localPaths, s3Keys: keys } = await downloadChunksFromS3(sessionId, tmpDir);
    s3Keys = keys;

    await logToCloudWatch(`⚙️ Merging ${localPaths.length} chunks with FFmpeg...`);
    await mergeChunksWithFFmpeg(localPaths, mergedPath);
    await logToCloudWatch(`✅ FFmpeg merge complete`);

    const [transcript, videoUrl] = await Promise.all([
      transcribeWithDeepgram(mergedPath),
      uploadMergedVideoToS3(sessionId, mergedPath),
    ]);

    await logToCloudWatch(`📝 Transcript preview: ${transcript.slice(0, 150)}...`);

    await postResultToServer(sessionId, transcript, videoUrl);
    await cleanupChunks(s3Keys);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function pollQueue() {
  try {
    const response = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: process.env.AUDIO_MERGE_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
    }));

    if (response.Messages?.length > 0) {
      const message = response.Messages[0];
      const taskData = JSON.parse(message.Body);
      await logToCloudWatch(`📦 Processing: ${taskData.task} | Session: ${taskData.sessionId}`);

      await processJob(taskData);

      await sqs.send(new DeleteMessageCommand({
        QueueUrl: process.env.AUDIO_MERGE_QUEUE_URL,
        ReceiptHandle: message.ReceiptHandle,
      }));
      await logToCloudWatch(`✅ Job complete and removed from queue`);
    }
  } catch (error) {
    await logToCloudWatch(`🔴 Worker Error: ${error.message}`, true);
    await logToCloudWatch(`🚨 EVALUATION PIPELINE ALERT: Failed to process job. Developer review required.`, true);
  }

  setTimeout(pollQueue, 2000);
}

logToCloudWatch("👷 Worker started. Listening to SQS...");
pollQueue();