'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { uploadRecording, type UploadHandle, type UploadPhase } from '@/lib/upload';
import { formatBytes } from '@/hooks/use-camera-recorder';
import { useClips, errorMessage } from '@/components/clips/clips-provider';

export interface UploadJob {
  id: string; filename: string; sizeLabel: string; percent: number; phase: UploadPhase; error?: string; clipId?: string;
}

interface UploadsContext {
  jobs: UploadJob[];
  startUpload: (blob: Blob, meta: { title: string; durationMs?: number; source?: 'RECORDING' | 'UPLOAD' }) => string;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const Ctx = createContext<UploadsContext | null>(null);
export function useUploads(): UploadsContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useUploads must be used inside <UploadsProvider>');
  return c;
}

interface Held { blob: Blob; title: string; durationMs?: number; source?: 'RECORDING' | 'UPLOAD'; handle?: UploadHandle; controller?: AbortController }

/** Owns every upload in flight. The recording stays in memory until its upload succeeds or is dismissed, so a failed upload can be retried and resumed. */
export function UploadsProvider({ children }: { children: React.ReactNode }) {
  const { invalidate, say } = useClips();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const held = useRef(new Map<string, Held>());

  const patch = useCallback((id: string, p: Partial<UploadJob>) => setJobs((all) => all.map((j) => (j.id === id ? { ...j, ...p } : j))), []);

  const run = useCallback(async (id: string) => {
    const h = held.current.get(id); if (!h) return;
    const controller = new AbortController(); h.controller = controller;
    patch(id, { phase: 'INITIALIZING', error: undefined });
    try {
      await uploadRecording(h.blob, {
        title: h.title, durationMs: h.durationMs, source: h.source, resume: h.handle, signal: controller.signal,
        onPhase: (phase, handle) => { if (handle) { h.handle = handle; patch(id, { phase, clipId: handle.clipId }); } else patch(id, { phase }); },
        onProgress: (percent) => patch(id, { percent }),
      });
      held.current.delete(id);                                   // success: free the recording
      invalidate(); say('Recording saved to your library.');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') { held.current.delete(id); patch(id, { phase: 'CANCELED', error: undefined }); invalidate(); return; }
      patch(id, { phase: 'FAILED', error: errorMessage(e) });
    }
  }, [invalidate, patch, say]);

  const startUpload = useCallback((blob: Blob, meta: { title: string; durationMs?: number; source?: 'RECORDING' | 'UPLOAD' }) => {
    const id = crypto.randomUUID();
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    held.current.set(id, { blob, title: meta.title, durationMs: meta.durationMs, source: meta.source });
    setJobs((all) => [...all, { id, filename: `${meta.title}.${ext}`, sizeLabel: formatBytes(blob.size), percent: 0, phase: 'INITIALIZING' }]);
    void run(id);
    return id;
  }, [run]);

  const cancel = useCallback((id: string) => { held.current.get(id)?.controller?.abort(); }, []);
  const retry = useCallback((id: string) => { patch(id, { percent: 0 }); void run(id); }, [patch, run]);
  const dismiss = useCallback((id: string) => { held.current.get(id)?.controller?.abort(); held.current.delete(id); setJobs((all) => all.filter((j) => j.id !== id)); }, []);
  const dismissAll = useCallback(() => { for (const h of held.current.values()) h.controller?.abort(); held.current.clear(); setJobs([]); }, []);

  // Leaving the page would lose a recording that is still uploading (or waiting to be retried): ask first.
  const active = jobs.some((j) => ['INITIALIZING', 'UPLOADING', 'ASSEMBLING', 'FAILED'].includes(j.phase));
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  const value = useMemo(() => ({ jobs, startUpload, cancel, retry, dismiss, dismissAll }), [jobs, startUpload, cancel, retry, dismiss, dismissAll]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
