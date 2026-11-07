'use client';

import { useState } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ClipsProvider, useClips } from './clips-provider';
import { ClipsNav } from './clips-nav';
import { GlobalRail } from './global-rail';
import { UploadsProvider } from '@/components/uploads/uploads-provider';
import { UploadTrackingPanel } from '@/components/uploads/upload-tracking-panel';
import { RecordClipDialog } from '@/components/uploads/record-clip-dialog';

/**
 * The frame that stays on screen while pages change: the Qorlla rail, the Clips navigation, the toast area, the recorder and the
 * upload queue. Only {children} (the page) is swapped by the router, so none of this re-mounts or loses state between pages.
 */
export function ClipsShell({ children }: { children: React.ReactNode }) {
  return (
    <ClipsProvider>
      <UploadsProvider>
        <Frame>{children}</Frame>
      </UploadsProvider>
    </ClipsProvider>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  const { me, toast } = useClips();
  const [open, setOpen] = useState(true);
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#f4f5f9] text-gray-800">
      <GlobalRail initial={(me?.name || me?.email || 'U').charAt(0).toUpperCase()} />
      {open ? (
        <aside className="flex w-[250px] shrink-0 flex-col border-r border-gray-200/80 bg-white p-3.5" aria-label="Clips">
          <div className="mb-4 flex items-center justify-between px-1.5">
            <h2 className="text-base font-bold text-gray-900">Clips</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label="Collapse sidebar" className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"><ChevronsLeft className="h-4 w-4" /></button>
          </div>
          <ClipsNav />
        </aside>
      ) : null}
      <main className="relative flex flex-1 flex-col overflow-hidden bg-white">
        {!open ? <button type="button" onClick={() => setOpen(true)} aria-label="Expand sidebar" className="absolute left-2 top-7 z-10 rounded p-1 text-gray-400 hover:bg-gray-50 hover:text-gray-600"><ChevronsRight className="h-4 w-4" /></button> : null}
        <div className={cn('flex min-h-0 flex-1 flex-col p-6', !open && 'pl-10')}>{children}</div>
        {toast ? <div role="status" aria-live="polite" className={cn('absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-white shadow-lg', toast.kind === 'ok' ? 'bg-slate-900' : 'bg-red-600')}>{toast.text}</div> : null}
      </main>
      <RecordClipDialog />
      <UploadTrackingPanel />
    </div>
  );
}
