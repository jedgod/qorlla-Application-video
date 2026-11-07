'use client';

import { AlertTriangle, Flag, CloudUpload, Circle, Play, FolderMinus, FolderPlus, Loader2, MoreVertical, Pencil, Presentation, RotateCcw, Share2, Sparkles, Star, Trash2, Upload } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn, timeAgo } from '@/lib/utils';
import type { Clip, ClipSource } from '@/lib/api';

export interface ClipActions {
  star: (c: Clip) => void; rename: (c: Clip) => void; share: (c: Clip) => void; addToPlaylist: (c: Clip) => void;
  trash: (c: Clip) => void; restore: (c: Clip) => void; deleteForever: (c: Clip) => void;
  removeFromPlaylist?: (c: Clip) => void; report?: (c: Clip) => void;
  play: (c: Clip) => void;
}

export const SOURCE: Record<ClipSource, { label: string; icon: typeof Circle }> = {
  RECORDING: { label: 'Recording', icon: Circle },
  AVATAR_GENERATION: { label: 'Avatar', icon: Sparkles },
  SLIDE_CONVERSION: { label: 'From slides', icon: Presentation },
  UPLOAD: { label: 'Upload', icon: Upload },
};

export function StatusBadge({ clip }: { clip: Clip }) {
  if (clip.status === 'UPLOADING') return <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700"><CloudUpload className="h-3 w-3" aria-hidden="true" />Uploading</span>;
  if (clip.status === 'PROCESSING') return <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Processing</span>;
  if (clip.status === 'FAILED') return <span className="inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700"><AlertTriangle className="h-3 w-3" aria-hidden="true" />Failed</span>;
  return <span className="rounded bg-green-50 px-1.5 py-0.5 text-[11px] font-medium text-green-700">Ready</span>;
}

export function ClipList({ clips, trashView, actions, canRemoveFromPlaylist }: { clips: Clip[]; trashView: boolean; actions: ClipActions; canRemoveFromPlaylist?: (c: Clip) => boolean }) {
  return (
    <ul className="divide-y divide-gray-100" aria-label="Clips">
      {clips.map((c) => {
        const S = SOURCE[c.source]; const Icon = S.icon;
        return (
          <li key={c.id} data-clip-id={c.id} className="flex items-center gap-3 py-3">
            {c.playable ? (
              <button type="button" onClick={() => actions.play(c)} aria-label={`Play ${c.title}`} className="group flex h-12 w-20 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white/80 transition-colors hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-ring"><Play className="h-5 w-5 fill-white/80 group-hover:fill-white" aria-hidden="true" /></button>
            ) : (
              <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white/80" aria-hidden="true"><Icon className="h-5 w-5" /></div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-gray-900">{c.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500">
                <span>{S.label}</span><StatusBadge clip={c} /><span>{timeAgo(c.updatedAt)}</span>
                {!c.ownedByMe ? <span>Shared by {c.ownerName || 'a teammate'}</span> : null}
              </p>
            </div>
            {!trashView && c.ownedByMe ? (
              <button type="button" onClick={() => actions.star(c)} aria-pressed={c.isStarred} aria-label={`${c.isStarred ? 'Unstar' : 'Star'} ${c.title}`} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-amber-500 focus:outline-none focus:ring-2 focus:ring-ring">
                <Star className={cn('h-4 w-4', c.isStarred && 'fill-amber-400 text-amber-400')} />
              </button>
            ) : null}
            <RowMenu clip={c} trashView={trashView} actions={actions} canRemove={!!canRemoveFromPlaylist && canRemoveFromPlaylist(c)} />
          </li>
        );
      })}
    </ul>
  );
}

export function RowMenu({ clip, trashView, actions, canRemove }: { clip: Clip; trashView: boolean; actions: ClipActions; canRemove: boolean }) {
  const mineOnly = clip.ownedByMe;
  if (!mineOnly && !canRemove && !actions.report) return <span className="w-8" />;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`More actions for ${clip.title}`} className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-ring"><MoreVertical className="h-4 w-4" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {trashView ? (
          <>
            <DropdownMenuItem onSelect={() => actions.restore(clip)}><RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Restore</DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={() => actions.deleteForever(clip)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete forever</DropdownMenuItem>
          </>
        ) : (
          <>
            {mineOnly ? (
              <>
                <DropdownMenuItem onSelect={() => actions.rename(clip)}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Rename</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.addToPlaylist(clip)}><FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />Add to playlist</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.share(clip)}><Share2 className="h-3.5 w-3.5" aria-hidden="true" />Share</DropdownMenuItem>
              </>
            ) : null}
            {!mineOnly && actions.report ? <DropdownMenuItem onSelect={() => actions.report?.(clip)}><Flag className="h-3.5 w-3.5" aria-hidden="true" />Report</DropdownMenuItem> : null}
            {canRemove && actions.removeFromPlaylist ? <DropdownMenuItem onSelect={() => actions.removeFromPlaylist?.(clip)}><FolderMinus className="h-3.5 w-3.5" aria-hidden="true" />Remove from playlist</DropdownMenuItem> : null}
            {mineOnly ? (<><DropdownMenuSeparator /><DropdownMenuItem destructive onSelect={() => actions.trash(clip)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Move to trash</DropdownMenuItem></>) : null}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
