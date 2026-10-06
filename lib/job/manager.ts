/**
 * Job manager (service worker): starts/cancels jobs, owns the in-memory job table, persists job
 * state to chrome.storage.session, broadcasts `job/update` to extension pages (throttled), keeps
 * the action badge and completion notifications up to date, enforces the managed policy, and
 * caches a per-site "preview" worker tab so the preview's collect / tree requests are fast.
 */
import { PDFDocument } from 'pdf-lib';
import { saveBytes } from '../download';
import type { SwBroadcast, SwToWorker, WorkerToSw } from '../messages';
import { buildOutline, concatPdfs, finalizePdf, findSectionStartPages, readOutline } from '../pdf/merge';
import { zipFiles } from '../pdf/zip';
import { hasSiteAccess } from '../permissions';
import { DebuggerUnavailableError, detachAll, printTabToPdf, toPrintParams } from '../render/cdp';
import { liveRenderPages } from '../render/liveRender';
import { closeOrphanTabs, closeTabQuietly, ensureWorker, openWorkerTab, unregisterOrphan } from '../render/tabs';
import { RpcError, callWorker } from '../rpc';
import { applyPolicyToOptions, loadPolicy, loadSettings, normalizeOptions } from '../settings';
import type {
  ContentType,
  ExportJobState,
  ExportMode,
  ExportRequest,
  JobStatus,
  ManagedPolicy,
  PageRef,
  Settings,
  SiteInfo,
  TreeNode,
} from '../types';
import { encodeRequestParam } from '../util/base64';
import { applyPolicyToPages, isBlockedSpace, maxPagesError, runJob, type RunnerDeps } from './runner';
import * as store from './store';

const BROADCAST_INTERVAL_MS = 200;
const PREVIEW_TAB_IDLE_MS = 2 * 60_000;
const CANCEL_WAIT_MS = 2500;
const BADGE_COLOR = '#0C66E4';
const NOTIFICATION_PREFIX = 'cfp-job:';
const TERMINAL: ReadonlySet<JobStatus> = new Set(['done', 'error', 'cancelled']);
const MODES: ReadonlySet<ExportMode> = new Set(['current', 'subtree', 'folder', 'linked', 'selection', 'space']);
const CONTENT_TYPES: ReadonlySet<ContentType> = new Set(['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed']);

interface RunningJob {
  job: ExportJobState;
  controller: AbortController;
  settings: Settings;
  done: Promise<void>;
}

const running = new Map<string, RunningJob>();

// ───────────────────────────── service-worker keepalive ─────────────────────────────
// Chrome stops an idle service worker after ~30 s without extension events or API calls. Some
// export phases can be silent for longer (waiting for a "Save as" dialog, slow live renders,
// huge print jobs), so while a job runs a trivial extension API call resets the idle timer.
const KEEPALIVE_MS = 20_000;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function updateKeepAlive(): void {
  if (running.size > 0 && keepAliveTimer === undefined) {
    keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => undefined);
    }, KEEPALIVE_MS);
  } else if (running.size === 0 && keepAliveTimer !== undefined) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  }
}
/** Finished jobs of this service-worker instance (newest state; the store has the rest). */
const finished = new Map<string, ExportJobState>();
const workerListeners = new Map<string, Set<(msg: WorkerToSw) => void>>();

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

function codedError(message: string, code: string): RpcError {
  return new RpcError(message, code);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ───────────────────────────── startup ─────────────────────────────

let readyPromise: Promise<void> | null = null;

/**
 * Runs once per service-worker instance before anything else: closes tabs and debugger sessions
 * left behind by a previous instance and marks interrupted jobs as failed.
 */
export function init(): Promise<void> {
  readyPromise ??= (async () => {
    await closeOrphanTabs().catch(() => 0);
    await detachAll().catch(() => undefined);
    try {
      for (const job of await store.listJobs()) {
        if (isTerminal(job.status)) continue;
        const message = 'The export was interrupted because the browser stopped the extension in the background. Please try again.';
        await store.saveJob({
          ...job,
          status: 'error',
          message,
          finishedAt: Date.now(),
          errors: [...job.errors, { pageId: '', title: '', message, severity: 'fatal' }],
        });
      }
    } catch {
      /* session storage unavailable */
    }
    await setBadge('');
  })();
  return readyPromise;
}

// ───────────────────────────── broadcast / persistence / badge ─────────────────────────────

const lastBroadcast = new Map<string, number>();
const pendingBroadcast = new Map<string, ReturnType<typeof setTimeout>>();

function snapshot(job: ExportJobState): ExportJobState {
  return structuredClone(job);
}

function sendUpdate(job: ExportJobState): void {
  lastBroadcast.set(job.id, Date.now());
  const snap = snapshot(job);
  store.saveJob(snap).catch(() => undefined);
  const msg: SwBroadcast = { type: 'job/update', job: snap };
  // Rejects with "Receiving end does not exist" when no extension page is open.
  chrome.runtime.sendMessage(msg).catch(() => undefined);
  void updateBadge();
}

/** Throttled to ~5 updates/s per job; terminal states are always sent immediately. */
function publish(job: ExportJobState): void {
  const now = Date.now();
  const elapsed = now - (lastBroadcast.get(job.id) ?? 0);
  const pending = pendingBroadcast.get(job.id);
  if (isTerminal(job.status) || elapsed >= BROADCAST_INTERVAL_MS) {
    if (pending) {
      clearTimeout(pending);
      pendingBroadcast.delete(job.id);
    }
    sendUpdate(job);
    return;
  }
  if (pending) return;
  pendingBroadcast.set(
    job.id,
    setTimeout(() => {
      pendingBroadcast.delete(job.id);
      sendUpdate(job);
    }, BROADCAST_INTERVAL_MS - elapsed),
  );
}

/** Rough overall completion used for the badge. */
export function jobPercent(job: ExportJobState): number {
  const { done, total } = job.progress;
  const frac = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  switch (job.status) {
    case 'collecting':
      return 2;
    case 'fetching':
      return Math.round(5 + 55 * frac);
    case 'rendering':
      return Math.round(60 + 30 * frac);
    case 'merging':
      return 92;
    default:
      return 100;
  }
}

let badgeText = '';
async function setBadge(text: string): Promise<void> {
  if (text === badgeText) return;
  badgeText = text;
  try {
    if (text) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await chrome.action.setBadgeText({ text });
  } catch {
    /* action API unavailable (tests) */
  }
}

function updateBadge(): Promise<void> {
  let newest: ExportJobState | undefined;
  for (const r of running.values()) {
    if (isTerminal(r.job.status)) continue;
    if (!newest || r.job.createdAt > newest.createdAt) newest = r.job;
  }
  return setBadge(newest ? `${Math.min(99, jobPercent(newest))}%` : '');
}

// ───────────────────────────── notifications ─────────────────────────────

async function notify(job: ExportJobState, settings: Settings): Promise<void> {
  if (!settings.notifyOnComplete || job.printDialog) return;
  let title: string;
  let message: string;
  if (job.status === 'done' && job.result) {
    const skipped = job.errors.filter((e) => e.severity === 'skipped').length;
    title = 'PDF export finished';
    message = job.result.filename + (skipped ? `\n${skipped} page${skipped === 1 ? '' : 's'} skipped` : '');
  } else if (job.status === 'error') {
    title = 'PDF export failed';
    message = job.message ?? 'Something went wrong.';
  } else {
    return;
  }
  try {
    await chrome.notifications.create(NOTIFICATION_PREFIX + job.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icons/128.png'),
      title,
      message,
      priority: 0,
    });
  } catch {
    /* notifications disabled by the user or OS */
  }
}

/** notifications.onClicked: show the file in its folder (or open the job's progress page). */
export async function handleNotificationClick(notificationId: string): Promise<void> {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const jobId = notificationId.slice(NOTIFICATION_PREFIX.length);
  chrome.notifications.clear(notificationId).catch(() => undefined);
  const job = await getJob(jobId);
  if (job?.result?.downloadId !== undefined) {
    try {
      chrome.downloads.show(job.result.downloadId);
      return;
    } catch {
      /* download removed from history */
    }
  }
  if (job) await openJobPage(job.id);
}

// ───────────────────────────── worker notifications ─────────────────────────────

/** Route `worker/progress` / `worker/throttled` from worker tabs to the job that owns them. */
export function handleWorkerMessage(msg: WorkerToSw): void {
  if (msg.type === 'worker/ready') return;
  const listeners = workerListeners.get(msg.jobId);
  if (!listeners) return;
  for (const l of listeners) {
    try {
      l(msg);
    } catch {
      /* a listener must never break routing */
    }
  }
}

function subscribeWorker(jobId: string, listener: (msg: WorkerToSw) => void): () => void {
  let set = workerListeners.get(jobId);
  if (!set) workerListeners.set(jobId, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) workerListeners.delete(jobId);
  };
}

// ───────────────────────────── preview worker tab cache ─────────────────────────────

interface PreviewTab {
  key: string;
  tab: Promise<number>;
  busy: number;
  timer?: ReturnType<typeof setTimeout>;
}
const previewTabs = new Map<string, PreviewTab>();

const siteKey = (site: SiteInfo) => site.baseUrl.replace(/\/+$/, '');

function scheduleIdleClose(entry: PreviewTab): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entry.busy > 0 || previewTabs.get(entry.key) !== entry) return;
    previewTabs.delete(entry.key);
    entry.tab.then((id) => closeTabQuietly(id), () => undefined);
  }, PREVIEW_TAB_IDLE_MS);
}

function dropPreviewTab(entry: PreviewTab): void {
  if (entry.timer) clearTimeout(entry.timer);
  if (previewTabs.get(entry.key) === entry) previewTabs.delete(entry.key);
}

/** Runs `fn` against the cached preview worker tab for `site` (opened on demand). */
async function withPreviewTab<T>(site: SiteInfo, nearTabId: number | undefined, fn: (tabId: number) => Promise<T>): Promise<T> {
  const key = siteKey(site);
  for (let attempt = 0; ; attempt++) {
    let entry = previewTabs.get(key);
    const wasCached = !!entry;
    if (!entry) {
      entry = { key, tab: openWorkerTab(site, nearTabId), busy: 0 };
      previewTabs.set(key, entry);
    }
    const current = entry;
    if (current.timer) clearTimeout(current.timer);
    current.busy++;
    let tabId: number;
    try {
      tabId = await current.tab;
      await ensureWorker(tabId);
    } catch (e) {
      current.busy--;
      dropPreviewTab(current);
      current.tab.then((id) => closeTabQuietly(id), () => undefined);
      // A cached tab may have been closed by the user meanwhile: retry once with a fresh tab.
      if (wasCached && attempt === 0) continue;
      throw e;
    }
    try {
      return await fn(tabId);
    } finally {
      current.busy--;
      if (previewTabs.get(key) === current && current.busy === 0) scheduleIdleClose(current);
    }
  }
}

/** Hands the cached preview tab over to a job (the job closes it when done). */
async function takePreviewTab(site: SiteInfo): Promise<number | undefined> {
  const entry = previewTabs.get(siteKey(site));
  if (!entry || entry.busy > 0) return undefined;
  dropPreviewTab(entry);
  try {
    const tabId = await entry.tab;
    await ensureWorker(tabId);
    return tabId;
  } catch {
    entry.tab.then((id) => closeTabQuietly(id), () => undefined);
    return undefined;
  }
}

// ───────────────────────────── validation / policy ─────────────────────────────

function validateRequest(request: ExportRequest): void {
  const bad = (what: string) => codedError(`Invalid export request (${what}).`, 'BAD_REQUEST');
  if (!request || typeof request !== 'object') throw bad('missing');
  if (!MODES.has(request.mode)) throw bad('mode');
  const site = request.site;
  if (!site || typeof site.origin !== 'string' || typeof site.baseUrl !== 'string') throw bad('site');
  let origin: URL;
  try {
    origin = new URL(site.origin);
  } catch {
    throw bad('site');
  }
  if ((origin.protocol !== 'https:' && origin.protocol !== 'http:') || origin.origin !== site.origin) throw bad('site');
  if (!site.baseUrl.startsWith(site.origin)) throw bad('site');
  if (!request.root || typeof request.root.id !== 'string' || !request.root.id || !CONTENT_TYPES.has(request.root.type)) {
    throw bad('root');
  }
}

async function requireAccess(site: SiteInfo): Promise<void> {
  if (!(await hasSiteAccess(site.origin))) {
    throw codedError(`Fast PDF Export needs access to ${new URL(site.origin).host} first.`, 'NO_ACCESS');
  }
}

function blockedError(): RpcError {
  return codedError('Exporting from this space is blocked by your administrator.', 'BLOCKED');
}

// ───────────────────────────── public API ─────────────────────────────

export function previewUrl(request: ExportRequest): string {
  return chrome.runtime.getURL('/preview.html') + '?req=' + encodeRequestParam(request);
}

async function openTabNear(url: string, nearTabId?: number): Promise<number> {
  let props: chrome.tabs.CreateProperties = { url, active: true };
  if (nearTabId !== undefined) {
    try {
      const near = await chrome.tabs.get(nearTabId);
      props = { ...props, windowId: near.windowId, index: near.index + 1, openerTabId: nearTabId };
    } catch {
      /* source tab closed */
    }
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create(props);
  } catch {
    tab = await chrome.tabs.create({ url, active: true });
  }
  if (tab.id === undefined) throw new Error('Could not open the export page.');
  return tab.id;
}

/** Opens the preview / progress page for a request (FR-7, permission grant, FR-16 guard). */
export async function openPreview(request: ExportRequest): Promise<{ tabId: number }> {
  return { tabId: await openTabNear(previewUrl(request), request.sourceTabId) };
}

/** Opens the progress page of a running or finished job. */
export async function openJobPage(jobId: string, nearTabId?: number): Promise<number> {
  return openTabNear(chrome.runtime.getURL(`/preview.html?job=${encodeURIComponent(jobId)}`), nearTabId);
}

/** UiToSw 'collect': resolve the page list for the preview (blocked spaces removed). */
export async function collectForPreview(
  request: ExportRequest,
  nearTabId?: number,
): Promise<{ pages: PageRef[]; warnings: string[] }> {
  await init();
  validateRequest(request);
  await requireAccess(request.site);
  const policy = await loadPolicy();
  if (isBlockedSpace(request.root.spaceKey, policy)) throw blockedError();
  const res = await withPreviewTab(request.site, nearTabId ?? request.sourceTabId, (tabId) =>
    callWorker(tabId, { type: 'worker/collect', request }),
  );
  const filtered = applyPolicyToPages(res.pages, policy, request.root.spaceKey);
  const warnings = [...res.warnings];
  if (filtered.errors.length) {
    const n = filtered.errors.length;
    warnings.push(`${n} page${n === 1 ? ' is' : 's are'} in spaces blocked by your administrator and will be left out.`);
  }
  return { pages: filtered.pages, warnings };
}

/** UiToSw 'tree/children': lazy tree for the manual picker. */
export async function treeChildren(
  msg: { site: SiteInfo; spaceKey: string; spaceId?: string; parent?: { id: string; type: TreeNode['type'] } },
  nearTabId?: number,
): Promise<TreeNode[]> {
  await init();
  await requireAccess(msg.site);
  const policy = await loadPolicy();
  if (isBlockedSpace(msg.spaceKey, policy)) throw blockedError();
  return withPreviewTab(msg.site, nearTabId, (tabId) =>
    callWorker(tabId, {
      type: 'worker/children',
      site: msg.site,
      spaceKey: msg.spaceKey,
      spaceId: msg.spaceId,
      parent: msg.parent,
    }),
  );
}

/** Resolve a Confluence content URL (context menu) through the preview worker tab. */
export async function resolveContentUrl(site: SiteInfo, url: string, nearTabId?: number) {
  await init();
  await requireAccess(site);
  return withPreviewTab(site, nearTabId, (tabId) => callWorker(tabId, { type: 'worker/resolve', site, url }));
}

async function countPdfPages(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

async function fallbackPrint(tabId: number): Promise<void> {
  // The tab now belongs to the user: it must survive orphan cleanup.
  await unregisterOrphan(tabId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  await chrome.scripting.executeScript({
    target: { tabId },
    // Deferred so executeScript returns instead of blocking until the dialog closes.
    func: () => {
      setTimeout(() => window.print(), 150);
    },
  });
}

function buildDeps(job: ExportJobState, signal: AbortSignal, settings: Settings, policy: ManagedPolicy): RunnerDeps {
  return {
    callWorker: (tabId, msg) => callWorker(tabId, msg as SwToWorker) as never,
    subscribeWorker,
    openWorkerTab: async (site, nearTabId) => (await takePreviewTab(site)) ?? openWorkerTab(site, nearTabId),
    closeTabQuietly,
    toPrintParams,
    printTabToPdf: (tabId, params, s) => printTabToPdf(tabId, params, s),
    isDebuggerUnavailable: (e) =>
      e instanceof DebuggerUnavailableError || (e as { name?: string } | null)?.name === 'DebuggerUnavailableError',
    // Detaching everything would break other jobs that are printing right now.
    detachAll: () => ([...running.values()].some((r) => r.job.id !== job.id && !isTerminal(r.job.status)) ? Promise.resolve() : detachAll()),
    fallbackPrint,
    liveRenderPages,
    concatPdfs,
    findSectionStartPages,
    finalizePdf,
    buildOutline,
    readOutline,
    countPdfPages,
    zipFiles,
    saveBytes,
    settings,
    policy,
    version: chrome.runtime.getManifest().version,
    now: () => Date.now(),
    signal,
    onUpdate: publish,
  };
}

/** UiToSw 'job/start'. Validates, applies the managed policy and runs the job in the background. */
export async function startJob(request: ExportRequest, pages?: PageRef[]): Promise<string> {
  await init();
  validateRequest(request);
  await requireAccess(request.site);
  const [settings, policy] = await Promise.all([loadSettings(), loadPolicy()]);
  if (isBlockedSpace(request.root.spaceKey, policy)) throw blockedError();
  const options = applyPolicyToOptions(normalizeOptions(request.options, settings.defaults), policy);

  let initialPages: PageRef[] = [];
  if (pages?.length) {
    const kept = applyPolicyToPages(pages, policy, request.root.spaceKey).pages;
    const tooMany = maxPagesError(kept.length, policy);
    if (tooMany) throw codedError(tooMany, 'MAX_PAGES');
    if (!kept.length) throw blockedError();
    initialPages = pages; // the runner records the blocked ones in the error summary
  }

  const job: ExportJobState = {
    id: crypto.randomUUID(),
    request: { ...request, options },
    pages: initialPages,
    status: 'collecting',
    message: 'Starting',
    progress: { done: 0, total: 0 },
    errors: [],
    createdAt: Date.now(),
  };
  const controller = new AbortController();
  const entry: RunningJob = { job, controller, settings, done: Promise.resolve() };
  running.set(job.id, entry);
  updateKeepAlive();
  sendUpdate(job);

  entry.done = runJob(job, buildDeps(job, controller.signal, settings, policy))
    .catch((e: unknown) => {
      // runJob handles its own errors; this is a last line of defence.
      if (!isTerminal(job.status)) {
        job.status = 'error';
        job.message = errorMessage(e);
        job.finishedAt = Date.now();
      }
    })
    .finally(() => onJobFinished(entry));
  return job.id;
}

async function onJobFinished(entry: RunningJob): Promise<void> {
  const { job } = entry;
  running.delete(job.id);
  updateKeepAlive();
  finished.set(job.id, job);
  // Keep memory bounded: the store keeps the last jobs anyway.
  while (finished.size > store.MAX_STORED_JOBS) finished.delete(finished.keys().next().value!);
  workerListeners.delete(job.id);
  sendUpdate(job);
  const timer = pendingBroadcast.get(job.id);
  if (timer) clearTimeout(timer);
  pendingBroadcast.delete(job.id);
  lastBroadcast.delete(job.id);
  await store.pruneJobs(store.MAX_STORED_JOBS, running.keys()).catch(() => undefined);
  await notify(job, entry.settings);
}

/** UiToSw 'job/cancel'. Resolves once the job stopped (or after ~2.5 s). */
export async function cancelJob(jobId: string): Promise<void> {
  const entry = running.get(jobId);
  if (!entry) return;
  entry.controller.abort();
  await Promise.race([entry.done, new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))]);
}

export async function getJob(jobId: string): Promise<ExportJobState | null> {
  const live = running.get(jobId)?.job ?? finished.get(jobId);
  if (live) return snapshot(live);
  try {
    return await store.loadJob(jobId);
  } catch {
    return null;
  }
}

/** Most recent jobs, newest first. */
export async function listJobs(): Promise<ExportJobState[]> {
  let stored: ExportJobState[] = [];
  try {
    stored = await store.listJobs();
  } catch {
    stored = [];
  }
  const byId = new Map(stored.map((j) => [j.id, j]));
  for (const j of [...finished.values(), ...[...running.values()].map((r) => r.job)]) byId.set(j.id, snapshot(j));
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, store.MAX_STORED_JOBS);
}

export function hasRunningJobs(): boolean {
  return running.size > 0;
}
