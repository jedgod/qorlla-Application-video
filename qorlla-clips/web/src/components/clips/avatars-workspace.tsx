'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, Info, Loader2, Play, Share2, Sparkles, Trash2 } from 'lucide-react';
import { api, type AvatarDraft, type AvatarRendering, type AvatarTemplate } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AvatarPicker } from './avatar-picker';
import { errorMessage, useClips } from './clips-provider';
import { Empty, ListSkeleton, PageHeader } from './page-header';

const SCRIPT_MAX = 1000;

/**
 * The Avatars workspace. Drafts made here are NOT in My clips: they stay on this page until the person presses "Save to My clips".
 * Which avatars can be picked comes from the server (the plan decides), never from the role. What a finished draft IS (a placeholder
 * title card, or nothing at all) also comes from the server, and the notice below says so plainly.
 */
export function AvatarsWorkspace() {
  const { say, invalidate, refreshSummary, authError, dataVersion } = useClips();
  const [templates, setTemplates] = useState<AvatarTemplate[]>([]);
  const [locked, setLocked] = useState<AvatarTemplate[]>([]);
  const [rendering, setRendering] = useState<AvatarRendering | null>(null);
  const [picked, setPicked] = useState<AvatarTemplate | null>(null);
  const [script, setScript] = useState('');
  const [drafts, setDrafts] = useState<AvatarDraft[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, d] = await Promise.all([api.avatarTemplates(), api.avatarDrafts()]);
      setTemplates(t.templates); setLocked(t.locked); setRendering(t.rendering); setDrafts(d.drafts); setError('');
      setPicked((p) => p && t.templates.some((x) => x.id === p.id) ? p : t.templates[0] ?? null);
    } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load, dataVersion]);
  // while the media worker is rendering, look again every few seconds: the draft turns READY by itself
  useEffect(() => {
    if (!rendering?.enabled || !drafts?.some((d) => d.status === 'PROCESSING')) return;
    const t = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(t);
  }, [rendering, drafts, load]);

  async function create() {
    if (!picked || creating) return;
    setCreating(true);
    try {
      await api.createAvatarDraft({ avatarId: picked.id, ...(script.trim() ? { script: script.trim() } : {}) });
      setScript('');
      say(rendering?.enabled ? 'Draft created. It is being rendered here in Avatars; it is not in My clips yet.' : 'Draft created here in Avatars. It is not in My clips yet.');
      await load();
    } catch (e) { say(errorMessage(e), 'err'); }
    finally { setCreating(false); }
  }

  async function promote(d: AvatarDraft) {
    if (busyId) return;
    setBusyId(d.id);
    try {
      await api.promoteAvatarDraft(d.id);
      setDrafts((prev) => prev && prev.map((x) => x.id === d.id ? { ...x, isPromoted: true } : x));
      if (preview?.id === d.id) setPreview(null);
      say('Saved to My clips.'); invalidate(); void refreshSummary();
    } catch (e) { say(errorMessage(e), 'err'); void load(); }
    finally { setBusyId(null); }
  }

  async function discard(d: AvatarDraft) {
    if (busyId) return;
    setBusyId(d.id);
    try { await api.deleteAvatarDraft(d.id); setDrafts((prev) => prev && prev.filter((x) => x.id !== d.id)); if (preview?.id === d.id) setPreview(null); }
    catch (e) { say(errorMessage(e), 'err'); void load(); }
    finally { setBusyId(null); }
  }

  async function togglePreview(d: AvatarDraft) {
    if (preview?.id === d.id) { setPreview(null); return; }
    try { const p = await api.avatarDraftPlayback(d.id); setPreview({ id: d.id, url: p.url }); }
    catch (e) { say(errorMessage(e), 'err'); }
  }

  const badge = (d: AvatarDraft) => d.status === 'PROCESSING'
    ? (rendering?.enabled ? { text: 'Rendering…', cls: 'animate-pulse bg-amber-50 text-amber-600' } : { text: 'Rendering unavailable', cls: 'bg-gray-100 text-gray-500' })
    : d.status === 'READY' ? { text: rendering?.kind === 'placeholder' ? 'Ready (placeholder)' : 'Ready', cls: 'bg-green-50 text-green-600' }
    : { text: 'Failed', cls: 'bg-red-50 text-red-600' };

  return (
    <>
      <PageHeader title="Avatars" hideCreate />
      <p className="mt-3 text-xs text-gray-500">Make avatar clips here. They stay in this workspace and appear in <Link href="/dashboard/my-clips" className="font-medium text-blue-600 hover:underline">My clips</Link> only when you save them.</p>

      {rendering === null ? null : rendering.enabled ? (
        <div role="note" className="mt-4 flex max-w-2xl items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/40 p-4" data-testid="avatar-renderer-notice">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-blue-900"><strong className="font-bold">Preview rendering.</strong> Drafts are rendered into a short placeholder video: a title card with the presenter&apos;s name, your title and the start of your script. It is not a talking presenter yet. You can preview it and save it to My clips.</p>
        </div>
      ) : (
        <div role="note" className="mt-4 flex max-w-2xl items-start gap-3 rounded-xl border border-amber-100 bg-amber-50/40 p-4" data-testid="avatar-renderer-notice">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <p className="text-xs leading-relaxed text-amber-800"><strong className="font-bold">Avatar rendering isn&apos;t available yet.</strong> You can create drafts and choose a presenter, but a draft can&apos;t be saved to My clips until rendering is switched on.</p>
        </div>
      )}

      <div className="mt-4 flex max-w-2xl flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <AvatarPicker templates={templates} locked={locked} value={picked} onChange={setPicked} />
          <Button onClick={create} disabled={!picked || creating} data-testid="avatar-create">
            {creating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}Create draft
          </Button>
        </div>
        <label className="block">
          <span className="mb-1 block px-0.5 text-[10.5px] font-bold uppercase tracking-wider text-gray-400">Script (optional)</span>
          <textarea value={script} onChange={(e) => setScript(e.target.value.slice(0, SCRIPT_MAX))} rows={3} maxLength={SCRIPT_MAX} data-testid="avatar-script"
            placeholder="What should the presenter say?"
            className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          <span className="mt-0.5 block text-right text-[10px] text-gray-400">{script.length}/{SCRIPT_MAX}</span>
        </label>
      </div>

      {authError ? <p className="mt-6 text-sm text-red-600">{authError}</p> : error ? <p role="alert" className="mt-6 text-sm text-red-600">{error}</p> : drafts === null ? <ListSkeleton /> : drafts.length === 0 ? (
        <Empty text="No avatar drafts yet" sub="Pick a presenter and choose Create draft." icon={<Sparkles className="h-5 w-5" aria-hidden="true" />} />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" data-testid="avatar-drafts">
          {drafts.map((d) => {
            const b = badge(d);
            return (
              <div key={d.id} className="flex flex-col justify-between gap-4 rounded-2xl border border-gray-200/80 bg-white p-4 shadow-sm" data-testid="avatar-draft">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white"><Sparkles className="h-4 w-4 text-blue-400" aria-hidden="true" /></div>
                  <div className="min-w-0">
                    <h4 className="truncate text-xs font-bold text-gray-900">{d.title}</h4>
                    <p className="mt-0.5 truncate text-[11px] text-gray-500">{d.avatar?.name}{d.durationMs ? ` · ${Math.floor(d.durationMs / 60000)}:${String(Math.round(d.durationMs / 1000) % 60).padStart(2, '0')}` : ''}</p>
                    <span className={cn('mt-1 inline-block rounded px-1.5 text-[10px] font-bold uppercase', b.cls)} data-testid="avatar-status">{b.text}</span>
                  </div>
                </div>
                {preview?.id === d.id ? <video src={preview.url} controls playsInline className="aspect-video w-full rounded-lg bg-black" aria-label={`Preview of ${d.title}`} data-testid="avatar-preview" /> : null}
                <div className="flex items-center justify-between border-t border-gray-50 pt-3">
                  <span className="text-[10px] font-medium text-gray-400">{new Date(d.createdAt).toLocaleDateString()}</span>
                  {d.isPromoted ? (
                    <span className="flex items-center gap-1 text-[11px] font-bold text-green-600"><CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />Saved to My clips</span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      {d.playable ? <Button variant="ghost" size="sm" onClick={() => togglePreview(d)} data-testid="avatar-play"><Play className="h-3.5 w-3.5" aria-hidden="true" />{preview?.id === d.id ? 'Hide' : 'Preview'}</Button> : null}
                      <Button variant="ghost" size="icon" aria-label={`Discard ${d.title}`} disabled={busyId !== null} onClick={() => discard(d)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                      <Button size="sm" disabled={d.status !== 'READY' || busyId !== null} onClick={() => promote(d)} data-testid="avatar-promote"
                        title={d.status === 'READY' ? 'Save this avatar clip to My clips' : d.status === 'FAILED' ? 'The render failed, so it cannot be saved' : rendering?.enabled ? 'Available when the render finishes' : 'Locked: no render has been attached to this draft yet'}>
                        {busyId === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Share2 className="h-3.5 w-3.5" aria-hidden="true" />}Save to My clips
                      </Button>
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
