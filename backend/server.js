require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { CloudWatchLogsClient, PutLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const cloudwatchLogs = new CloudWatchLogsClient({ region: process.env.AWS_REGION });

async function logToCloudWatch(message, isError = false) {
  const timestamp = Date.now();
  const logMessage = `[${new Date().toISOString()}] ${isError ? 'ERROR' : 'INFO'}: ${message}`;
  if (isError) console.error(logMessage); else console.log(logMessage);
  try {
    await cloudwatchLogs.send(new PutLogEventsCommand({
      logGroupName: '/ai-video-interview/logs',
      logStreamName: 'backend-stream',
      logEvents: [{ message: logMessage, timestamp }],
    }));
  } catch (err) { console.error("⚠️ CloudWatch log failed:", err.message); }
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || "http://localhost:3000", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 5000;

// In-memory session store (persists as long as server is running)
// Key: sessionId, Value: { candidateName, proctoringFlags, transcript, score, videoUrl, status, completedAt }
const sessionStore = new Map();

// Per-socket chunk tracking for deduplication
const socketState = new Map();

function getSocketState(socketId) {
  if (!socketState.has(socketId)) {
    socketState.set(socketId, { chunkCount: 0, seenSequences: new Set() });
  }
  return socketState.get(socketId);
}

io.on('connection', (socket) => {
  logToCloudWatch(`🟢 WebSocket Client Connected: ${socket.id}`);

  socket.on('video-chunk', async (payload) => {
    let chunkData, sequence;
    if (payload && payload.data !== undefined && payload.sequence !== undefined) {
      chunkData = Buffer.from(payload.data);
      sequence = payload.sequence;
    } else {
      chunkData = Buffer.from(payload);
      sequence = getSocketState(socket.id).chunkCount;
    }

    const state = getSocketState(socket.id);

    // Deduplication
    if (state.seenSequences.has(sequence)) {
      logToCloudWatch(`⚠️ Duplicate chunk ignored: session=${socket.id} seq=${sequence}`);
      return;
    }
    state.seenSequences.add(sequence);

    // Validate chunk size
    if (!chunkData || chunkData.length < 100) {
      logToCloudWatch(`⚠️ Empty/corrupt chunk dropped: seq=${sequence} size=${chunkData?.length ?? 0}`, true);
      return;
    }

    state.chunkCount++;
    const paddedSeq = String(sequence).padStart(6, '0');
    const fileName = `chunks/${socket.id}/chunk_${socket.id}_${paddedSeq}_${Date.now()}.webm`;

    try {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: fileName,
        Body: chunkData,
        ContentType: 'video/webm',
      }));
      logToCloudWatch(`☁️ ✅ S3: ${fileName} (${chunkData.length} bytes)`);
    } catch (err) {
      logToCloudWatch(`☁️ 🔴 S3 Upload Failed: ${err.message}`, true);
    }
  });

  socket.on('proctoring-alert', (payload) => {
    const msg = typeof payload === 'string' ? payload : payload?.message || String(payload);
    logToCloudWatch(`🚨 PROCTORING FLAG [${socket.id}]: ${msg}`);
  });

  socket.on('disconnect', () => {
    const state = socketState.get(socket.id);
    logToCloudWatch(`🔴 Disconnected: ${socket.id} | Chunks: ${state?.chunkCount ?? 0}`);
    socketState.delete(socket.id);
  });
});

// Called by frontend when interview finishes
app.post('/api/process-interview', async (req, res) => {
  const { sessionId, candidateName, proctoringFlags } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  logToCloudWatch(`⚙️ Interview finished: ${sessionId} | Candidate: ${candidateName}`);

  // Save candidate info immediately so dashboard shows "Processing..." state
  sessionStore.set(sessionId, {
    candidateName: candidateName || 'Unknown Candidate',
    proctoringFlags: proctoringFlags || [],
    transcript: null,
    score: null,
    videoUrl: null,
    status: 'Processing',
    completedAt: new Date().toISOString(),
  });

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: process.env.AUDIO_MERGE_QUEUE_URL,
      MessageBody: JSON.stringify({
        task: "MERGE_AND_TRANSCRIBE",
        sessionId,
        candidateName: candidateName || 'Unknown Candidate',
        proctoringFlags: proctoringFlags || [],
        timestamp: Date.now(),
      }),
    }));
    logToCloudWatch(`📨 Job queued for session: ${sessionId}`);
    res.status(200).json({ message: "Queued for processing.", sessionId });
  } catch (err) {
    logToCloudWatch(`🔴 SQS Error: ${err.message}`, true);
    res.status(500).json({ error: "Failed to queue job" });
  }
});

// Called by worker when transcription is done
app.post('/api/session-result', async (req, res) => {
  const { sessionId, transcript, score, videoUrl } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const existing = sessionStore.get(sessionId) || {};
  sessionStore.set(sessionId, {
    ...existing,
    transcript,
    score: score ?? 0,
    videoUrl: videoUrl || null,
    status: 'Completed',
  });

  logToCloudWatch(`✅ Session result stored: ${sessionId}`);
  res.status(200).json({ message: 'Result stored' });
});

// Dashboard: get all sessions list
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(sessionStore.entries()).map(([sessionId, data]) => ({
    sessionId,
    candidateName: data.candidateName,
    status: data.status,
    completedAt: data.completedAt,
    score: data.score,
    proctoringFlagCount: data.proctoringFlags?.length ?? 0,
  }));
  // Most recent first
  sessions.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  res.status(200).json(sessions);
});

// Dashboard: get one session's full data
app.get('/api/session/:sessionId', (req, res) => {
  const data = sessionStore.get(req.params.sessionId);
  if (!data) return res.status(404).json({ error: 'Session not found' });
  res.status(200).json(data);
});


// Delete a session — removes from store and deletes S3 video
app.delete('/api/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const data = sessionStore.get(sessionId);
  if (!data) return res.status(404).json({ error: 'Session not found' });

  // Delete the merged video from S3 if it exists
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: `videos/${sessionId}/interview.webm`,
    }));
    await logToCloudWatch(`🗑️ Deleted S3 video for session: ${sessionId}`);
  } catch (err) {
    await logToCloudWatch(`⚠️ Could not delete S3 video: ${err.message}`, true);
  }

  sessionStore.delete(sessionId);
  await logToCloudWatch(`🗑️ Session deleted: ${sessionId} (${data.candidateName})`);
  res.status(200).json({ message: 'Session deleted' });
});

app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

server.listen(PORT, () => {
  logToCloudWatch(`🚀 Server live on http://localhost:${PORT}`);
});