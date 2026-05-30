"use client";

import '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-webgl';
import * as blazeface from '@tensorflow-models/blazeface';

import { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5000';

const questions = [
  "Tell me about yourself?",
  "Why do you want to work with our team?",
  "Explain the difference between asynchronous processing and synchronous processing in software development."
];

export default function Home() {
  const [view, setView] = useState('landing');
  const [candidateName, setCandidateName] = useState('');
  const [nameError, setNameError] = useState('');
  const [stream, setStream] = useState(null);
  const [error, setError] = useState('');
  const [chunksCaptured, setChunksCaptured] = useState(0);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [suspiciousActivityLogs, setSuspiciousActivityLogs] = useState([]);
  const [socketConnected, setSocketConnected] = useState(false);

  const videoRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const socketRef = useRef(null);
  const chunkSequenceRef = useRef(0);
  const streamRef = useRef(null);
  const proctoringLogsRef = useRef([]); // ref so we can read latest in cleanup

  // Keep refs in sync
  useEffect(() => { streamRef.current = stream; }, [stream]);
  useEffect(() => { proctoringLogsRef.current = suspiciousActivityLogs; }, [suspiciousActivityLogs]);

  // 🧠 RECOVERY: Restore question index on page load
  useEffect(() => {
    const savedIndex = localStorage.getItem('interview_question_index');
    const savedName = localStorage.getItem('interview_candidate_name');
    if (savedIndex !== null) setCurrentQuestionIndex(parseInt(savedIndex, 10));
    if (savedName) setCandidateName(savedName);
  }, []);

  useEffect(() => {
    if (view !== 'completed') {
      localStorage.setItem('interview_question_index', currentQuestionIndex.toString());
    }
  }, [currentQuestionIndex, view]);

  // 🔌 WebSocket with auto-reconnect
  useEffect(() => {
    const socket = io(BACKEND_URL, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on('reconnect', () => setSocketConnected(true));
    return () => socket.disconnect();
  }, []);

  // 🕵️ BlazeFace: face absence detection
  useEffect(() => {
    if (view !== 'interview') return;
    let cancelled = false;
    let animationFrameId;
    let lastAlertTime = 0;

    const run = async () => {
      try {
        const model = await blazeface.load();
        const detect = async () => {
          if (cancelled) return;
          if (videoRef.current && videoRef.current.readyState === 4) {
            const predictions = await model.estimateFaces(videoRef.current, false);
            if (predictions.length === 0) {
              const now = Date.now();
              if (now - lastAlertTime > 3000) {
                const alertMsg = `Face not detected at ${new Date().toLocaleTimeString()}`;
                socketRef.current?.emit('proctoring-alert', { message: alertMsg, sessionId: socketRef.current.id });
                setSuspiciousActivityLogs(prev => [...prev, alertMsg]);
                lastAlertTime = now;
              }
            }
          }
          animationFrameId = requestAnimationFrame(detect);
        };
        detect();
      } catch (err) {
        console.error("BlazeFace failed:", err);
      }
    };
    run();
    return () => { cancelled = true; if (animationFrameId) cancelAnimationFrame(animationFrameId); };
  }, [view]);

  // 🕵️ Tab-switch detection
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && view === 'interview') {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'square'; osc.frequency.value = 400;
          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          osc.connect(gain); gain.connect(ctx.destination);
          osc.start(); setTimeout(() => osc.stop(), 400);
        } catch (_) {}
        const alertMsg = `Tab switched at ${new Date().toLocaleTimeString()}`;
        setSuspiciousActivityLogs(prev => [...prev, alertMsg]);
        socketRef.current?.emit('proctoring-alert', { message: alertMsg, sessionId: socketRef.current?.id });
        setTimeout(() => alert("⚠️ WARNING: Tab switching is tracked and has been logged."), 100);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [view]);

  const startHardwareCheck = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setStream(mediaStream);
      if (videoRef.current) videoRef.current.srcObject = mediaStream;
      setError('');
    } catch {
      setError('Please allow camera and microphone access to proceed.');
    }
  };

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) { s.getTracks().forEach(t => t.stop()); setStream(null); if (videoRef.current) videoRef.current.srcObject = null; }
  }, []);

  const handleProceedToHardwareCheck = () => {
    const name = candidateName.trim();
    if (!name) { setNameError('Please enter your full name to continue.'); return; }
    setNameError('');
    localStorage.setItem('interview_candidate_name', name);
    setView('hardware-check');
  };

  const proceedToInterview = () => setView('interview');

  // Attach stream when entering interview view
  useEffect(() => {
    if (view === 'interview') {
      const s = streamRef.current;
      if (s && videoRef.current) videoRef.current.srcObject = s;
      if (s) startStreamingChunks(s);
    }
  }, [view]);

  const startStreamingChunks = (mediaStream) => {
    if (!mediaStream) return;
    chunkSequenceRef.current = 0;
    const recorder = new MediaRecorder(mediaStream, { mimeType: 'video/webm' });
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = async (event) => {
      if (event.data && event.data.size > 0) {
        const seq = chunkSequenceRef.current++;
        setChunksCaptured(prev => prev + 1);
        if (socketRef.current?.connected) {
          const arrayBuffer = await event.data.arrayBuffer();
          socketRef.current.emit('video-chunk', { data: arrayBuffer, sequence: seq });
        }
      }
    };
    recorder.start(3000);
  };

  const nextQuestion = async () => {
    if (currentQuestionIndex < questions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    } else {
      if (mediaRecorderRef.current?.state !== "inactive") mediaRecorderRef.current.stop();
      const sessionId = socketRef.current?.id;
      const finalLogs = proctoringLogsRef.current;
      stopStream();
      localStorage.clear();
      setCurrentQuestionIndex(0);
      setView('completed');

      try {
        await fetch(`${BACKEND_URL}/api/process-interview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            candidateName: candidateName.trim(),
            proctoringFlags: finalLogs.map(msg => ({
              time: new Date().toLocaleTimeString(),
              message: msg,
            })),
          }),
        });
      } catch (err) {
        console.error("🔴 Failed to trigger processing:", err);
      }
    }
  };

  // ─── VIEWS ───────────────────────────────────────────────────────────────

  if (view === 'landing') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-md w-full bg-gray-800 rounded-xl p-8 shadow-2xl border border-gray-700">
          <h1 className="text-3xl font-bold text-indigo-400 mb-2">AI Video Interview</h1>
          <p className="text-gray-400 mb-8 text-sm">Please enter your full name before proceeding to the hardware check.</p>
          <label className="block text-sm font-medium text-gray-300 mb-2">Full Name</label>
          <input
            type="text"
            value={candidateName}
            onChange={(e) => setCandidateName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleProceedToHardwareCheck()}
            placeholder="e.g. Alex Johnson"
            className="w-full bg-gray-900 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-2"
          />
          {nameError && <p className="text-red-400 text-sm mb-3">{nameError}</p>}
          <button
            onClick={handleProceedToHardwareCheck}
            className="w-full mt-4 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold transition-all shadow-md"
          >
            Continue to Hardware Check ➔
          </button>
        </div>
      </div>
    );
  }

  if (view === 'hardware-check') {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-6">
        <div className="max-w-xl w-full bg-gray-800 rounded-xl p-8 shadow-2xl border border-gray-700 text-center">
          <h2 className="text-3xl font-bold mb-1 text-indigo-400">Hardware Check</h2>
          <p className="text-gray-400 mb-1 text-sm">Welcome, <span className="text-white font-semibold">{candidateName}</span></p>
          <p className="text-gray-500 mb-6 text-sm">Ensure your camera and microphone are working before starting.</p>
          <div className="w-full h-72 bg-gray-950 rounded-lg overflow-hidden mb-6 border border-gray-800">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          </div>
          {error && <p className="text-red-500 font-semibold mb-4">{error}</p>}
          {!stream ? (
            <button onClick={startHardwareCheck} className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-3 rounded-lg font-semibold transition-all">
              Enable Camera &amp; Microphone
            </button>
          ) : (
            <div className="flex gap-4 justify-center">
              <button onClick={stopStream} className="bg-gray-700 hover:bg-gray-600 text-gray-200 px-5 py-2.5 rounded-lg font-medium transition-all">Turn Off Camera</button>
              <button onClick={proceedToInterview} className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg font-semibold transition-all">Proceed to Interview ➔</button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (view === 'interview') {
    return (
      <div className="min-h-screen bg-gray-900 text-white grid grid-cols-1 md:grid-cols-3 gap-6 p-6">
        <div className="md:col-span-2 flex flex-col gap-6">
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
            <span className="text-xs uppercase font-bold text-indigo-400 tracking-widest bg-indigo-950 px-2.5 py-1 rounded">
              Question {currentQuestionIndex + 1} of {questions.length}
            </span>
            <h1 className="text-xl md:text-2xl font-semibold mt-4 text-gray-100">{questions[currentQuestionIndex]}</h1>
          </div>
          <div className="bg-gray-800 rounded-xl p-4 border border-gray-700 flex flex-col gap-3">
            <div className="w-full h-96 bg-gray-950 rounded-lg overflow-hidden">
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover transform -scale-x-100" />
            </div>
            <div className="flex justify-between items-center text-sm text-gray-400 px-1">
              <div className="flex items-center gap-3">
                <span>Chunks Sent: <span className="text-indigo-400 font-bold">{chunksCaptured}</span></span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${socketConnected ? 'bg-emerald-900 text-emerald-400' : 'bg-red-900 text-red-400'}`}>
                  {socketConnected ? '● Live' : '● Reconnecting...'}
                </span>
              </div>
              <button onClick={nextQuestion} className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2 rounded-lg font-semibold transition-all">
                {currentQuestionIndex === questions.length - 1 ? "Finish Interview" : "Next Question ➔"}
              </button>
            </div>
          </div>
        </div>
        <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 flex flex-col">
          <h3 className="text-lg font-bold text-gray-200 border-b border-gray-700 pb-3 mb-4">Proctoring Logs</h3>
          <div className="flex-1 overflow-y-auto max-h-80 bg-gray-950 rounded-lg p-4 font-mono text-xs flex flex-col gap-2">
            <div className="text-emerald-500">🟢 [System]: WebSocket connection established.</div>
            {suspiciousActivityLogs.map((log, i) => (
              <div key={i} className="text-red-400 font-semibold bg-red-950/40 p-2 rounded border border-red-900/50">🚨 {log}</div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-gray-800 rounded-xl p-8 shadow-2xl border border-gray-700 text-center">
        <div className="text-5xl mb-4">🎉</div>
        <h2 className="text-3xl font-bold mb-3 text-emerald-400">Interview Completed!</h2>
        <p className="text-gray-400 text-sm mb-6">Your responses are being processed. The recruiter will be notified shortly.</p>
        <button onClick={() => { setView('landing'); setSuspiciousActivityLogs([]); localStorage.clear(); }}
          className="bg-gray-700 hover:bg-gray-600 text-white px-6 py-2.5 rounded-lg mt-2">
          Restart
        </button>
      </div>
    </div>
  );
}