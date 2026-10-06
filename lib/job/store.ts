/**
 * chrome.storage.session persistence for jobs and the pending "start after permission grant"
 * action. (Tabs opened by the service worker are tracked by lib/render/tabs.ts.)
 *
 * Session storage is in-memory, cleared when the browser restarts, and only readable by extension
 * pages and the service worker (TRUSTED_CONTEXTS is the default access level).
 */
import type { ExportJobState, ExportRequest, PageRef } from '../types';

const JOB_PREFIX = 'job:';
const PENDING_KEY = 'pendingStart';
export const MAX_STORED_JOBS = 10;
/** A pending start older than this is ignored (the user walked away from the prompt). */
export const PENDING_START_TTL_MS = 5 * 60_000;

export interface PendingStart {
  request: ExportRequest;
  /** Pruned page list when the start came from the preview. */
  pages?: PageRef[];
  createdAt: number;
}

const session = () => chrome.storage.session;

export async function saveJob(job: ExportJobState): Promise<void> {
  await session().set({ [JOB_PREFIX + job.id]: job });
}

export async function loadJob(id: string): Promise<ExportJobState | null> {
  const key = JOB_PREFIX + id;
  const res = await session().get(key);
  return (res[key] as ExportJobState | undefined) ?? null;
}

/** All stored jobs, newest first. */
export async function listJobs(): Promise<ExportJobState[]> {
  const all = await session().get(null);
  const jobs: ExportJobState[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(JOB_PREFIX) && value && typeof value === 'object') jobs.push(value as ExportJobState);
  }
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteJob(id: string): Promise<void> {
  await session().remove(JOB_PREFIX + id);
}

/** Keep only the newest `keep` jobs. Running jobs are never removed. */
export async function pruneJobs(keep: number = MAX_STORED_JOBS, runningIds: Iterable<string> = []): Promise<void> {
  const running = new Set(runningIds);
  const jobs = await listJobs();
  const stale = jobs.slice(keep).filter((j) => !running.has(j.id));
  if (stale.length) await session().remove(stale.map((j) => JOB_PREFIX + j.id));
}

export async function getPendingStart(now: number = Date.now()): Promise<PendingStart | null> {
  const res = await session().get(PENDING_KEY);
  const p = res[PENDING_KEY] as PendingStart | undefined;
  if (!p || typeof p !== 'object' || !p.request || typeof p.createdAt !== 'number') return null;
  if (now - p.createdAt > PENDING_START_TTL_MS || p.createdAt > now + 60_000) {
    await clearPendingStart();
    return null;
  }
  return p;
}

export async function setPendingStart(request: ExportRequest, pages?: PageRef[]): Promise<void> {
  const value: PendingStart = { request, createdAt: Date.now(), ...(pages ? { pages } : {}) };
  await session().set({ [PENDING_KEY]: value });
}

export async function clearPendingStart(): Promise<void> {
  await session().remove(PENDING_KEY);
}

/** Atomically-enough read and clear (single SW instance; storage calls are serialized there). */
export async function takePendingStart(now: number = Date.now()): Promise<PendingStart | null> {
  const p = await getPendingStart(now);
  if (p) await clearPendingStart();
  return p;
}
