'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type RecorderState = 'idle' | 'requesting' | 'ready' | 'recording' | 'recorded' | 'error';
export interface Recording { blob: Blob; url: string; mimeType: string; durationMs: number }

// Best first. Safari records MP4 only, Chromium and Firefox record WebM.
const CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t));
}

function describe(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera and microphone access was blocked. Allow it in your browser\'s site settings and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera or microphone was found.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Your camera or microphone is being used by another application.';
  return 'The camera could not be started.';
}

/**
 * Records the camera + microphone straight from the media stream (no canvas, so nothing is burned into the video).
 * Chunks are kept in a ref, not state, so recording does not re-render the page. The camera is switched off as soon as recording
 * stops or the component goes away.
 */
export function useCameraRecorder({ maxMs = 10 * 60 * 1000 }: { maxMs?: number } = {}) {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const urlRef = useRef<string | null>(null);
  const generation = useRef(0);                         // ignores answers from a request that was superseded or cancelled

  const stopTimer = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  const releaseCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null; setStream(null);
  }, []);
  const dropRecording = useCallback(() => {
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    setRecording(null);
  }, []);

  const openCamera = useCallback(async () => {
    const my = ++generation.current;
    setError(null); dropRecording(); setElapsedMs(0);
    if (typeof window !== 'undefined' && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)) {
      setError('Recording needs a secure connection (https) and a browser with camera support.'); setState('error'); return;
    }
    if (!pickMimeType()) { setError('This browser cannot record video. Try a current version of Chrome, Edge, Firefox or Safari.'); setState('error'); return; }
    setState('requesting');
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (my !== generation.current) { s.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = s; setStream(s); setState('ready');
    } catch (e) {
      if (my !== generation.current) return;
      setError(describe(e)); setState('error');
    }
  }, [dropRecording]);

  const stop = useCallback(() => {
    const r = recorderRef.current;
    if (r && r.state !== 'inactive') r.stop();
  }, []);

  const start = useCallback(() => {
    const s = streamRef.current; const mime = pickMimeType();
    if (!s || !mime) return;
    dropRecording(); chunksRef.current = []; setElapsedMs(0);
    const recorder = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
    recorder.onerror = () => { stopTimer(); setError('Recording stopped unexpectedly.'); setState('error'); releaseCamera(); };
    recorder.onstop = () => {
      stopTimer();
      const type = (recorder.mimeType || mime).split(';')[0];
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      const durationMs = Date.now() - startedAt.current;
      if (blob.size === 0) { setError('Nothing was recorded. Try again.'); setState('error'); releaseCamera(); return; }
      const url = URL.createObjectURL(blob); urlRef.current = url;
      setRecording({ blob, url, mimeType: type, durationMs }); setElapsedMs(durationMs);
      setState('recorded'); releaseCamera();
    };
    recorderRef.current = recorder;
    startedAt.current = Date.now();
    recorder.start(1000);                                // a slice every second keeps memory use steady and survives a crash better
    setState('recording');
    timer.current = setInterval(() => {
      const e = Date.now() - startedAt.current; setElapsedMs(e);
      if (e >= maxMs) stop();
    }, 250);
  }, [dropRecording, maxMs, releaseCamera, stop]);

  /** Back to the start: discards any recording and switches the camera off. */
  const reset = useCallback(() => {
    generation.current++;
    stopTimer();
    const r = recorderRef.current;
    if (r) { r.ondataavailable = null; r.onstop = null; r.onerror = null; if (r.state !== 'inactive') { try { r.stop(); } catch { /* already stopped */ } } recorderRef.current = null; }
    chunksRef.current = []; releaseCamera(); dropRecording(); setElapsedMs(0); setError(null); setState('idle');
  }, [dropRecording, releaseCamera]);

  useEffect(() => () => { generation.current++; stopTimer(); recorderRef.current?.stop?.call(recorderRef.current); streamRef.current?.getTracks().forEach((t) => t.stop()); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  return { state, error, elapsedMs, maxMs, stream, recording, openCamera, start, stop, reset, discard: dropRecording };
}

export function formatClock(ms: number): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
/** 0 -> "0 B", 1536 -> "1.5 KB", 14.4 MB -> "14.4 MB". One decimal at most, trailing ".0" dropped; a value that rounds up to the next unit moves to it. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  let unit = 0, value = n;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  let rounded = Math.round(value * 10) / 10;
  if (rounded >= 1024 && unit < UNITS.length - 1) { rounded = Math.round((rounded / 1024) * 10) / 10; unit++; }   // 1023.96 KB -> 1 MB, not "1024 KB"
  return `${unit === 0 ? Math.round(value) : rounded} ${UNITS[unit]}`;
}
