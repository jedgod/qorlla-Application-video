'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, type Clip } from '@/lib/api';

/** Plays a clip through a short-lived signed address that the server issues only to people allowed to see the clip. */
export function PlayerDialog({ clip, onClose }: { clip: Clip | null; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setUrl(null); setError('');
    if (!clip) return;
    let live = true;
    api.playback(clip.id).then((r) => { if (live) setUrl(r.url); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : 'This clip cannot be played.'); });
    return () => { live = false; };
  }, [clip]);
  return (
    <Dialog open={!!clip} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle className="truncate pr-6">{clip?.title}</DialogTitle><DialogDescription className="sr-only">Video player</DialogDescription></DialogHeader>
        <div className="aspect-video overflow-hidden rounded-lg bg-black">
          {url ? <video src={url} controls autoPlay playsInline className="h-full w-full" aria-label={clip?.title} />
            : error ? <p role="alert" className="flex h-full items-center justify-center px-6 text-center text-sm text-red-300">{error}</p>
            : <div className="flex h-full items-center justify-center text-gray-300"><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading video" /></div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
