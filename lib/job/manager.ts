/**
 * Job manager (service worker): starts/cancels jobs, owns the in-memory job table, persists job
 * state to chrome.storage.session, broadcasts `job/update` to extension pages (throttled), keeps
 * the action badge and completion notifications up to date, enforces the managed policy, runs
 * the preview's page collections (over a UI port) and caches a per-site "preview" worker tab so
 * the preview's collect / tree requests are fast.
 */
import { saveBytes, showDownloadItem } from '../download';
import type { PendingStartPayload, SwBroadcast, SwToWorker, UiPortEvent, UiPortRequest, WorkerToSw } from '../messages';
import { concatPdfs, finalizeExport, finalizePdf } from '../pdf/merge';
import { zipFiles } from '../pdf/zip';
import { hasSiteAccess } from '../permissions';
import { DebuggerUnavailableError, createPrintSession, detachAll, toPrintParams } from '../render/cdp';
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
import { jobPercent } from './progress';
import { BLOCKED_MESSAGE, applyPolicyToPages, isBlockedSpace, maxPagesError, runJob, type RunnerDeps } from './runner';
import * as store from './store';
import { runWorkerOp } from './workerOp';

export { jobPercent };

const BROADCAST_INTERVAL_MS = 200;
const PREVIEW_TAB_IDLE_MS = 2 * 60_000;
/** After the last extension page went away, idle helper tabs are closed after this grace time. */
const NO_UI_GRACE_MS = 5000;
/** A preview reuses a collection made this recently for the same request (the popup's count). */
const COLLECT_CACHE_TTL_MS = 90_000;
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

interface PreviewTab {
  key: string;
  tab: Promise<number>;
  busy: number;
  timer?: ReturnType<typeof setTimeout>;
}
const previewTabs = new Map<string, PreviewTab>();

interface ActiveCollect {
  controller: AbortController;
}
const activeCollects = new Map<string, ActiveCollect>();
const uiPorts = new Set<chrome.runtime.Port>();

// ───────────────────────────── service-worker keepalive ─────────────────────────────
// Chrome stops an idle service worker after ~30 s without extension events or API calls. Some
// phases can be silent for longer (waiting for a "Save as" dialog, slow live renders, huge print
// jobs, 429 back-off during a preview collection), so while a job or a collection runs — or a
// cached helper tab waits for its idle close — a trivial extension API call resets the idle
// timer. It does not lift Chrome's 5-minute limit for a single event or API call: long worker
// operations therefore run in the background (lib/job/workerOp.ts).
const KEEPALIVE_MS = 20_000;
let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

function updateKeepAlive(): void {
  const needed = running.size > 0 || activeCollects.size > 0 || previewTabs.size > 0;
  if (needed && keepAliveTimer === undefined) {
    keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => undefined);
    }, KEEPALIVE_MS);
  } else if (!needed && keepAliveTimer !== undefined) {
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
 * left behind by a previous instance and marks interrupted jobs as failed (their stored page
 * list lets "Try again" start them over without collecting again).
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
          interrupted: true,
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

/**
 * What is persisted and broadcast up to five times a second: no page list (the UI only needs
 * the count) and no custom CSS. A 3,000-page export would otherwise serialize about 1 MB per
 * update, and a few stored jobs would fill session storage and break every other session write.
 */
export function slimJob(job: ExportJobState): ExportJobState {
  const { customCss: _customCss, ...options } = job.request.options;
  return structuredClone({
    ...job,
    request: { ...job.request, options: { ...options, customCss: '' } },
    pages: [],
    pageCount: job.pageCount ?? job.pages.length,
  });
}

function sendUpdate(job: ExportJobState): void {
  lastBroadcast.set(job.id, Date.now());
  const snap = slimJob(job);
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
  // downloads.show() never throws for a missing item (it only sets runtime.lastError): check first.
  if (await showDownloadItem(job?.result?.downloadId)) return;
  if (job) await openJobPage(job.id);
}

// ───────────────────────────── worker notifications ─────────────────────────────

/** Route `worker/progress` / `worker/throttled` / `worker/done` from worker tabs to their job or collection. */
export function handleWorkerMessage(msg: WorkerToSw): void {
  if (msg.type === 'worker/ready') return;
  const listeners = workerListeners.get(msg.jobId);
  if (!listeners) return;
  for (const l of [...listeners]) {
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
    if (!set!.size && workerListeners.get(jobId) === set) workerListeners.delete(jobId);
  };
}

// ───────────────────────────── preview worker tab cache ─────────────────────────────

const siteKey = (site: SiteInfo) => site.baseUrl.replace(/\/+$/, '');

/**
 * Cache key of a helper tab: the site, and whether the export started from an incognito tab (an
 * incognito session has its own cookies, so a regular-profile tab must never serve it).
 */
async function previewKey(site: SiteInfo, nearTabId: number | undefined): Promise<string> {
  let incognito = false;
  if (nearTabId !== undefined) {
    try {
      incognito = !!(await chrome.tabs.get(nearTabId)).incognito;
    } catch {
      /* tab gone */
    }
  }
  return `${siteKey(site)}${incognito ? '|incognito' : ''}`;
}

function scheduleIdleClose(entry: PreviewTab, ms = PREVIEW_TAB_IDLE_MS): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entry.busy > 0 || previewTabs.get(entry.key) !== entry) return;
    previewTabs.delete(entry.key);
    updateKeepAlive();
    entry.tab.then((id) => closeTabQuietly(id), () => undefined);
  }, ms);
}

function dropPreviewTab(entry: PreviewTab): void {
  if (entry.timer) clearTimeout(entry.timer);
  if (previewTabs.get(entry.key) === entry) previewTabs.delete(entry.key);
  updateKeepAlive();
}

/** Runs `fn` against the cached preview worker tab for `site` (opened on demand). */
async function withPreviewTab<T>(site: SiteInfo, nearTabId: number | undefined, fn: (tabId: number) => Promise<T>): Promise<T> {
  const key = await previewKey(site, nearTabId);
  for (let attempt = 0; ; attempt++) {
    let entry = previewTabs.get(key);
    const wasCached = !!entry;
    if (!entry) {
      entry = { key, tab: openWorkerTab(site, nearTabId), busy: 0 };
      previewTabs.set(key, entry);
      updateKeepAlive();
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
      if (previewTabs.get(key) === current && current.busy === 0) {
        scheduleIdleClose(current, uiPorts.size ? PREVIEW_TAB_IDLE_MS : NO_UI_GRACE_MS);
      }
    }
  }
}

/** Hands the cached preview tab over to a job (the job closes it when done). */
async function takePreviewTab(site: SiteInfo, nearTabId: number | undefined): Promise<number | undefined> {
  const entry = previewTabs.get(await previewKey(site, nearTabId));
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

/** No extension page is open any more: close idle helper tabs soon instead of after 2 minutes. */
function closeIdlePreviewTabsSoon(): void {
  for (const entry of previewTabs.values()) if (entry.busy === 0) scheduleIdleClose(entry, NO_UI_GRACE_MS);
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

// ───────────────────────────── page collection for the preview / popup ─────────────────────────────

interface CachedCollect {
  at: number;
  result: { pages: PageRef[]; warnings: string[] };
}
/** Raw collection results (before the policy filter) for a short while, keyed by collectKey(). */
const collectCache = new Map<string, CachedCollect>();

/**
 * What determines a collection's result. The source tab is part of it: it decides the browser
 * profile (incognito or not), and the popup and the preview it opens share it.
 */
export function collectKey(request: ExportRequest): string {
  return JSON.stringify([
    siteKey(request.site),
    request.sourceTabId ?? null,
    request.mode,
    request.root.id,
    request.root.type,
    request.depth ?? null,
    request.linkDepth ?? null,
    request.mode === 'selection' ? (request.selectedIds ?? []) : null,
    !!request.options?.includeArchived,
  ]);
}

/**
 * Resolves the page list for the preview (blocked spaces removed). The collection runs in the
 * site's helper tab as a background operation (no event stays pending for minutes); progress
 * and throttling are reported through `onUpdate`, `signal` cancels it. A result collected
 * moments ago for the same request (the popup's page count) is reused.
 */
export async function collectForPreview(
  request: ExportRequest,
  o: {
    requestId: string;
    signal: AbortSignal;
    onUpdate?: (u: { message?: string; throttledForMs?: number }) => void;
  },
): Promise<{ pages: PageRef[]; warnings: string[] }> {
  await init();
  validateRequest(request);
  await requireAccess(request.site);
  const policy = await loadPolicy();
  if (isBlockedSpace(request.root.spaceKey, policy)) throw blockedError();

  const key = collectKey(request);
  for (const [k, v] of collectCache) if (Date.now() - v.at > COLLECT_CACHE_TTL_MS) collectCache.delete(k);
  let res = collectCache.get(key)?.result;
  if (!res) {
    const unsubscribe = subscribeWorker(o.requestId, (m) => {
      if (m.type === 'worker/progress') o.onUpdate?.({ message: m.current });
      else if (m.type === 'worker/throttled') o.onUpdate?.({ throttledForMs: m.retryInMs });
    });
    try {
      // The source tab decides the profile (incognito or not) of the helper tab.
      res = await withPreviewTab(request.site, request.sourceTabId, async (tabId) => {
        try {
          return await runWorkerOp(
            { callWorker, subscribeWorker },
            {
              tabId,
              id: o.requestId,
              op: 'collect',
              msg: {
                type: 'worker/collect',
                jobId: o.requestId,
                request,
                maxItems: policy.maxPages ? policy.maxPages + 1 : undefined,
                transient: true,
              },
              signal: o.signal,
            },
          );
        } catch (e) {
          if (o.signal.aborted) callWorker(tabId, { type: 'worker/cancel', jobId: o.requestId }).catch(() => undefined);
          throw e;
        }
      });
    } finally {
      unsubscribe();
    }
    collectCache.set(key, { at: Date.now(), result: res });
  }

  const filtered = applyPolicyToPages(res.pages, policy, request.root.spaceKey);
  const warnings = [...res.warnings];
  const blocked = filtered.errors.filter((e) => e.message === BLOCKED_MESSAGE).length;
  const unverified = filtered.errors.length - blocked;
  if (blocked) {
    warnings.push(`${blocked} page${blocked === 1 ? ' is' : 's are'} in spaces blocked by your administrator and will be left out.`);
  }
  if (unverified) {
    warnings.push(
      `${unverified} linked page${unverified === 1 ? '' : 's'} will be left out: ${unverified === 1 ? 'its space' : 'their spaces'} could not be checked against your administrator's policy.`,
    );
  }
  return { pages: filtered.pages, warnings };
}

function postToPort(port: chrome.runtime.Port, event: UiPortEvent): void {
  try {
    port.postMessage(event);
  } catch {
    /* the page went away */
  }
}

/**
 * A popup / preview page connected (`UI_PORT_NAME`). Collections run over this port; when the
 * page goes away (closed, navigated) its collections are cancelled and, once no extension page
 * is left, idle helper tabs are closed.
 */
export function handleUiPort(port: chrome.runtime.Port): void {
  uiPorts.add(port);
  const owned = new Set<string>();
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as UiPortRequest | null;
    if (!msg || typeof msg !== 'object' || typeof msg.requestId !== 'string') return;
    if (msg.type === 'collect/cancel') {
      if (owned.has(msg.requestId)) activeCollects.get(msg.requestId)?.controller.abort();
      return;
    }
    if (msg.type !== 'collect/start' || activeCollects.has(msg.requestId)) return;
    const { requestId } = msg;
    const controller = new AbortController();
    activeCollects.set(requestId, { controller });
    owned.add(requestId);
    updateKeepAlive();
    collectForPreview(msg.request, {
      requestId,
      signal: controller.signal,
      onUpdate: (u) => postToPort(port, { type: 'collect/progress', requestId, ...u }),
    })
      .then(
        (result) => postToPort(port, { type: 'collect/done', requestId, result }),
        (e: unknown) => {
          const err = e as { message?: unknown; code?: unknown } | null;
          postToPort(port, {
            type: 'collect/failed',
            requestId,
            error: typeof err?.message === 'string' ? err.message : String(e),
            code: controller.signal.aborted ? 'ABORTED' : typeof err?.code === 'string' ? err.code : undefined,
          });
        },
      )
      .finally(() => {
        activeCollects.delete(requestId);
        owned.delete(requestId);
        updateKeepAlive();
      });
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    uiPorts.delete(port);
    for (const id of owned) activeCollects.get(id)?.controller.abort();
    if (uiPorts.size === 0) closeIdlePreviewTabsSoon();
  });
}

/** UiToSw 'tree/children': lazy tree for the manual picker. */
export async function treeChildren(
  msg: {
    site: SiteInfo;
    spaceKey: string;
    spaceId?: string;
    parent?: { id: string; type: TreeNode['type'] };
    sourceTabId?: number;
  },
  nearTabId?: number,
): Promise<TreeNode[]> {
  await init();
  await requireAccess(msg.site);
  const policy = await loadPolicy();
  if (isBlockedSpace(msg.spaceKey, policy)) throw blockedError();
  // The source tab decides the profile (incognito or not) of the helper tab.
  return withPreviewTab(msg.site, msg.sourceTabId ?? nearTabId, (tabId) =>
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

async function fallbackPrint(tabId: number): Promise<void> {
  // The tab now belongs to the user: it must survive orphan cleanup (the list and the URL marker).
  await unregisterOrphan(tabId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  await chrome.scripting.executeScript({
    target: { tabId },
    // Deferred so executeScript returns instead of blocking until the dialog closes.
    func: () => {
      history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => window.print(), 150);
    },
  });
}

/** Compact page list for the checkpoint (no breadcrumbs or other bulky fields). */
function compactPages(pages: PageRef[]): PageRef[] {
  return pages.map((p) => {
    const c: PageRef = { id: p.id, type: p.type, title: p.title, depth: p.depth, url: p.url, reason: p.reason };
    if (p.spaceKey) c.spaceKey = p.spaceKey;
    if (p.spaceId) c.spaceId = p.spaceId;
    if (p.parentId) c.parentId = p.parentId;
    return c;
  });
}

function buildDeps(job: ExportJobState, signal: AbortSignal, settings: Settings, policy: ManagedPolicy): RunnerDeps {
  return {
    callWorker: (tabId, msg) => callWorker(tabId, msg as SwToWorker) as never,
    subscribeWorker,
    openWorkerTab: async (site, nearTabId, s) => {
      const taken = await takePreviewTab(site, nearTabId);
      if (taken !== undefined && s?.aborted) {
        await closeTabQuietly(taken);
        throw new DOMException('The export was cancelled.', 'AbortError');
      }
      return taken ?? openWorkerTab(site, nearTabId, s);
    },
    closeTabQuietly,
    toPrintParams,
    printSession: (tabId, s) => createPrintSession(tabId, s),
    isDebuggerUnavailable: (e) =>
      e instanceof DebuggerUnavailableError || (e as { name?: string } | null)?.name === 'DebuggerUnavailableError',
    // Detaching everything would break other jobs that are printing right now.
    detachAll: () => ([...running.values()].some((r) => r.job.id !== job.id && !isTerminal(r.job.status)) ? Promise.resolve() : detachAll()),
    fallbackPrint,
    liveRenderPages,
    concatPdfs,
    finalizeExport,
    finalizePdf,
    zipFiles,
    saveBytes,
    saveCheckpoint: (j) => {
      store.saveCheckpoint(j.id, { request: j.request, pages: compactPages(j.pages) }).catch(() => undefined);
    },
    settings,
    policy,
    version: chrome.runtime.getManifest().version,
    now: () => Date.now(),
    signal,
    onUpdate: publish,
  };
}

/** UiToSw 'job/start'. Validates, applies the managed policy and runs the job in the background. */
export async function startJob(request: ExportRequest, pages?: PageRef[], startKey?: number): Promise<string> {
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
    pageCount: initialPages.length || undefined,
    status: 'collecting',
    message: 'Starting',
    progress: { done: 0, total: 0 },
    errors: [],
    createdAt: Date.now(),
    ...(startKey !== undefined ? { startKey } : {}),
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

// ───────────────────────────── start after a permission grant ─────────────────────────────

/** Pending starts claimed by this service worker, keyed by their `createdAt`. */
const pendingClaims = new Map<number, Promise<string>>();

/**
 * Starts a pending export (popup permission hand-off) exactly once. `permissions.onAdded` and
 * the popup's `job/claimPending` both come here; the claim is registered synchronously, before
 * any await, so whichever arrives second gets the first one's job.
 */
export function claimPendingStart(pending: PendingStartPayload): Promise<string> {
  const key = pending.createdAt;
  let claim = pendingClaims.get(key);
  if (!claim) {
    claim = (async () => {
      store.clearPendingStart().catch(() => undefined);
      // A previous service-worker instance may already have started it.
      const existing = (await listJobs()).find((j) => j.startKey === key);
      if (existing) return existing.id;
      return startJob(pending.request, pending.pages, key);
    })();
    pendingClaims.set(key, claim);
    claim.catch(() => pendingClaims.delete(key));
    setTimeout(() => pendingClaims.delete(key), store.PENDING_START_TTL_MS);
  }
  return claim;
}

/** UiToSw 'job/retry': start an interrupted export again with its stored page list. */
export async function retryJob(jobId: string): Promise<string> {
  await init();
  const checkpoint = await store.loadCheckpoint(jobId).catch(() => null);
  if (!checkpoint) throw codedError('The page list of this export is no longer available. Start a new export.', 'NOT_FOUND');
  return startJob(checkpoint.request, checkpoint.pages);
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
  // The checkpoint only serves an interrupted export; this one ended normally.
  await store.deleteCheckpoint(job.id).catch(() => undefined);
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

/** Full job (with its page list) while this service worker knows it; a slim snapshot otherwise. */
export async function getJob(jobId: string): Promise<ExportJobState | null> {
  const live = running.get(jobId)?.job ?? finished.get(jobId);
  if (live) return snapshot(live);
  try {
    return await store.loadJob(jobId);
  } catch {
    return null;
  }
}

/** Most recent jobs, newest first (slim snapshots, without page lists). */
export async function listJobs(): Promise<ExportJobState[]> {
  let stored: ExportJobState[] = [];
  try {
    stored = await store.listJobs();
  } catch {
    stored = [];
  }
  const byId = new Map(stored.map((j) => [j.id, j]));
  for (const j of [...finished.values(), ...[...running.values()].map((r) => r.job)]) byId.set(j.id, slimJob(j));
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, store.MAX_STORED_JOBS);
}

export function hasRunningJobs(): boolean {
  return running.size > 0;
}
