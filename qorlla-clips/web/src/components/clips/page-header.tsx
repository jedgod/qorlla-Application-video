'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { api, type ClipSource } from '@/lib/api';
import { CreateMenu } from './create-menu';
import { errorMessage, useClips } from './clips-provider';
import { useUploads } from '@/components/uploads/uploads-provider';

/** Title row shared by every page: optional back link, the title, page-specific controls, and the blue + create menu. */
export function PageHeader({ title, back, children, playlistId, hideCreate }: {
  title: string; back?: { href: string; label: string }; children?: React.ReactNode; playlistId?: string; hideCreate?: boolean;
}) {
  const { summary, say, invalidate, openRecorder } = useClips();
  const router = useRouter();
  const { startUpload } = useUploads();
  const picker = useRef<HTMLInputElement>(null);

  function picked(files: FileList | null) {
    const f = files?.[0]; if (picker.current) picker.current.value = '';
    if (!f) return;
    if (f.type !== 'video/webm' && f.type !== 'video/mp4') { say('Only WebM and MP4 videos can be uploaded.', 'err'); return; }
    startUpload(f, { title: f.name.replace(/\.[^.]+$/, '').slice(0, 200) || 'Uploaded video', source: 'UPLOAD' });   // continues in the background
  }

  async function create(source: ClipSource) {
    if (source === 'RECORDING') { openRecorder(); return; }          // recording happens in the browser; it uploads when you save
    if (source === 'UPLOAD') { picker.current?.click(); return; }
    if (source === 'AVATAR_GENERATION') { router.push('/dashboard/creation/avatars'); return; }   // avatar drafts live in their own workspace, not in My clips
    try {
      await api.createClip({ source, playlistId });
      say('Clip created. It stays "Processing" until its media is attached.');
      invalidate();
      if (!playlistId) router.push('/dashboard/my-clips');
    } catch (e) { say(errorMessage(e), 'err'); invalidate(); }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 pb-4">
      <div className="flex min-w-0 items-center gap-2">
        {back ? <Link href={back.href} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"><ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{back.label}</Link> : null}
        <h1 className="truncate text-xl font-bold text-gray-900" data-testid="view-title">{title}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {hideCreate ? null : <CreateMenu uploadEnabled={!!summary?.features.upload} onCreate={create} />}
        <input ref={picker} type="file" accept="video/webm,video/mp4" hidden data-testid="upload-input" onChange={(e) => picked(e.target.files)} />
      </div>
    </div>
  );
}

export function Empty({ text, sub, icon }: { text: string; sub?: string; icon?: React.ReactNode }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center text-center">
      <div className="max-w-sm rounded-2xl border-2 border-dashed border-gray-200/80 bg-gray-50/50 p-6">
        {icon ? <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-gray-100 bg-white text-gray-400 shadow-sm">{icon}</div> : null}
        <h3 className="mb-1 text-sm font-semibold text-gray-900">{text}</h3>
        {sub ? <p className="text-sm text-gray-500">{sub}</p> : null}
      </div>
    </div>
  );
}

/** What a list shows while it loads for the first time (the same shape as a list row, so nothing jumps). */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="animate-pulse divide-y divide-gray-100" aria-hidden="true" data-testid="list-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-3"><div className="h-12 w-20 rounded-lg bg-gray-200" /><div className="flex-1 space-y-2"><div className="h-3.5 w-1/3 rounded bg-gray-200" /><div className="h-3 w-1/4 rounded bg-gray-100" /></div></div>
      ))}
    </div>
  );
}
