'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, RotateCcw, Square, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatBytes, formatClock, useCameraRecorder } from '@/hooks/use-camera-recorder';
import { useClips } from '@/components/clips/clips-provider';
import { useUploads } from './uploads-provider';

const defaultTitle = () => `Recording ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

export function RecordClipDialog() {
  const { recorderOpen, closeRecorder } = useClips();
  const { startUpload } = useUploads();
  const rec = useCameraRecorder();
  const [title, setTitle] = useState('');
  const live = useRef<HTMLVideoElement | null>(null);
  const { openCamera, reset } = rec;

  // the camera opens with the dialog and is always switched off when it closes
  useEffect(() => {
    if (recorderOpen) { setTitle(defaultTitle()); void openCamera(); } else reset();
  }, [recorderOpen, openCamera, reset]);

  useEffect(() => { if (live.current) live.current.srcObject = rec.stream; }, [rec.stream, rec.state]);

  const busy = rec.state === 'recording';
  function save() {
    if (!rec.recording) return;
    startUpload(rec.recording.blob, { title: title.trim() || defaultTitle(), durationMs: rec.recording.durationMs });   // continues in the background
    closeRecorder();
  }

  return (
    <Dialog open={recorderOpen} onOpenChange={(o) => { if (!o && !busy) closeRecorder(); }}>
      <DialogContent className="max-w-2xl gap-3 p-0" aria-describedby="rec-desc" onInteractOutside={(e) => { if (busy) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-2 text-sm font-bold">
            <span className={`h-2 w-2 rounded-full bg-red-500 ${busy ? 'animate-pulse' : 'opacity-40'}`} aria-hidden="true" />Record a clip
          </DialogTitle>
          <DialogDescription id="rec-desc">Your camera and microphone are used only while this window is open.</DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video overflow-hidden bg-gray-950 text-white" data-recorder-state={rec.state}>
          {rec.state === 'recorded' && rec.recording ? (
            <video key={rec.recording.url} src={rec.recording.url} controls playsInline className="h-full w-full object-contain" aria-label="Preview of your recording" />
          ) : (
            // the preview is mirrored like a mirror; the recording itself is not
            <video ref={live} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" aria-label="Camera preview" />
          )}
          {rec.state === 'requesting' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-gray-300"><Loader2 className="h-6 w-6 animate-spin text-blue-400" aria-hidden="true" /><p className="text-xs font-medium">Starting your camera…</p></div>
          ) : null}
          {rec.state === 'error' ? (
            <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center text-red-300"><AlertCircle className="h-8 w-8" aria-hidden="true" /><p className="text-sm font-semibold">{rec.error}</p></div>
          ) : null}
          {busy ? <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs font-semibold" aria-live="off"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden="true" />REC {formatClock(rec.elapsedMs)} / {formatClock(rec.maxMs)}</div> : null}
        </div>

        {rec.state === 'recorded' && rec.recording ? (
          <div className="grid gap-1.5 px-5">
            <label htmlFor="rec-title" className="text-sm font-medium">Title</label>
            <Input id="rec-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            <p className="text-xs text-muted-foreground">{formatClock(rec.recording.durationMs)} · {formatBytes(rec.recording.blob.size)} · {rec.recording.mimeType.replace('video/', '').toUpperCase()}</p>
          </div>
        ) : null}

        <DialogFooter className="items-center justify-between border-t border-gray-100 bg-gray-50 px-5 py-4 sm:justify-between">
          <div className="flex gap-2">
            {rec.state === 'ready' ? <Button onClick={rec.start} className="bg-red-600 hover:bg-red-700"><Video className="h-4 w-4" aria-hidden="true" />Start recording</Button> : null}
            {busy ? <Button onClick={rec.stop} className="bg-gray-900 hover:bg-gray-800"><Square className="h-4 w-4" aria-hidden="true" />Stop</Button> : null}
            {rec.state === 'recorded' || rec.state === 'error' ? <Button variant="outline" onClick={() => void openCamera()}><RotateCcw className="h-4 w-4" aria-hidden="true" />{rec.state === 'error' ? 'Try again' : 'Record again'}</Button> : null}
          </div>
          <div className="flex gap-2">
            {!busy ? <Button variant="ghost" onClick={closeRecorder}>{rec.state === 'recorded' ? 'Discard' : 'Close'}</Button> : null}
            {rec.state === 'recorded' ? <Button onClick={save}>Save to library</Button> : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
