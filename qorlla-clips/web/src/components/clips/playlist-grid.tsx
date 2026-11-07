'use client';

import { ListVideo } from 'lucide-react';
import type { PlaylistSummary } from '@/lib/api';

export function PlaylistGrid({ playlists, onOpen }: { playlists: PlaylistSummary[]; onOpen: (p: PlaylistSummary) => void }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Playlists">
      {playlists.map((p) => (
        <li key={p.id}>
          <button type="button" onClick={() => onOpen(p)} data-playlist-id={p.id} className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-brand/40 hover:bg-[#f7f9ff] focus:outline-none focus:ring-2 focus:ring-ring">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#eef3ff] text-brand" aria-hidden="true"><ListVideo className="h-5 w-5" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-gray-900">{p.title}</span>
              <span className="block text-xs text-gray-500">{p.clipCount} {p.clipCount === 1 ? 'clip' : 'clips'}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
