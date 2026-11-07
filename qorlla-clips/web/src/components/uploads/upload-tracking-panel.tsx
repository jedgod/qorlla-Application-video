'use client';

import { AlertCircle, CheckCircle2, CloudUpload, Loader2, RotateCcw, Video, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useUploads, type UploadJob } from './uploads-provider';

const LABEL: Record<UploadJob['phase'], string> = {
  INITIALIZING: 'Opening upload…',
  UPLOADING: 'Uploading…',
  ASSEMBLING: 'Finishing…',
  SUCCESS: 'Saved',
  FAILED: 'Upload failed',
  CANCELED: 'Canceled',
};

/** Bottom-right queue of uploads: live progress, cancel while running, retry after a failure. */
export function UploadTrackingPanel() {
  const { jobs, cancel, retry, dismiss, dismissAll } = useUploads();
  if (jobs.length === 0) return null;
  const running = jobs.filter((j) => ['INITIALIZING', 'UPLOADING', 'ASSEMBLING'].includes(j.phase)).length;

  return (
    <section aria-label="Uploads" className="fixed bottom-6 right-6 z-40 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl animate-in slide-in-from-bottom-4">
      <header className="flex select-none items-center justify-between bg-gray-900 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <CloudUpload className="h-4 w-4 text-blue-400" aria-hidden="true" />
          <span className="text-xs font-bold uppercase tracking-wide">Uploads</span>
          {running ? <span className="rounded-full bg-blue-600 px-1.5 text-[10px] font-extrabold" aria-label={`${running} in progress`}>{running}</span> : null}
        </div>
        <button type="button" onClick={dismissAll} aria-label="Close upload panel" className="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"><X className="h-4 w-4" /></button>
      </header>

      <ul className="max-h-[360px] space-y-3 divide-y divide-gray-50 overflow-y-auto p-3">
        {jobs.map((job) => {
          const busy = ['INITIALIZING', 'UPLOADING', 'ASSEMBLING'].includes(job.phase);
          const ok = job.phase === 'SUCCESS', failed = job.phase === 'FAILED', canceled = job.phase === 'CANCELED';
          return (
            <li key={job.id} data-upload-id={job.id} data-phase={job.phase} className="flex flex-col gap-2 pt-3 first:pt-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className={cn('shrink-0 rounded-xl p-2', ok ? 'bg-green-50 text-green-600' : failed ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600')}><Video className="h-4 w-4" aria-hidden="true" /></div>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate pr-2 text-xs font-semibold text-gray-900">{job.filename}</span>
                    <span className="mt-0.5 text-[10.5px] font-medium text-gray-400">{job.sizeLabel}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 pt-0.5">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin text-blue-500" aria-hidden="true" /> : null}
                  {ok ? <CheckCircle2 className="h-4 w-4 text-green-500" aria-hidden="true" /> : null}
                  {failed ? <AlertCircle className="h-4 w-4 text-red-500" aria-hidden="true" /> : null}
                  {failed ? <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => retry(job.id)} aria-label={`Retry ${job.filename}`}><RotateCcw className="h-3.5 w-3.5" /></Button> : null}
                  {busy ? <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => cancel(job.id)}>Cancel</Button> : <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => dismiss(job.id)} aria-label={`Dismiss ${job.filename}`}><X className="h-3.5 w-3.5" /></Button>}
                </div>
              </div>

              <div className="flex w-full flex-col">
                <div role="progressbar" aria-label={`Upload of ${job.filename}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.percent} className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <div className={cn('h-full rounded-full transition-all duration-300 ease-out', ok ? 'bg-green-500' : failed ? 'bg-red-500' : canceled ? 'bg-gray-300' : 'bg-brand')} style={{ width: `${job.percent}%` }} />
                </div>
                <div className="mt-1.5 flex items-center justify-between px-0.5 text-[10px] font-bold">
                  <span className={cn('uppercase tracking-wider', ok ? 'text-green-600' : failed ? 'text-red-500' : 'text-gray-400')}>{LABEL[job.phase]}</span>
                  <span className="font-extrabold text-gray-600">{job.percent}%</span>
                </div>
                {job.error ? <p role="alert" className="mt-1 rounded-md border border-red-100/50 bg-red-50/50 p-1.5 text-[10px] font-medium text-red-600">{job.error}</p> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
