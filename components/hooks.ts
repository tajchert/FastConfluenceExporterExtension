import { useEffect, useRef, useState } from 'preact/hooks';
import { showDownloadItem } from '../lib/download';
import type { SwBroadcast } from '../lib/messages';
import { callSw } from '../lib/rpc';
import type { ExportJobState } from '../lib/types';
import { isJobActive } from './logic';

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  return 'Unexpected error';
}

function isJobUpdate(msg: unknown): msg is SwBroadcast {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === 'job/update' &&
    typeof (msg as { job?: { id?: unknown } }).job?.id === 'string'
  );
}

/** Subscribes to `job/update` broadcasts. Returns an unsubscribe function. */
export function onJobUpdate(cb: (job: ExportJobState) => void): () => void {
  const listener = (msg: unknown): undefined => {
    if (isJobUpdate(msg)) cb(msg.job);
    return undefined;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export interface JobView {
  job: ExportJobState | null;
  /** The SW no longer knows this job (e.g. browser restarted). */
  missing: boolean;
  loading: boolean;
}

/**
 * Live view of one job: `job/update` broadcasts plus a `job/get` poll as a fallback
 * (broadcasts are lost while the SW restarts). Polling stops once the job is finished.
 */
export function useJob(jobId: string | null, pollMs = 2000): JobView {
  const [state, setState] = useState<JobView>({ job: null, missing: false, loading: !!jobId });
  const latest = useRef<ExportJobState | null>(null);

  useEffect(() => {
    latest.current = null;
    if (!jobId) {
      setState({ job: null, missing: false, loading: false });
      return;
    }
    setState({ job: null, missing: false, loading: true });
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;

    const accept = (job: ExportJobState) => {
      if (disposed || job.id !== jobId) return;
      latest.current = job;
      setState({ job, missing: false, loading: false });
    };

    const poll = async () => {
      try {
        const job = await callSw({ type: 'job/get', jobId });
        if (disposed) return;
        if (job) {
          misses = 0;
          accept(job);
        } else if (++misses >= 2) {
          // Unknown to the SW (twice in a row): keep the last known state but flag it.
          setState((s) => ({ job: s.job, missing: true, loading: false }));
          return;
        }
      } catch {
        // The SW may be restarting; keep polling.
      }
      if (disposed) return;
      if (latest.current && !isJobActive(latest.current.status)) return;
      timer = setTimeout(poll, pollMs);
    };

    const off = onJobUpdate(accept);
    void poll();
    return () => {
      disposed = true;
      off();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, pollMs]);

  return state;
}

/** Opens (or focuses) the extension's preview page for a running/finished job. */
export async function openJobTab(jobId: string): Promise<void> {
  const url = chrome.runtime.getURL(`/preview.html?job=${encodeURIComponent(jobId)}`);
  await chrome.tabs.create({ url });
}

/** Reveals a finished download in the OS file manager. Returns false if Chrome no longer has it. */
export function showDownload(downloadId: number | undefined): Promise<boolean> {
  return showDownloadItem(downloadId);
}

/** Shortcut configuration page for the current Chromium browser. */
export function shortcutsPageUrl(): string {
  const ua = navigator.userAgent;
  if (/\bEdg\//.test(ua)) return 'edge://extensions/shortcuts';
  if (/\bOPR\//.test(ua)) return 'opera://extensions/shortcuts';
  return 'chrome://extensions/shortcuts';
}

export async function openShortcutsPage(): Promise<void> {
  try {
    await chrome.tabs.create({ url: shortcutsPageUrl() });
  } catch {
    await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }
}
