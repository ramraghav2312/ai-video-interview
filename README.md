# AI Video Interview Platform

An automated, AI-driven first-round interview system that captures candidate video/audio in real-time, streams it to cloud storage, and uses AI to transcribe and evaluate responses — freeing recruiters from time-consuming initial screening.

---

## 1. Problem Understanding

**What problem are you solving?**
Manual first-round interviews are time-consuming and impossible to scale. A recruiter spending 30 minutes per candidate can only screen ~16 candidates a day.

**Why is this system needed?**
Recruiters need a way to screen hundreds of candidates asynchronously while maintaining a high-fidelity record of candidate responses, technical ability, and communication skills — without sacrificing interview integrity.

---

## 2. Architecture Overview

The system uses a Next.js frontend, a Node.js/Express backend, and a separate async worker process connected via AWS SQS.

### High-Level System Architecture

```
Candidate Browser (Next.js)
    │
    ├─ WebSocket (socket.io) ──────────────► Node.js Ingestion Server (server.js)
    │   └─ video-chunk events (3s blobs)        └─ Deduplicates, validates, uploads chunks to S3
    │   └─ proctoring-alert events              └─ Stores session metadata in memory
    │                                           └─ Logs all events to AWS CloudWatch
    └─ POST /api/process-interview ──────► AWS SQS Queue
                                                    └─ Node.js Worker (worker.js)
                                                         ├─ Downloads chunks from S3
                                                         ├─ Binary concat + FFmpeg merge
                                                         ├─ Transcribes via Deepgram nova-2
                                                         ├─ Uploads merged video back to S3
                                                         ├─ Generates presigned URL (7-day)
                                                         └─ Posts result to server → Dashboard
```

### Media Flow

1. **Frontend:** Candidate enters their name, passes hardware check, then the `MediaRecorder` API captures video/audio in 3-second Blobs, each tagged with a monotonically incrementing sequence number.
2. **Streaming:** Chunks are emitted over a persistent WebSocket connection as structured payloads `{ data: ArrayBuffer, sequence: number }`.
3. **Storage:** The backend validates and deduplicates each chunk, then uploads it to AWS S3 under `chunks/{socketId}/chunk_{socketId}_{paddedSequence}_{timestamp}.webm`.
4. **Processing:** When the interview ends, a `POST /api/process-interview` call sends `sessionId`, `candidateName`, and `proctoringFlags` to the server, which queues a job via AWS SQS.
5. **Merge:** The worker downloads all chunks, binary-concatenates the raw bytes (required because MediaRecorder only writes the WebM header into the first chunk), then runs FFmpeg to reconstruct clean timestamps.
6. **Transcription:** The merged file is sent to Deepgram's `nova-2` model for Speech-to-Text conversion.
7. **Video Upload:** The merged video is uploaded back to S3 under `videos/{sessionId}/interview.webm` and a 7-day presigned URL is generated for secure playback in the dashboard.
8. **Dashboard:** The recruiter sees the real candidate name, video playback, AI transcript, and proctoring flags. Interviews can be deleted, which removes both the session data and the S3 video.

### WebSocket / Event Flow

- **`video-chunk`**: Carries each 3-second media blob from browser to server for S3 ingestion.
- **`proctoring-alert`**: Emitted when face absence or tab-switching is detected. Logged to CloudWatch immediately.
- **Auto-reconnect**: The frontend socket.io client uses infinite retries with exponential backoff (max 5s). A live/reconnecting badge is shown to candidates during the interview.

---

## 3. Technical Decisions & Tradeoffs

**Why streaming over full upload?**
Streaming 3-second chunks ensures that if the browser crashes or the connection drops, we have already captured most of the candidate's responses. A full upload at the end would risk losing everything in a single failure. It also avoids holding the entire recording in browser memory.

**Why WebSockets over HTTP polling for chunks?**
WebSockets maintain a persistent connection ideal for continuous binary data and real-time bidirectional events like proctoring alerts. The `socket.id` also serves as a natural per-session identifier used as the S3 prefix.

**Why binary concat before FFmpeg, not the concat demuxer?**
The browser's `MediaRecorder` API only writes the WebM file header (EBML metadata) into the very first chunk. Chunks 2, 3, 4... are raw continuation data with no headers. FFmpeg's concat demuxer expects each input to be a self-contained valid file, so it crashes on chunk 2 with `EBML header parsing failed`. The solution is to physically stitch the raw binary buffers together first, then pass the single combined file to FFmpeg purely for timestamp reconstruction — no re-encoding required.

**Why SQS + a separate worker over in-process handling?**
FFmpeg merges and Deepgram API calls take seconds to minutes. Running them synchronously inside the Express server would block the Node.js event loop and cause request timeouts. The SQS queue fully decouples ingestion from processing, keeping the main API responsive regardless of processing load.

**Why BlazeFace over other face detection models?**
BlazeFace is a lightweight model optimised for browser-side inference. Heavier models (face-api.js, MediaPipe full mesh) caused noticeable frame-rate drops that degraded the video feed. BlazeFace gives acceptable detection accuracy at a fraction of the compute cost.

---

## 4. Failure Scenarios & Edge Cases

| Scenario | Risk | Mitigation |
|---|---|---|
| **Network Interruption** | Partial data loss, dropped WebSocket | socket.io auto-reconnect with infinite retries + exponential backoff |
| **Duplicate Chunks** | Same chunk stored twice, corrupt merge | Server-side `seenSequences` Set per session — duplicates silently dropped |
| **Camera/Mic Disconnect** | Loss of video feed mid-interview | MediaRecorder error surfaces blank feed; candidate can restart from landing page |
| **Partial Upload Failure** | S3 write error for one chunk | Error caught and logged to CloudWatch; sequence gap visible in chunk list |
| **WebSocket Reconnect** | Proctoring gap, missed chunks | Auto-reconnect resumes stream; sequence numbers allow gap detection |
| **Empty/Corrupted Chunks** | Storage bloat, FFmpeg failure | Server drops any chunk under 100 bytes before S3 upload |
| **Out-of-Order Arrival** | FFmpeg merges in wrong order | S3 keys use zero-padded sequence numbers (`000001`, `000002`...) — sorted lexicographically before merge |
| **Worker Crash Mid-Job** | Partial processing, no result posted | SQS message visibility timeout returns job to queue for retry; CloudWatch alert fires |

---

## 5. Recovery Mechanisms

**Candidate State Persistence:**
`localStorage` stores the current question index and candidate name on every transition. If the candidate refreshes or recovers from a crash, the app reads these values on mount and resumes from the correct question. `localStorage` is cleared only on successful interview completion.

**Socket Auto-Reconnection:**
The frontend socket.io client is initialised with `reconnection: true`, `reconnectionAttempts: Infinity`, and `reconnectionDelayMax: 5000ms`. A live/reconnecting status badge is shown in the interview UI so candidates are aware of their connection state at all times.

**Chunk Recovery Strategy:**
Chunks use deterministic, zero-padded sequence keys in S3: `chunks/{sessionId}/chunk_{socketId}_{000001}_{timestamp}.webm`. The worker sorts by the padded sequence segment before processing, ensuring correct ordering even when chunks arrive out of sequence. The server-side `seenSequences` Set prevents double-storage from network retries.

**Failure Handling:**
All S3, FFmpeg, SQS, and Deepgram errors are caught in `try/catch` blocks, logged to CloudWatch at `ERROR` level, and trigger an `EVALUATION PIPELINE ALERT` in the `worker-stream` log group. The session remains in `Processing` state in the dashboard until the worker successfully posts a result.

---

## 6. Product Thinking

**Candidate Experience:**
- A landing page collects the candidate's name before anything starts, personalising the experience and ensuring the recruiter sees a real name in the dashboard.
- A mandatory Hardware Check page verifies camera and microphone are functional before the interview begins, preventing candidates from discovering a broken setup mid-session.
- The interview UI shows a live chunk counter and a connection status badge (● Live / ● Reconnecting) so candidates know their responses are being captured.
- Video is mirrored (`-scale-x-100`) so candidates see a natural reflection of themselves.
- A warning beep and alert fires on tab-switch, making the proctoring transparent rather than hidden.

**Recruiter Experience:**
- The `/dashboard` route shows only real completed sessions — no placeholder data. New sessions appear automatically every 5 seconds without a page refresh.
- Each session shows a processing indicator while FFmpeg and Deepgram are running, then updates automatically to show the real video, transcript, and flags.
- A unified drill-down view combines video playback (with audio, via presigned S3 URL), AI transcript, and proctoring report in one place — everything needed to make a screening decision without switching tabs.
- Recruiters can delete a candidate's interview from the dashboard, which removes both the session data and the merged video from S3.

**Suspicious Activity Tracking:**
Two independent signals are captured and displayed with timestamps in the recruiter's proctoring report:
- **Face Absence:** TensorFlow BlazeFace runs face detection on every animation frame. If no face is detected for 3+ seconds, a proctoring alert is emitted over WebSocket and logged.
- **Tab Switching:** The `visibilitychange` DOM event fires when the candidate switches tabs or minimises the window. The event is logged locally and emitted to the server in real time.

Both signals are collected on the frontend and sent to the server when the interview finishes, stored with the session, and rendered in the recruiter dashboard with human-readable timestamps.

---

## 7. Scalability Considerations

**What may break at scale:**
- **Single worker process:** The current `worker.js` is one Node.js process. At high volume, the SQS queue would build up faster than one worker can drain it.
- **In-memory session store:** Sessions are stored in a `Map` in `server.js`. Restarting the server loses all session data. At scale this must be a database.
- **CloudWatch log sequencing:** Concurrent `PutLogEvents` calls without sequence token management can fail silently under high load.
- **S3 list operations:** `ListObjectsV2` with a session prefix slows down as bucket size grows without date-based partitioning.

**Performance Bottlenecks:**
- Deepgram API latency is the longest step (5–30 seconds per file). Transcribing per-question audio segments in parallel instead of one merged file would reduce total turnaround time.
- FFmpeg runs synchronously in the worker, blocking its event loop during the merge. Spawning it as a child process with a timeout guard would improve resilience.

**Future Improvements:**
- Replace in-memory session store with MongoDB or DynamoDB for persistence across server restarts.
- Deploy `worker.js` logic as an AWS Lambda triggered directly by SQS — scales horizontally to match queue depth automatically.
- Partition S3 keys by `YYYY/MM/DD/{sessionId}/` to avoid list-scan degradation.
- Add per-question segment transcription for faster results and more granular recruiter review.
- Implement real AI scoring via an LLM API call on the transcript after Deepgram completes.

---

## 8. Observability & Debugging

**Logging Strategy:**
All significant events are written to AWS CloudWatch via `@aws-sdk/client-cloudwatch-logs`. Two log streams are used:
- `/ai-video-interview/logs` → `backend-stream` — WebSocket connections, chunk uploads, SQS sends, session results
- `/ai-video-interview/logs` → `worker-stream` — chunk downloads, FFmpeg operations, Deepgram results, cleanup

Each entry is timestamped in ISO 8601 format and tagged `INFO` or `ERROR`.

**Error Tracking:**
Failed S3 uploads, SQS errors, FFmpeg failures, and Deepgram errors are all caught, logged at `ERROR` level, and surface an `EVALUATION PIPELINE ALERT` message in the worker stream — a searchable pattern in CloudWatch Logs Insights.

**Debugging Production Failures:**
1. Filter `worker-stream` for `EVALUATION PIPELINE ALERT` to find failed jobs.
2. Use the `sessionId` in the alert to list the corresponding S3 chunks and confirm they were uploaded.
3. Cross-reference `backend-stream` for upload errors matching the same `sessionId`.
4. Re-queue the failed `sessionId` manually via the AWS SQS console for reprocessing.

---

## 9. AI Usage Documentation

**How AI Tools Were Used:**
Gemini was used as a thinking accelerator throughout this project. It was most valuable in two phases: initial architecture planning (structuring the SQS queue flow, deciding on the separation between `server.js` and `worker.js`) and active debugging (identifying the `EBML header parsing failed` FFmpeg error caused by MediaRecorder's single-header WebM format, and diagnosing the Windows backslash path issue in FFmpeg's concat demuxer).

**Prompting Strategy:**
An "Understand → Explore → Decide" approach was used consistently. For example, when the FFmpeg merge was failing: first prompting to understand why WebM chunks lack headers after the first one, then exploring the options (re-encode all chunks, use binary concat, use segment muxer), then deciding on binary concat + FFmpeg timestamp fix as the fastest approach with no quality loss. This avoided accepting the first suggestion and ensured every decision was technically justified.

**Human vs. AI Decisions:**
AI generated scaffolding and structural suggestions. Human decisions included: choosing zero-padded sequence keys over timestamp-only keys after reasoning through out-of-order arrival scenarios; adding the `seenSequences` deduplication Set after thinking through network retry failure modes; pivoting from face-api.js to BlazeFace after observing real frame-rate degradation during testing; structuring the S3 prefix as `chunks/{sessionId}/` to make `ListObjectsV2` prefix filtering reliable; and designing the two-step binary-concat-then-FFmpeg pipeline after understanding the root cause of the EBML error. Every piece of generated code was manually reviewed, tested end-to-end, and debugged before inclusion.

---

## 10. Demo & Walkthrough

### Setup Instructions

**Prerequisites:**
- Node.js 18+
- AWS account with S3 bucket, SQS queue, and CloudWatch log group configured
- Deepgram API key

**Backend:**
```bash
cd backend
npm install
cp .env.example .env
# Fill in your values in .env

# Terminal 1 — Ingestion Server
node server.js

# Terminal 2 — Async Queue Worker
node worker.js
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev
# Opens at http://localhost:3000
```

**Required `.env` values:**
```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_BUCKET_NAME=your-bucket
AUDIO_MERGE_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/...
DEEPGRAM_API_KEY=your_deepgram_key
PORT=5000
FRONTEND_URL=http://localhost:3000
```

**Required AWS IAM permissions:**
`s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject`, `sqs:SendMessage`, `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `logs:PutLogEvents`

**Required CloudWatch setup:**
- Log Group: `/ai-video-interview/logs`
- Log Streams: `backend-stream`, `worker-stream`

### Application Flow
1. Candidate visits `http://localhost:3000` → enters their name on the landing page
2. Hardware Check page — enables camera and microphone, verifies feed
3. Interview — three questions presented sequentially; video streams continuously to backend in 3-second chunks
4. On "Finish Interview" — proctoring flags and session metadata sent to server, async processing job queued via SQS
5. Worker picks up the job: downloads chunks → binary concat → FFmpeg merge → Deepgram transcription → S3 video upload → posts result to server
6. Recruiter visits `http://localhost:3000/dashboard` — sees real candidate name, video playback with audio, AI transcript, and proctoring report
7. Recruiter can delete the interview, which removes data from both the server and S3

### Demo Video
`[Link to walkthrough video — record and add here]`

### Live Demo
`[Vercel/Render deployment URL — add after hosting]`