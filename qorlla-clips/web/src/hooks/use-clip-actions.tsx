'use client';

import { useMemo, useState } from 'react';
import { api, type Clip } from '@/lib/api';
import { errorMessage, useClips } from '@/components/clips/clips-provider';
import type { ClipActions } from '@/components/clips/clip-list';
import { ConfirmDialog, PlaylistPickerDialog, PromptDialog } from '@/components/clips/dialogs';
import { PlayerDialog } from '@/components/clips/player-dialog';

type Dialog = null | { t: 'rename' | 'share' | 'pick' | 'deleteClip' | 'report'; clip: Clip };

/** Everything a list of clips can do to a clip, plus the dialogs those actions open. Lists re-fetch through `invalidate()`. */
export function useClipActions(playlist?: { id: string }) {
  const { say, invalidate, refreshSummary, summary } = useClips();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [playing, setPlaying] = useState<Clip | null>(null);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); say(ok); invalidate(); } catch (e) { say(errorMessage(e), 'err'); }
  };

  const actions: ClipActions = useMemo(() => ({
    star: (c) => void run(() => api.patchClip(c.id, { isStarred: !c.isStarred }), c.isStarred ? 'Removed from Starred.' : 'Added to Starred.'),
    rename: (c) => setDialog({ t: 'rename', clip: c }),
    share: (c) => setDialog({ t: 'share', clip: c }),
    report: (c) => setDialog({ t: 'report', clip: c }),
    addToPlaylist: (c) => setDialog({ t: 'pick', clip: c }),
    trash: (c) => void run(() => api.trashClip(c.id), 'Moved to Trash.'),
    restore: (c) => void run(() => api.restoreClip(c.id), 'Clip restored.'),
    deleteForever: (c) => setDialog({ t: 'deleteClip', clip: c }),
    removeFromPlaylist: playlist ? (c) => void run(() => api.removeFromPlaylist(playlist.id, c.id), 'Removed from playlist.') : undefined,
    play: (c) => setPlaying(c),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [playlist?.id]);

  const close = () => setDialog(null);
  const dialogs = (
    <>
      <PromptDialog open={dialog?.t === 'rename'} title="Rename clip" label="Clip name" submitLabel="Save" initial={dialog?.t === 'rename' ? dialog.clip.title : ''}
        onClose={close} onSubmit={async (v) => { if (dialog?.t === 'rename') { await api.patchClip(dialog.clip.id, { title: v }); say('Clip renamed.'); invalidate(); } }} />
      <PromptDialog open={dialog?.t === 'share'} type="email" title="Share clip" description="Share with someone in your organization. They will be notified." label="Email address" submitLabel="Share"
        onClose={close} onSubmit={async (v) => { if (dialog?.t === 'share') { await api.shareClip(dialog.clip.id, v); say('Clip shared.'); await refreshSummary(); } }} />
      <PromptDialog open={dialog?.t === 'report'} title="Report clip" description="Tell your organization's admins what is wrong. They will review it." label="Reason" submitLabel="Report"
        onClose={close} onSubmit={async (v) => { if (dialog?.t === 'report') { await api.reportClip(dialog.clip.id, v); say('Thanks, the admins will review it.'); } }} />
      <ConfirmDialog open={dialog?.t === 'deleteClip'} destructive title="Delete forever?" description="This clip, and its video, will be permanently deleted. This cannot be undone." confirmLabel="Delete forever"
        onClose={close} onConfirm={async () => { if (dialog?.t === 'deleteClip') { await api.deleteClip(dialog.clip.id); say('Clip deleted.'); invalidate(); } }} />
      <PlaylistPickerDialog open={dialog?.t === 'pick'} mine={summary?.playlists ?? []} organization={summary?.organizationPlaylists ?? []}
        onClose={close} onPick={async (id) => { if (dialog?.t === 'pick') { await api.addToPlaylist(id, dialog.clip.id); say('Added to playlist.'); invalidate(); } }} />
      <PlayerDialog clip={playing} onClose={() => setPlaying(null)} />
    </>
  );
  return { actions, dialogs };
}
