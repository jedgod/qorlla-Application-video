'use client';

import { useEffect, useState } from 'react';
import { Bell, FolderOpen } from 'lucide-react';
import { api, type Notice } from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';
import { errorMessage, useClips } from './clips-provider';
import { Empty, ListSkeleton, PageHeader } from './page-header';

export function NotificationsPage() {
  const { refreshSummary, authError, dataVersion } = useClips();
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api.notifications().then(async (r) => {
      if (!live) return;
      setNotices(r.notifications);
      if (r.notifications.some((n) => !n.read)) { await api.markNotificationsRead().catch(() => null); void refreshSummary(); }   // opening the page reads them
    }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [refreshSummary, dataVersion]);
  return (
    <>
      <PageHeader title="Notifications" hideCreate />
      <div className="mt-4 flex-1 overflow-y-auto">
        {authError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{authError}</p> : null}
        {error && !authError ? <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {notices === null && !error ? <ListSkeleton rows={3} /> : null}
        {notices && notices.length === 0 ? <Empty icon={<Bell className="h-5 w-5" aria-hidden="true" />} text="You have no notifications." sub="You will be told here when someone shares a clip with you." /> : null}
        {notices && notices.length ? (
          <ul className="divide-y divide-gray-100" aria-label="Notifications">
            {notices.map((n) => <li key={n.id} className="py-3 text-sm"><p className={cn(!n.read && 'font-semibold')}>{n.message}</p><p className="text-xs text-gray-500">{timeAgo(n.createdAt)}</p></li>)}
          </ul>
        ) : null}
      </div>
    </>
  );
}

/** Projects have no backend yet. The page exists so the link works, and says so plainly. */
export function ProjectsPage() {
  return (
    <>
      <PageHeader title="Projects" hideCreate />
      <Empty icon={<FolderOpen className="h-5 w-5" aria-hidden="true" />} text="Projects are not available yet" sub="Multi-clip projects are planned. Your clips and playlists work today." />
    </>
  );
}
