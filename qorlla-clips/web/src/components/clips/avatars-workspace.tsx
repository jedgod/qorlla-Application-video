'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, Loader2, Share2, Sparkles, Trash2 } from 'lucide-react';
import { api, type AvatarDraft, type AvatarTemplate } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AvatarPicker } from './avatar-picker';
import { errorMessage, useClips } from './clips-provider';
import { Empty, ListSkeleton, PageHeader } from './page-header';

/**
 * The Avatars workspace. Drafts made here are NOT in My clips: they stay on this page until the person presses "Save to My clips".
 * Which avatars can be picked comes from the server (the plan decides), never from the role.
 */
export function AvatarsWorkspace() {
  const { say, invalidate, refreshSummary, authError, dataVersion } = useClips();
  const [templates, setTemplates] = useState<AvatarTemplate[]>([]);
  const [locked, setLocked] = useState<AvatarTemplate[]>([]);
  const [picked, setPicked] = useState<AvatarTemplate | null>(null);
  const [drafts, setDrafts] = useState<AvatarDraft[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, d] = await Promise.all([api.avatarTemplates(), api.avatarDrafts()]);
      setTemplates(t.templates); setLocked(t.locked); setDrafts(d.drafts); setError('');
      setPicked((p) => p && t.templates.some((x) => x.id === p.id) ? p : t.templates[0] ?? null);
    } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load, dataVersion]);
  // a draft waiting for the media worker turns READY by itself: look again every few seconds while any is processing
  useEffect(() => {
    if (!drafts?.some((d) => d.status === 'PROCESSING')) return;
    const t = setInterval(() => { void load(); }, 8000);
    return () => clearInterval(t);
  }, [drafts, load]);

  async function create() {
    if (!picked || creating) return;
    setCreating(true);
    try { await api.createAvatarDraft({ avatarId: picked.id }); say('Draft created here in Avatars. It is not in My clips yet.'); await load(); }
    catch (e) { say(errorMessage(e), 'err'); }
    finally { setCreating(false); }
  }

  async function promote(d: AvatarDraft) {
    if (busyId) return;
    setBusyId(d.id);
    try {
      await api.promoteAvatarDraft(d.id);
      setDrafts((prev) => prev && prev.map((x) => x.id === d.id ? { ...x, isPromoted: true } : x));
      say('Saved to My clips.'); invalidate(); void refreshSummary();
    } catch (e) { say(errorMessage(e), 'err'); void load(); }
    finally { setBusyId(null); }
  }

  async function discard(d: AvatarDraft) {
    if (busyId) return;
    setBusyId(d.id);
    try { await api.deleteAvatarDraft(d.id); setDrafts((prev) => prev && prev.filter((x) => x.id !== d.id)); }
    catch (e) { say(errorMessage(e), 'err'); void load(); }
    finally { setBusyId(null); }
  }

  return (
    <>
      <PageHeader title="Avatars" hideCreate />
      <p className="mt-3 text-xs text-gray-500">Make avatar clips here. They stay in this workspace and appear in <Link href="/dashboard/my-clips" className="font-medium text-blue-600 hover:underline">My clips</Link> only when you save them.</p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <AvatarPicker templates={templates} locked={locked} value={picked} onChange={setPicked} />
        <Button onClick={create} disabled={!picked || creating} data-testid="avatar-create">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}Create draft
        </Button>
      </div>

      {authError ? <p className="mt-6 text-sm text-red-600">{authError}</p> : error ? <p role="alert" className="mt-6 text-sm text-red-600">{error}</p> : drafts === null ? <ListSkeleton /> : drafts.length === 0 ? (
        <Empty text="No avatar drafts yet" sub="Pick a presenter and choose Create draft." icon={<Sparkles className="h-5 w-5" aria-hidden="true" />} />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" data-testid="avatar-drafts">
          {drafts.map((d) => (
            <div key={d.id} className="flex flex-col justify-between gap-4 rounded-2xl border border-gray-200/80 bg-white p-4 shadow-sm" data-testid="avatar-draft">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white"><Sparkles className="h-4 w-4 text-blue-400" aria-hidden="true" /></div>
                <div className="min-w-0">
                  <h4 className="truncate text-xs font-bold text-gray-900">{d.title}</h4>
                  <p className="mt-0.5 truncate text-[11px] text-gray-500">{d.avatar?.name}</p>
                  <span className={cn('mt-1 inline-block rounded px-1.5 text-[10px] font-bold uppercase',
                    d.status === 'READY' ? 'bg-green-50 text-green-600' : d.status === 'FAILED' ? 'bg-red-50 text-red-600' : 'animate-pulse bg-amber-50 text-amber-600')}>{d.status.toLowerCase()}</span>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-gray-50 pt-3">
                <span className="text-[10px] font-medium text-gray-400">{new Date(d.createdAt).toLocaleDateString()}</span>
                {d.isPromoted ? (
                  <span className="flex items-center gap-1 text-[11px] font-bold text-green-600"><CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />Saved to My clips</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Button variant="ghost" size="icon" aria-label={`Discard ${d.title}`} disabled={busyId !== null} onClick={() => discard(d)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                    <Button size="sm" disabled={d.status !== 'READY' || busyId !== null} onClick={() => promote(d)} data-testid="avatar-promote">
                      {busyId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Share2 className="h-3.5 w-3.5" aria-hidden="true" />}Save to My clips
                    </Button>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
