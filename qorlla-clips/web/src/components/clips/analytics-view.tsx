'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, type Overview } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/hooks/use-camera-recorder';
import { errorMessage, useClips } from './clips-provider';
import { PageHeader } from './page-header';

/** A bar chart drawn as plain SVG: no chart library; every bar has a title, and the totals are also shown as numbers. */
function Bars({ data, label }: { data: { date: string; count: number }[]; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const w = 600, h = 120, gap = 2, bw = Math.max(2, w / data.length - gap);
  return (
    <figure>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${data.reduce((n, d) => n + d.count, 0)} in total`} className="h-32 w-full">
        {data.map((d, i) => {
          const bh = (d.count / max) * (h - 4);
          return <rect key={d.date} x={i * (bw + gap)} y={h - bh} width={bw} height={Math.max(bh, d.count ? 2 : 0.5)} rx={1} className={d.count ? 'fill-brand' : 'fill-gray-200'}><title>{`${d.date}: ${d.count}`}</title></rect>;
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-[10.5px] text-gray-400"><span>{data[0]?.date}</span><span>peak {max}/day</span><span>{data[data.length - 1]?.date}</span></figcaption>
    </figure>
  );
}

export function AnalyticsView() {
  const { say } = useClips();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true; setError('');
    api.overview(days).then((o) => { if (live) setData(o); }).catch((e) => { if (live) setError(errorMessage(e)); });
    return () => { live = false; };
  }, [days]);

  const download = useCallback(async () => {
    setBusy(true);
    try {
      const blob = await api.reportPdf(days, `Clips activity, last ${days} days`);
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = 'clips-report.pdf'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      say('Report downloaded.');
    } catch (e) { say(errorMessage(e), 'err'); } finally { setBusy(false); }
  }, [days, say]);

  return (
    <>
      <PageHeader title="Analytics" hideCreate>
        <label className="flex items-center gap-2 text-xs text-gray-500">Period
          <select className="rounded-lg border border-input bg-white px-2 py-1.5 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </label>
        <Button variant="outline" onClick={() => void download()} disabled={busy || !data}><Download className="mr-1.5 h-4 w-4" aria-hidden="true" />{busy ? 'Preparing...' : 'Download PDF'}</Button>
      </PageHeader>
      <div className="mt-4 flex-1 space-y-6 overflow-y-auto pb-6" aria-busy={!data && !error}>
        {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        {data ? (
          <>
            <p className="text-xs text-gray-500" data-testid="scope">{data.scope === 'organization' ? 'Everyone in your organization' : 'Your own clips'}. Views are playback links issued; watch time is not measured.</p>
            <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {([['Clips', data.totals.clips], ['Ready', data.totals.ready], ['Storage', formatBytes(data.totals.storageBytes)], [`New (${days}d)`, data.totals.clipsInPeriod], [`Views (${days}d)`, data.totals.viewsInPeriod]] as [string, string | number][]).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-gray-200/80 bg-white p-4"><dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{k}</dt><dd className="mt-1 text-2xl font-bold text-gray-900" data-stat={k}>{v}</dd></div>
              ))}
            </dl>
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-xl border border-gray-200/80 bg-white p-4"><h2 className="mb-2 text-sm font-bold text-gray-800">Clips created per day</h2><Bars data={data.clipsPerDay} label="Clips created per day" /></section>
              <section className="rounded-xl border border-gray-200/80 bg-white p-4"><h2 className="mb-2 text-sm font-bold text-gray-800">Views per day</h2><Bars data={data.viewsPerDay} label="Views per day" /></section>
            </div>
            <section className="rounded-xl border border-gray-200/80 bg-white p-4">
              <h2 className="mb-2 text-sm font-bold text-gray-800">Most watched</h2>
              {data.topClips.length ? <ol className="space-y-1 text-sm">{data.topClips.map((c) => <li key={c.id} className="flex justify-between gap-3"><span className="truncate">{c.title}</span><span className="text-gray-500">{c.views}</span></li>)}</ol> : <p className="text-sm text-gray-500">No playback in this period.</p>}
            </section>
          </>
        ) : !error ? <p className="text-sm text-gray-500">Loading...</p> : null}
      </div>
    </>
  );
}
