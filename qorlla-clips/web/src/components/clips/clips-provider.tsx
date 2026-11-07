'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Me, type Summary } from '@/lib/api';

interface Toast { text: string; kind: 'ok' | 'err' }

interface ClipsContext {
  me: Me | null;
  summary: Summary | null;
  /** set when the user is not signed in; pages show it instead of an empty list */
  authError: string;
  refreshSummary: () => Promise<void>;
  /** bumped whenever something changed that every open list should re-fetch (a clip was created, an upload finished) */
  dataVersion: number;
  invalidate: () => void;
  toast: Toast | null;
  say: (text: string, kind?: 'ok' | 'err') => void;
  recorderOpen: boolean;
  openRecorder: () => void;
  closeRecorder: () => void;
}

const Ctx = createContext<ClipsContext | null>(null);

export function useClips(): ClipsContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('useClips must be used inside <ClipsProvider>');
  return c;
}

export function errorMessage(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.';
}

export function ClipsProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [authError, setAuthError] = useState('');
  const [dataVersion, setDataVersion] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  const refreshSummary = useCallback(async () => {
    try { setSummary(await api.summary()); setAuthError(''); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setAuthError('Sign in to Qorlla to use Clips.'); }
  }, []);

  useEffect(() => {
    api.me().then(setMe).catch((e) => { if (e instanceof ApiError && e.status === 401) setAuthError('Sign in to Qorlla to use Clips.'); });
    refreshSummary();
  }, [refreshSummary]);

  const invalidate = useCallback(() => { setDataVersion((v) => v + 1); refreshSummary(); }, [refreshSummary]);

  const value = useMemo<ClipsContext>(() => ({
    me, summary, authError, refreshSummary, dataVersion, invalidate, toast, say,
    recorderOpen, openRecorder: () => setRecorderOpen(true), closeRecorder: () => setRecorderOpen(false),
  }), [me, summary, authError, refreshSummary, dataVersion, invalidate, toast, say, recorderOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
