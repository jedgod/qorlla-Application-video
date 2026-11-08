'use client';

import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, Crown, Lock, Sparkles, User } from 'lucide-react';
import type { AvatarTemplate } from '@/lib/api';
import { cn } from '@/lib/utils';

const TIER_LABEL = { BASIC: 'Basic', PRO: 'Pro', BUSINESS: 'Business', ENTERPRISE: 'Enterprise' } as const;

/**
 * Picks one pre-built avatar. The server decides what the person may use: `templates` are the allowed ones, `locked` are shown
 * disabled with a lock (so people can see what an upgrade adds). A role is never used here, and a locked avatar cannot be selected;
 * the server refuses it too.
 */
export function AvatarPicker({ templates, locked, value, onChange }: {
  templates: AvatarTemplate[]; locked: AvatarTemplate[]; value: AvatarTemplate | null; onChange: (a: AvatarTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const row = (a: AvatarTemplate, isLocked: boolean) => (
    <li key={a.id} role="option" aria-selected={value?.id === a.id} aria-disabled={isLocked}>
      <button
        type="button" disabled={isLocked} onClick={() => { if (!isLocked) { onChange(a); setOpen(false); } }}
        title={isLocked ? `Included in the ${TIER_LABEL[a.tier]} plan and above: upgrade to use it` : undefined}
        className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium',
          isLocked ? 'cursor-not-allowed bg-gray-50/60 text-gray-400' : value?.id === a.id ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50')}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-gray-200/60 bg-gray-100 font-mono text-[9px] text-gray-500" aria-hidden="true">{a.name.slice(0, 2)}</span>
          <span className="truncate">{a.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 pl-2">
          {isLocked ? <Lock className="h-3 w-3" aria-hidden="true" /> : a.tier === 'ENTERPRISE' ? <Crown className="h-3.5 w-3.5 text-purple-500" aria-hidden="true" /> : a.tier === 'BUSINESS' ? <Building2 className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" /> : a.tier === 'PRO' ? <Sparkles className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" /> : null}
          <span className="text-[9px] font-bold uppercase text-gray-400">{TIER_LABEL[a.tier]}</span>
        </span>
      </button>
    </li>
  );

  return (
    <div ref={root} className="relative w-full max-w-sm" data-testid="avatar-picker">
      <label id="avatar-picker-label" className="mb-1.5 block px-0.5 text-[10.5px] font-bold uppercase tracking-wider text-gray-400">Presenter</label>
      <button
        type="button" aria-haspopup="listbox" aria-expanded={open} aria-labelledby="avatar-picker-label" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-800 shadow-sm hover:border-gray-300"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500" aria-hidden="true"><User className="h-3.5 w-3.5" /></span>
          <span className="truncate">{value ? value.name : 'Choose a presenter'}</span>
          {value ? <span className="rounded bg-gray-100 px-1.5 text-[9px] font-bold uppercase text-gray-500">{TIER_LABEL[value.tier]}</span> : null}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-gray-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open ? (
        <ul role="listbox" className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-gray-100 bg-white p-1 shadow-xl">
          {templates.map((a) => row(a, false))}
          {locked.map((a) => row(a, true))}
        </ul>
      ) : null}
    </div>
  );
}
