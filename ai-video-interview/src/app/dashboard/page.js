"use client";

import { useState, useEffect } from 'react';

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5000';

export default function RecruiterDashboard() {
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [activeTab, setActiveTab] = useState('transcript');
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Poll sessions list every 5 seconds so new completions appear automatically
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/sessions`);
        if (res.ok) setSessions(await res.json());
      } catch (err) {
        console.error('Could not fetch sessions:', err);
      } finally {
        setLoadingSessions(false);
      }
    };
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch full session detail when candidate is selected
  // Also re-polls every 3 seconds if still Processing
  useEffect(() => {
    if (!selectedSession) return;

    const fetchDetail = async () => {
      setLoadingDetail(true);
      try {
        const res = await fetch(`${BACKEND_URL}/api/session/${selectedSession}`);
        if (res.ok) setSessionData(await res.json());
      } catch (err) {
        console.error('Could not fetch session detail:', err);
      } finally {
        setLoadingDetail(false);
      }
    };

    fetchDetail();
    const interval = setInterval(() => {
      if (sessionData?.status !== 'Completed') fetchDetail();
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedSession]);


  const deleteSession = async (sessionId, candidateName) => {
    if (!confirm(`Delete interview for ${candidateName}? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/session/${sessionId}`, { method: 'DELETE' });
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.sessionId !== sessionId));
        if (selectedSession === sessionId) { setSelectedSession(null); setSessionData(null); }
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  const scoreColor = (score) => {
    if (score == null) return 'text-gray-500';
    if (score >= 80) return 'text-emerald-400';
    if (score >= 60) return 'text-yellow-400';
    return 'text-red-400';
  };

  const statusBadge = (status) => {
    if (status === 'Completed') return 'bg-emerald-900 text-emerald-400';
    if (status === 'Processing') return 'bg-yellow-900 text-yellow-400 animate-pulse';
    return 'bg-gray-700 text-gray-400';
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 font-sans flex">

      {/* SIDEBAR */}
      <aside className="w-72 bg-gray-800 border-r border-gray-700 flex flex-col shrink-0">
        <div className="p-5 border-b border-gray-700">
          <h1 className="text-lg font-bold text-emerald-400">Recruiter Dashboard</h1>
          <p className="text-xs text-gray-500 mt-1">
            {loadingSessions ? 'Loading...' : `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {!loadingSessions && sessions.length === 0 && (
            <p className="text-gray-600 text-sm text-center mt-8 px-4">No completed interviews yet. Run an interview to see it here.</p>
          )}
          {sessions.map((s) => (
            <div key={s.sessionId} className="relative group">
              <button
                onClick={() => { setSelectedSession(s.sessionId); setSessionData(null); setActiveTab('transcript'); }}
                className={`w-full text-left p-3 rounded-lg border transition-all ${
                  selectedSession === s.sessionId
                    ? 'bg-indigo-950 border-indigo-600 text-indigo-300'
                    : 'bg-gray-900 border-gray-700 text-gray-300 hover:border-gray-500 hover:text-white'
                }`}
              >
                <div className="flex justify-between items-start gap-2 pr-5">
                  <span className="font-semibold text-sm truncate">{s.candidateName}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded font-bold shrink-0 ${statusBadge(s.status)}`}>{s.status}</span>
                </div>
                <div className="flex justify-between items-center mt-1">
                  <span className="text-xs text-gray-500">{new Date(s.completedAt).toLocaleString()}</span>
                  {s.proctoringFlagCount > 0 && (
                    <span className="text-xs text-red-400">🚨 {s.proctoringFlagCount} flag{s.proctoringFlagCount !== 1 ? 's' : ''}</span>
                  )}
                </div>
              </button>
              <button
                onClick={() => deleteSession(s.sessionId, s.candidateName)}
                className="absolute top-2 right-2 text-gray-600 hover:text-red-400 transition-colors text-xs p-1 rounded hover:bg-red-950/40 opacity-0 group-hover:opacity-100"
                title="Delete interview"
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* MAIN */}
      <main className="flex-1 overflow-y-auto p-8">
        {!selectedSession ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-600">
            <span className="text-5xl mb-4">👈</span>
            <p className="text-lg font-semibold">Select a candidate to review</p>
          </div>
        ) : loadingDetail && !sessionData ? (
          <div className="flex items-center justify-center h-64 text-gray-500 animate-pulse">Loading session...</div>
        ) : sessionData ? (
          <>
            {/* Header */}
            <header className="mb-6 flex justify-between items-start flex-wrap gap-4">
              <div>
                <h2 className="text-2xl font-bold text-white">{sessionData.candidateName}</h2>
                <p className="text-gray-500 text-xs mt-1 font-mono">{selectedSession}</p>
                <p className="text-gray-500 text-xs mt-0.5">Completed: {new Date(sessionData.completedAt).toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3">
                {sessionData.score != null && (
                  <span className={`text-3xl font-bold ${scoreColor(sessionData.score)}`}>{sessionData.score}/100</span>
                )}
                <span className={`text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide ${statusBadge(sessionData.status)}`}>
                  {sessionData.status}
                </span>
                <button
                  onClick={() => deleteSession(selectedSession, sessionData.candidateName)}
                  className="bg-red-950 hover:bg-red-900 border border-red-800 text-red-400 text-xs px-3 py-1.5 rounded-lg font-semibold transition-all"
                >
                  🗑️ Delete Interview
                </button>
              </div>
            </header>

            {sessionData.status === 'Processing' && (
              <div className="mb-6 px-4 py-3 bg-yellow-950 border border-yellow-800 text-yellow-300 rounded-lg text-sm animate-pulse">
                ⏳ Interview is being processed — FFmpeg merging chunks and Deepgram transcribing audio. This page will update automatically.
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

              {/* LEFT: Video + Proctoring */}
              <div className="lg:col-span-2 flex flex-col gap-6">

                {/* Video Playback */}
                <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                  <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Interview Playback</h3>
                  <div className="w-full bg-gray-950 rounded-lg overflow-hidden border border-gray-700" style={{minHeight: '300px'}}>
                    {sessionData.videoUrl ? (
                      <video src={sessionData.videoUrl} controls className="w-full rounded-lg" style={{maxHeight: '400px'}} />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-72 text-gray-600 text-sm">
                        <span className="text-4xl mb-2">▶️</span>
                        <p>{sessionData.status === 'Processing' ? 'Video will appear after processing completes' : 'Video stored in AWS S3'}</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Proctoring Report */}
                <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
                  <h3 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                    🚨 Proctoring Report
                    <span className="bg-red-950 text-red-400 text-xs px-2 py-0.5 rounded-full">
                      {sessionData.proctoringFlags?.length ?? 0} flag{(sessionData.proctoringFlags?.length ?? 0) !== 1 ? 's' : ''}
                    </span>
                  </h3>
                  {!sessionData.proctoringFlags?.length ? (
                    <p className="text-emerald-500 text-sm">✅ No suspicious activity detected.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {sessionData.proctoringFlags.map((flag, i) => (
                        <div key={i} className="bg-red-950/30 border border-red-900/50 px-4 py-2 rounded-lg font-mono text-sm text-red-300">
                          [{flag.time}] — {flag.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* RIGHT: Transcript + Resume */}
              <div className="bg-gray-800 rounded-xl border border-gray-700 flex flex-col overflow-hidden">
                <div className="flex bg-gray-900 border-b border-gray-700">
                  {['transcript', 'resume'].map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      className={`flex-1 py-3 text-sm font-semibold capitalize transition-colors ${activeTab === tab ? 'text-indigo-400 border-b-2 border-indigo-400' : 'text-gray-500 hover:text-gray-300'}`}>
                      {tab === 'transcript' ? 'AI Transcript' : 'Resume'}
                    </button>
                  ))}
                </div>
                <div className="p-5 flex-1 overflow-y-auto">
                  {activeTab === 'transcript' ? (
                    <div>
                      <p className="text-xs uppercase tracking-wider text-gray-600 font-bold mb-4">Deepgram nova-2 Output</p>
                      {sessionData.transcript ? (
                        <p className="text-gray-300 leading-relaxed text-sm whitespace-pre-wrap">{sessionData.transcript}</p>
                      ) : (
                        <p className="text-gray-600 text-sm italic">{sessionData.status === 'Processing' ? 'Transcription in progress...' : 'No transcript available.'}</p>
                      )}
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-gray-600 text-sm">
                      <span className="text-4xl mb-3">📄</span>
                      <p className="font-medium">Resume upload not implemented</p>
                      <p className="text-xs mt-2 text-center text-gray-700 px-4">The task spec marks this as a future feature — a presigned S3 URL PDF viewer would go here.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}