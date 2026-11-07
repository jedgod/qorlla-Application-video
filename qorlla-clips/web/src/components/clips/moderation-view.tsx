'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, type AdminReport } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { timeAgo } from '@/lib/utils';
import { errorMessage, useClips } from './clips-provider';
import { Empty, PageHeader } from './page-header';

type Entry = { id: string; action: string; actorId: string; clipId: string | null; detail: string | null; createdAt: string };

/** Reports sent by members, newest first. Only organization admins get data back: the API refuses everyone else with 403. */
export function ModerationView() {
  const { say, summary, invalidate } = useClips();
  const [reports, setReports] = useState<AdminReport[] | null>(null);
  const [audit, setAudit] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { const [r, a] = await Promise.all([api.adminReports(), api.auditLog()]); setReports(r.reports); setAudit(a.entries); setError(''); }
    catch (e) { setError(errorMessage(e)); setReports([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function resolve(r: AdminReport, action: 'dismiss' | 'trash') {
    setBusy(r.id);
    try { await api.resolveReport(r.id, action); say(action === 'trash' ? 'Clip moved to the trash.' : 'Report dismissed.'); invalidate(); await load(); }
    catch (e) { say(errorMessage(e), 'err'); await load(); } finally { setBusy(''); }
  }

  if (summary && summary.role !== 'ADMIN') {
    return (<><PageHeader title="Moderation" hideCreate /><p role="alert" className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Only organization admins can review reports.</p></>);
  }

  return (
    <>
      <PageHeader title="Moderation" hideCreate />
      <div className="mt-4 flex-1 space-y-6 overflow-y-auto pb-6">
        {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {reports && reports.length === 0 && !error ? <Empty icon={<ShieldCheck className="h-5 w-5" aria-hidden="true" />} text="No open reports." /> : null}
        <ul className="space-y-3" aria-label="Open reports">
          {(reports ?? []).map((r) => (
            <li key={r.id} data-report-id={r.id} className="rounded-xl border border-gray-200/80 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0"><p className="truncate text-sm font-bold text-gray-900">{r.clip.title}</p><p className="text-xs text-gray-500">Owner: {r.clip.ownerName} · reported {timeAgo(r.createdAt)}</p></div>
                <div className="flex gap-2">
                  <Button variant="outline" disabled={busy === r.id} onClick={() => void resolve(r, 'dismiss')}>Dismiss</Button>
                  <Button disabled={busy === r.id || r.clip.isTrashed} onClick={() => void resolve(r, 'trash')}>Move to trash</Button>
                </div>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">{r.reason}</p>
            </li>
          ))}
        </ul>
        {audit.length ? (
          <section><h2 className="mb-2 text-sm font-bold text-gray-800">Recent decisions</h2>
            <ul className="space-y-1 text-xs text-gray-600" aria-label="Audit log">{audit.slice(0, 20).map((e) => <li key={e.id}>{timeAgo(e.createdAt)}: {e.action === 'report.trash_clip' ? 'moved a clip to the trash' : 'dismissed a report'}</li>)}</ul>
          </section>
        ) : null}
      </div>
    </>
  );
}
