'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderOpen, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type PlaylistSummary } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ConfirmDialog, PromptDialog } from './dialogs';
import { ClipsCollection } from './clips-collection';
import { errorMessage, useClips } from './clips-provider';
import { Empty, ListSkeleton, PageHeader } from './page-header';
import { PlaylistGrid } from './playlist-grid';

/** "My playlists" (org=false) and "Organization playlists" (org=true). */
export function PlaylistsPage({ org }: { org: boolean }) {
  const { me, dataVersion, say, invalidate, authError } = useClips();
  const router = useRouter();
  const base = org ? '/dashboard/organization' : '/dashboard/my-playlists';
  const [items, setItems] = useState<PlaylistSummary[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const canCreate = !org || me?.role === 'ADMIN';

  useEffect(() => {
    let live = true;
    api.playlists(org ? 'organization' : 'mine').then((r) => { if (live) { setItems(r.playlists); setError(''); } }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [org, dataVersion]);

  return (
    <>
      <PageHeader title={org ? 'Organization playlists' : 'My playlists'}>
        {canCreate ? <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden="true" />New playlist</Button> : null}
      </PageHeader>
      <div className="mt-4 flex-1 overflow-y-auto">
        {authError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{authError}</p> : null}
        {error && !authError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {items === null && !error ? <ListSkeleton rows={3} /> : null}
        {items && items.length === 0 ? (
          <Empty icon={<FolderOpen className="h-5 w-5" aria-hidden="true" />} text={org ? 'Your organization has no playlists yet' : 'You have no playlist'}
            sub={org ? (canCreate ? 'Create one to share clips with everyone in your organization.' : 'Only organization admins can create them.') : 'Create one to group your clips.'} />
        ) : null}
        {items && items.length ? <PlaylistGrid playlists={items} onOpen={(p) => router.push(`${base}/${p.id}`)} /> : null}
      </div>
      <PromptDialog open={creating} title={org ? 'New organization playlist' : 'New playlist'} label="Playlist name" submitLabel="Create"
        onClose={() => setCreating(false)} onSubmit={async (v) => { await api.createPlaylist(v, org); say('Playlist created.'); invalidate(); }} />
    </>
  );
}

/** One playlist: its clips, and (for people allowed to manage it) rename and delete. */
export function PlaylistDetailPage({ org, id }: { org: boolean; id: string }) {
  const { me, dataVersion, say, invalidate } = useClips();
  const router = useRouter();
  const list = org ? '/dashboard/organization' : '/dashboard/my-playlists';
  const [playlist, setPlaylist] = useState<PlaylistSummary | null | undefined>(undefined);
  const [dialog, setDialog] = useState<null | 'rename' | 'delete'>(null);

  useEffect(() => {
    let live = true;
    api.playlists(org ? 'organization' : 'mine').then((r) => { if (live) setPlaylist(r.playlists.find((p) => p.id === id) ?? null); }).catch(() => { if (live) setPlaylist(null); });
    return () => { live = false; };
  }, [org, id, dataVersion]);

  const mayManage = !org || me?.role === 'ADMIN';

  if (playlist === null) {
    return (<><PageHeader title="Playlist" back={{ href: list, label: org ? 'Organization playlists' : 'My playlists' }} hideCreate /><Empty text="This playlist was not found" sub="It may have been deleted." /></>);
  }
  return (
    <>
      <ClipsCollection
        title={playlist?.title ?? 'Playlist'}
        back={{ href: list, label: org ? 'Organization playlists' : 'My playlists' }}
        query={{ view: 'playlist', playlistId: id }} playlist={{ id, org }}
        empty='This playlist has no clips yet. Use "Add to playlist" on one of your clips.'
        canRemoveFromPlaylist={(c) => (org ? me?.role === 'ADMIN' || c.ownedByMe : true)}
        header={mayManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label="Playlist options" className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-ring"><MoreVertical className="h-4 w-4" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setDialog('rename')}><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Rename playlist</DropdownMenuItem>
              <DropdownMenuItem destructive onSelect={() => setDialog('delete')}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" />Delete playlist</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      />
      <PromptDialog open={dialog === 'rename'} title="Rename playlist" label="Playlist name" submitLabel="Save" initial={playlist?.title ?? ''}
        onClose={() => setDialog(null)} onSubmit={async (v) => { await api.renamePlaylist(id, v); say('Playlist renamed.'); invalidate(); }} />
      <ConfirmDialog open={dialog === 'delete'} destructive title="Delete this playlist?" description="The playlist is removed. The clips in it are kept." confirmLabel="Delete playlist"
        onClose={() => setDialog(null)} onConfirm={async () => { await api.deletePlaylist(id); say('Playlist deleted.'); invalidate(); router.push(list); }} />
    </>
  );
}
