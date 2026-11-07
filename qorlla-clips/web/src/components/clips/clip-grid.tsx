'use client';

import { Play, Star } from 'lucide-react';
import { cn, timeAgo } from '@/lib/utils';
import { formatBytes, formatClock } from '@/hooks/use-camera-recorder';
import type { Clip } from '@/lib/api';
import { RowMenu, SOURCE, StatusBadge, type ClipActions } from './clip-list';

/** The library as cards. Same data and the same actions as the list; the thumbnail is a placeholder until poster frames exist. */
export function ClipGrid({ clips, trashView, actions, canRemoveFromPlaylist }: { clips: Clip[]; trashView: boolean; actions: ClipActions; canRemoveFromPlaylist?: (c: Clip) => boolean }) {
  return (
    <ul className="grid grid-cols-1 gap-5 pb-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-label="Clips">
      {clips.map((c) => {
        const S = SOURCE[c.source]; const Icon = S.icon;
        return (
          <li key={c.id} data-clip-id={c.id} className="group flex flex-col overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm transition-all duration-200 hover:border-gray-300/80 hover:shadow-md">
            <div className="relative flex aspect-video select-none items-center justify-center overflow-hidden bg-gray-950">
              <div className="absolute inset-0 bg-gradient-to-tr from-gray-900 to-slate-800 opacity-90 transition-transform duration-300 group-hover:scale-105" aria-hidden="true" />
              <Icon className="absolute h-8 w-8 text-white/15" aria-hidden="true" />
              <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-2 py-0.5 backdrop-blur-md">
                <Icon className="h-3 w-3 text-white/80" aria-hidden="true" />
                <span className="text-[9.5px] font-bold uppercase tracking-wider text-white">{S.label}</span>
              </div>
              {c.durationMs ? <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white" aria-label={`Length ${formatClock(c.durationMs)}`}>{formatClock(c.durationMs)}</span> : null}
              {c.playable ? (
                <button type="button" onClick={() => actions.play(c)} aria-label={`Play ${c.title}`} className="z-10 flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-white/95 text-gray-900 opacity-0 shadow-lg transition-all duration-200 hover:bg-white focus:scale-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-white group-hover:scale-100 group-hover:opacity-100">
                  <Play className="ml-0.5 h-5 w-5 fill-current" aria-hidden="true" />
                </button>
              ) : null}
            </div>

            <div className="flex flex-1 flex-col justify-between gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-2 text-xs font-bold leading-relaxed text-gray-900">{c.title}</h3>
                <RowMenu clip={c} trashView={trashView} actions={actions} canRemove={!!canRemoveFromPlaylist && canRemoveFromPlaylist(c)} />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] font-medium text-gray-400">
                <StatusBadge clip={c} />
                {c.sizeBytes ? <span>{formatBytes(c.sizeBytes)}</span> : null}
                {!c.ownedByMe ? <span>Shared by {c.ownerName || 'a teammate'}</span> : null}
              </div>
              <div className="flex items-center justify-between border-t border-gray-50 pt-2.5 text-[10.5px] font-medium text-gray-400">
                <span>{timeAgo(c.updatedAt)}</span>
                {!trashView && c.ownedByMe ? (
                  <button type="button" onClick={() => actions.star(c)} aria-pressed={c.isStarred} aria-label={`${c.isStarred ? 'Unstar' : 'Star'} ${c.title}`} className={cn('rounded-md p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-ring', c.isStarred ? 'text-amber-500 hover:text-amber-600' : 'text-gray-300 hover:text-gray-500')}>
                    <Star className={cn('h-3.5 w-3.5', c.isStarred && 'fill-current')} />
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
