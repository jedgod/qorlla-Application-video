'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PlaylistSummary } from '@/lib/api';

/** One text field. `onSubmit` may throw; its message is shown and the dialog stays open. */
export function PromptDialog(props: {
  open: boolean; title: string; description?: string; label: string; initial?: string; submitLabel: string; type?: 'text' | 'email';
  onSubmit: (value: string) => Promise<void>; onClose: () => void;
}) {
  const { open, title, description, label, initial = '', submitLabel, type = 'text', onSubmit, onClose } = props;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setValue(initial); setError(''); setBusy(false); } }, [open, initial]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) { setError(`${label} is required.`); return; }
    setBusy(true); setError('');
    try { await onSubmit(v); onClose(); } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
          </DialogHeader>
          <label className="grid gap-1.5 text-sm font-medium">
            {label}
            <Input autoFocus type={type} value={value} maxLength={type === 'email' ? 254 : 200} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} />
          </label>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog(props: {
  open: boolean; title: string; description: string; confirmLabel: string; destructive?: boolean;
  onConfirm: () => Promise<void>; onClose: () => void;
}) {
  const { open, title, description, confirmLabel, destructive, onConfirm, onClose } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setBusy(false); setError(''); } }, [open]);
  async function go() {
    setBusy(true); setError('');
    try { await onConfirm(); onClose(); } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={go} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlaylistPickerDialog(props: {
  open: boolean; mine: PlaylistSummary[]; organization: PlaylistSummary[]; onPick: (id: string) => Promise<void>; onClose: () => void;
}) {
  const { open, mine, organization, onPick, onClose } = props;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setError(''); setBusy(false); } }, [open]);
  async function pick(id: string) {
    setBusy(true); setError('');
    try { await onPick(id); onClose(); } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong.'); setBusy(false); }
  }
  const group = (label: string, items: PlaylistSummary[]) => items.length ? (
    <div className="grid gap-1">
      <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">{label}</span>
      {items.map((p) => (
        <Button key={p.id} variant="ghost" className="justify-start" disabled={busy} onClick={() => pick(p.id)}>{p.title}<span className="ml-auto text-xs text-muted-foreground">{p.clipCount}</span></Button>
      ))}
    </div>
  ) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add to playlist</DialogTitle><DialogDescription>Choose a playlist for this clip.</DialogDescription></DialogHeader>
        {mine.length + organization.length === 0 ? <p className="text-sm text-muted-foreground">You have no playlists yet. Create one from My playlists.</p> : null}
        {group('My playlists', mine)}
        {group('Organization playlists', organization)}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
