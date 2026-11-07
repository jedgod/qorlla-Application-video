'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, LayoutGrid, List, Search } from 'lucide-react';
import { api, type Clip, type ClipQuery } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useClipActions } from '@/hooks/use-clip-actions';
import { ClipList } from './clip-list';
import { ClipGrid } from './clip-grid';
import { errorMessage, useClips } from './clips-provider';
import { Empty, ListSkeleton, PageHeader } from './page-header';

type Base = Omit<ClipQuery, 'q' | 'cursor' | 'limit'>;

/**
 * One page of clips: title, search, the list (cursor-paginated) and every clip action. The route pages differ only in `query`, `title`
 * and the empty message. It re-fetches when `dataVersion` changes, so an action anywhere keeps every open list current.
 */
export function ClipsCollection(props: {
  title: string; query: Base; empty: string; trash?: boolean; back?: { href: string; label: string };
  playlist?: { id: string; org: boolean }; header?: React.ReactNode; canRemoveFromPlaylist?: (c: Clip) => boolean;
}) {
  const { title, query, empty, trash, back, playlist, header, canRemoveFromPlaylist } = props;
  const { dataVersion, authError } = useClips();
  const { actions, dialogs } = useClipActions(playlist);
  const [items, setItems] = useState<Clip[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [first, setFirst] = useState(true);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const reqId = useRef(0);
  const key = JSON.stringify(query);
  // list or grid: remembered in this browser (storage can be unavailable: the default is the list)
  const [mode, setMode] = useState<'list' | 'grid'>('list');
  useEffect(() => { try { if (localStorage.getItem('clips_view_mode') === 'grid') setMode('grid'); } catch { /* storage blocked */ } }, []);
  const chooseMode = (m: 'list' | 'grid') => { setMode(m); try { localStorage.setItem('clips_view_mode', m); } catch { /* storage blocked */ } };

  useEffect(() => { const t = setTimeout(() => setSearch(input.trim()), 300); return () => clearTimeout(t); }, [input]);

  const load = useCallback(async (cursor?: string | null) => {
    const id = ++reqId.current;
    setLoading(true); setError('');
    try {
      const r = await api.clips({ ...(JSON.parse(key) as Base), q: search || undefined, cursor: cursor || undefined, limit: 30 });
      if (id !== reqId.current) return;
      setItems((prev) => (cursor ? [...prev, ...r.clips] : r.clips)); setNext(r.nextCursor); setFirst(false);
    } catch (e) { if (id === reqId.current) { setError(errorMessage(e)); setFirst(false); } }
    finally { if (id === reqId.current) setLoading(false); }
  }, [key, search]);

  useEffect(() => { void load(null); }, [load, dataVersion]);

  return (
    <>
      <PageHeader title={title} back={back} playlistId={playlist?.id}>
        {header}
        <div role="group" aria-label="Layout" className="flex overflow-hidden rounded-lg border border-input">
          <button type="button" onClick={() => chooseMode('list')} aria-pressed={mode === 'list'} aria-label="List view" className={`p-2 transition-colors ${mode === 'list' ? 'bg-accent text-brand' : 'text-gray-500 hover:bg-gray-50'}`}><List className="h-4 w-4" /></button>
          <button type="button" onClick={() => chooseMode('grid')} aria-pressed={mode === 'grid'} aria-label="Grid view" className={`p-2 transition-colors ${mode === 'grid' ? 'bg-accent text-brand' : 'text-gray-500 hover:bg-gray-50'}`}><LayoutGrid className="h-4 w-4" /></button>
        </div>
        <label className="relative">
          <span className="sr-only">Search clips</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" aria-hidden="true" />
          <Input className="w-48 pl-8" placeholder="Search clips" value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
      </PageHeader>

      <div className="mt-4 flex-1 overflow-y-auto" aria-busy={loading}>
        {authError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{authError}</p> : null}
        {error && !authError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {first && loading ? <ListSkeleton /> : null}
        {!first && items.length === 0 && !error ? <Empty icon={<FolderOpen className="h-5 w-5" aria-hidden="true" />} text={search ? 'No clips match your search.' : empty} /> : null}
        {items.length ? (mode === 'grid'
          ? <ClipGrid clips={items} trashView={!!trash} actions={actions} canRemoveFromPlaylist={canRemoveFromPlaylist} />
          : <ClipList clips={items} trashView={!!trash} actions={actions} canRemoveFromPlaylist={canRemoveFromPlaylist} />) : null}
        {next ? <div className="py-4 text-center"><Button variant="outline" onClick={() => void load(next)} disabled={loading}>Load more</Button></div> : null}
      </div>
      {dialogs}
    </>
  );
}
