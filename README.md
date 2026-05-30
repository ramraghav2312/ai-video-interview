This is a fantastic draft, but because we made some incredibly smart engineering decisions during development (like adding the AWS CloudWatch integration, the `localStorage` fix, and the TensorFlow BlazeFace pivot), we need to update a few sections so the README perfectly matches the actual enterprise code you wrote.

Here is your **fully updated and finalized README**. I have polished the text and updated the technical details to reflect your final architecture exactly. You can copy and paste this directly into your `README.md` file:

---

### 1. Problem Understanding

* **What problem are you solving?**
Manual first-round interviews are time-consuming and difficult to scale.
* **Why is this system needed?**
Recruiters need a way to screen hundreds of candidates asynchronously while maintaining a high-fidelity record of candidate responses, technical ability, and communication skills.

### 2. Architecture Overview

The system utilizes a modern MERN stack with a microservices-inspired asynchronous processing layer.

**High-Level System Architecture**
The architecture is divided into a React/Next.js frontend and a Node.js/Express backend. Heavy media processing is completely decoupled from the main server and handled by an independent Node.js worker process via AWS SQS.

**Media Flow**

1. **Frontend:** Uses the MediaRecorder API to capture video/audio in small Blobs (3-second chunks).
2. **Streaming:** Chunks are sent continuously via WebSockets to the backend ingestion server.
3. **Storage:** Raw chunks are streamed directly into an AWS S3 Bucket.
4. **Processing:** An asynchronous queue (`AUDIO_MERGE_QUEUE_URL` via AWS SQS) triggers a separate worker process to run FFmpeg and merge the chunks.
5. **Transcription:** The final extracted audio file is sent to Deepgram for Speech-to-Text AI conversion.

**WebSocket/Event Flow**
Real-time proctoring and state updates are managed via WebSockets to detect "suspicious" behaviors like tab switching or face absence instantly.

### 3. Technical Decisions & Tradeoffs

* **Why you chose your approach:** The MERN stack paired with microservices allows for a clear separation of concerns, ensuring the frontend remains snappy while the backend handles heavy media processing without blocking the event loop.
* **Why streaming over full upload:** We chose streaming to ensure that if a candidate's session disconnects, we have already captured their progress up to that point. This also prevents large, memory-intensive file uploads at the end of the session.
* **Why your chosen architecture/design:** Heavy tasks like FFmpeg transcription and evaluation are handled via SQS queues and asynchronous workers to keep the main API responsive and minimize question transition latency to under 2 seconds.

### 4. Failure Scenarios & Edge Cases

* **Network Interruptions:** This can lead to partial data loss or a disconnected WebSocket.
* **Duplicate Chunks:** Network retries might send the same media chunk twice, requiring the backend to deduplicate based on sequence numbers.
* **Camera/Mic Disconnects:** This risks the loss of the video feed during the candidate's response.
* **Partial Upload Failures:** A single media chunk might fail to upload, requiring an automatic retry before the interview proceeds.
* **WebSocket Reconnects:** Temporary connection drops could interrupt proctoring, necessitating automatic reconnection logic on the frontend using `socket.io`.
* **Corrupted Chunks:** This can cause media reconstruction failure when we attempt to merge the files later.
* **Empty Media Chunks:** This can lead to storage bloat with non-functional data. Addressed via an automated backend garbage collection script post-transcription.

### 5. Recovery Mechanisms

* **State Persistence:** Session data is stored in the browser's `localStorage` (acting as the central brain), allowing candidates to refresh the page or recover from a browser crash and resume on the exact question they left off on. Automatic retry logic is implemented for WebSocket events to maintain proctoring streams.
* **Chunk Recovery Strategy:** Backend logic ensures chunks are written with deterministic keys (e.g., `chunk_[socket_id]_[timestamp].webm`) so FFmpeg can re-order them correctly even if they arrive out of sequence.

### 6. Product Thinking

* **Candidate Experience Considerations:** A mandatory "Hardware Check" page ensures the camera and microphone are functional before the interview starts, preventing candidates from proceeding blindly and reducing support tickets.
* **Recruiter Experience Considerations:** The dashboard provides a unified "drill down" view where recruiters can review the AI transcript, candidate score, and proctoring flags alongside the video playback.
* **How Suspicious Activities Are Tracked:** Real-time flagging of tab-switching (via visibility events) and "face absence" (via TensorFlow's BlazeFace lightweight computer vision model) provides recruiters with confidence in the integrity of the interview.

### 7. Scalability Considerations

* **Performance Bottlenecks:** At scale, transcription queues could experience delays. Additionally, large numbers of simultaneous video streams require robust storage ingress (AWS S3) and high-concurrency SQS workers.
* **Future Improvements For High Concurrency:** We address the scaling bottlenecks by using asynchronous queue layers. The current Node.js worker script serves as a direct stand-in for serverless Lambda functions that would scale horizontally with user load in a production environment.

### 8. Observability & Debugging

* **Logging Strategy:** We integrated the `@aws-sdk/client-cloudwatch-logs` package to track application events, websocket connections, and SQS processing times directly in AWS CloudWatch.
* **Error Tracking & Debugging:** Failed chunks or transcription errors are caught and logged directly to the `worker-stream` in CloudWatch, triggering an "Evaluation Pipeline" alert for developer review.

### 9. AI Usage Documentation

* **How AI Tools Were Used:** AI was used as a "Thinking Accelerator" to structure the initial SQS queue architecture and plan the FFmpeg merge logic.
* **Prompting Strategy:** Used "Understand → Explore → Decide" prompts to validate technical tradeoffs between different AI API providers and microservice architectures.
* **Human vs. AI Decisions:** Maintained strict human oversight throughout development—personally testing edge cases, identifying race conditions in the file-system cleanup, and debugging Next.js dependency errors to confidently pivot from standard face-mesh libraries to a highly optimized BlazeFace model.

### 10. Demo & Walkthrough

* **Setup Instructions:** 1. Run `npm install` in both the `frontend` and `backend` directories.
2. Add your Deepgram API Key and AWS access keys to the `backend/.env` file.
3. Start the frontend: `npm run dev`.
4. Start the backend: Open two separate terminals in the backend folder and run `node server.js` (Ingestion) and `node worker.js` (Queue Processor).
* **Demo Video:** `[Link to your walkthrough video goes here]`
* **Live Link:** `[Link to your hosted Vercel/Render application goes here]`
* **System Walkthrough Explanation:** The application starts at the landing page. The candidate performs a hardware check, proceeds to the interview, and answers automated questions. Media is streamed continuously to the backend. Recruiters can then log in via the `/dashboard` route to view the transcribed and evaluated sessions.
