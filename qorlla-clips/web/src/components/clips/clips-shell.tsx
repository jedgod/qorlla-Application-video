'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, Menu } from 'lucide-react';
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
  const [open, setOpen] = useState(true);          // desktop: the Clips sidebar expanded or collapsed
  const [drawer, setDrawer] = useState(false);      // phone: the menu (both sidebars) slid in over the page
  const pathname = usePathname();
  useEffect(() => { setDrawer(false); }, [pathname]);      // choosing a page closes the menu
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);
  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-[#f4f5f9] text-gray-800">
      {drawer ? <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={() => setDrawer(false)} aria-hidden="true" data-testid="clips-drawer-backdrop" /> : null}
      {/* Below the tablet width the two sidebars become a menu that slides in over the page; from tablet up they sit beside it as before. */}
      <div className={cn('fixed inset-y-0 left-0 z-40 flex -translate-x-full transition-transform duration-200 md:static md:z-auto md:translate-x-0', drawer && 'translate-x-0')} data-testid="clips-menu">
        <GlobalRail initial={(me?.name || me?.email || 'U').charAt(0).toUpperCase()} />
        <aside className={cn('w-[250px] shrink-0 flex-col overflow-y-auto border-r border-gray-200/80 bg-white p-3.5', open ? 'flex' : 'flex md:hidden')} aria-label="Clips">
          <div className="mb-4 flex items-center justify-between px-1.5">
            <h2 className="text-base font-bold text-gray-900">Clips</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label="Collapse sidebar" className="hidden rounded p-1 text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600 md:block"><ChevronsLeft className="h-4 w-4" /></button>
          </div>
          <ClipsNav />
        </aside>
      </div>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2 md:hidden">
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer} data-testid="clips-menu-button" className="rounded-lg p-2 text-gray-600 hover:bg-gray-100"><Menu className="h-5 w-5" /></button>
          <span className="text-base font-bold text-gray-900">Clips</span>
        </div>
        {!open ? <button type="button" onClick={() => setOpen(true)} aria-label="Expand sidebar" className="absolute left-2 top-7 z-10 hidden rounded p-1 text-gray-400 hover:bg-gray-50 hover:text-gray-600 md:block"><ChevronsRight className="h-4 w-4" /></button> : null}
        <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto p-4 md:overflow-visible md:p-6', !open && 'md:pl-10')}>{children}</div>
        {toast ? <div role="status" aria-live="polite" className={cn('absolute bottom-6 left-1/2 z-30 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-white shadow-lg', toast.kind === 'ok' ? 'bg-slate-900' : 'bg-red-600')}>{toast.text}</div> : null}
      </main>
      <RecordClipDialog />
      <UploadTrackingPanel />
    </div>
  );
}
