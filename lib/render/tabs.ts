/**
 * Background tab management for the service worker: the per-job worker tab (opened on a JSON
 * endpoint of the Confluence site, then taken over by /worker.js) and helpers shared with live
 * render. Every tab we open is recorded in chrome.storage.session so a restarted service worker
 * can close orphans (`closeOrphanTabs`).
 */
import type { SiteInfo } from '../types';
import { callWorker } from '../rpc';

const ORPHAN_KEY = 'orphanTabs';
/**
 * URL fragments that mark tabs opened by the extension (they do not change the request). The
 * orphan list lives in session storage, which a browser restart clears, while "Continue where
 * you left off" restores the tabs with new ids: the marker still identifies them.
 */
export const WORKER_TAB_MARKER = '#cfp-worker';
export const LIVE_TAB_MARKER = '#cfp-live';
const LOAD_TIMEOUT_MS = 30_000;
const PING_ATTEMPTS = 20;
const PING_INTERVAL_MS = 150;
/** Fallback polling of the tab status while waiting for "complete" (see waitForTabComplete). */
const STATUS_POLL_MS = 250;

import { LOGIN_REQUIRED_MESSAGE } from '../errors';

export { LOGIN_REQUIRED_MESSAGE };

export class LoginRequiredError extends Error {
  readonly code = 'LOGIN_REQUIRED';
  constructor(message = LOGIN_REQUIRED_MESSAGE) {
    super(message);
    this.name = 'LoginRequiredError';
  }
}

/** Site of each live worker tab, for re-injection messages. */
const workerSites = new Map<number, SiteInfo>();

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ───────────────────────────── orphan bookkeeping ─────────────────────────────

let orphanLock: Promise<unknown> = Promise.resolve();

/** Serializes read-modify-write cycles on the orphan list. */
function withOrphanList(mutate: (ids: number[]) => number[]): Promise<void> {
  const run = orphanLock.then(async () => {
    try {
      const got = await chrome.storage.session.get(ORPHAN_KEY);
      const ids = Array.isArray(got[ORPHAN_KEY]) ? (got[ORPHAN_KEY] as number[]) : [];
      await chrome.storage.session.set({ [ORPHAN_KEY]: mutate(ids) });
    } catch {
      // Session storage unavailable: orphan cleanup is best effort.
    }
  });
  orphanLock = run;
  return run;
}

export function registerOrphan(tabId: number): Promise<void> {
  return withOrphanList((ids) => (ids.includes(tabId) ? ids : [...ids, tabId]));
}

export function unregisterOrphan(tabId: number): Promise<void> {
  return withOrphanList((ids) => ids.filter((id) => id !== tabId));
}

/** Adds `marker` as the URL fragment (replacing any fragment the URL had). */
export function markUrl(url: string, marker: string): string {
  const hash = url.indexOf('#');
  return (hash >= 0 ? url.slice(0, hash) : url) + marker;
}

function isMarked(url: string | undefined): boolean {
  return !!url && (url.endsWith(WORKER_TAB_MARKER) || url.endsWith(LIVE_TAB_MARKER));
}

/**
 * Closes tabs left behind by a previous service-worker instance (or restored after a browser
 * restart or crash). Only tabs on granted sites expose their URL, which is exactly where the
 * extension opens its helper tabs. Returns how many were closed.
 */
export async function closeOrphanTabs(): Promise<number> {
  let ids: number[] = [];
  await withOrphanList((list) => {
    ids = list;
    return [];
  });
  const targets = new Set(ids);
  try {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id !== undefined && (isMarked(tab.url) || isMarked(tab.pendingUrl))) targets.add(tab.id);
    }
  } catch {
    /* tabs API unavailable */
  }
  let closed = 0;
  for (const id of targets) {
    try {
      await chrome.tabs.remove(id);
      closed++;
    } catch {
      /* already gone */
    }
  }
  return closed;
}

export async function closeTabQuietly(tabId: number | undefined): Promise<void> {
  if (tabId === undefined || tabId < 0) return;
  workerSites.delete(tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    /* already closed */
  }
  await unregisterOrphan(tabId);
}

// ───────────────────────────── tab helpers (shared with live render) ─────────────────────────

async function windowOf(tabId: number | undefined): Promise<number | undefined> {
  if (tabId === undefined) return undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined || tab.windowId < 0) return undefined;
    const win = await chrome.windows.get(tab.windowId);
    return win.type === 'normal' ? win.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens an inactive tab at the end of `nearTabId`'s window (or the current window), registers it
 * as an orphan candidate and keeps it from being discarded by Memory Saver.
 */
export async function openBackgroundTab(url: string, nearTabId?: number): Promise<number> {
  const windowId = await windowOf(nearTabId);
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.create({ url, active: false, windowId });
  } catch (e) {
    if (windowId === undefined) throw e;
    tab = await chrome.tabs.create({ url, active: false }); // window closed meanwhile
  }
  if (tab.id === undefined) throw new Error('Chrome did not return an id for the export tab.');
  const tabId = tab.id;
  await registerOrphan(tabId);
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => undefined);
  return tabId;
}

/** Resolves when the tab reaches status "complete"; rejects on timeout, close or abort. */
export function waitForTabComplete(tabId: number, timeoutMs = LOAD_TIMEOUT_MS, signal?: AbortSignal): Promise<chrome.tabs.Tab> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === 'complete') finish(() => resolve(tab));
    };
    const onRemoved = (id: number) => {
      if (id === tabId) finish(() => reject(new Error('An export helper tab was closed, so the export stopped.')));
    };
    const onAbort = () => finish(() => reject(new DOMException('The export was cancelled.', 'AbortError')));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`The page did not finish loading within ${Math.round(timeoutMs / 1000)} s.`))),
      timeoutMs,
    );
    // The tab may already be complete (listener registered after the event). Also poll: a
    // listener added lazily is registered with the browser asynchronously, on a different channel
    // than `tabs.get`, so a fast page can fire "complete" in between and both checks miss it
    // (seen in real Chrome on the first export after the service worker started).
    const checkNow = () =>
      chrome.tabs.get(tabId).then(
        (tab) => {
          if (tab.status === 'complete') finish(() => resolve(tab));
        },
        () => finish(() => reject(new Error('An export helper tab was closed, so the export stopped.'))),
      );
    const poll = setInterval(() => void checkNow(), STATUS_POLL_MS);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    void checkNow();
  });
}

/** Translates executeScript permission failures into an actionable message. */
export function scriptingError(e: unknown, origin: string): Error {
  const msg = errorMessage(e);
  if (/cannot access|permission|host/i.test(msg)) {
    return new Error(`The extension has no access to ${origin}. Grant site access from the extension popup and try again.`);
  }
  if (/no tab with id|tab was closed|helper tab was closed/i.test(msg)) return new Error('An export helper tab was closed, so the export stopped.');
  return new Error(msg);
}

// ───────────────────────────── worker tab ─────────────────────────────

interface WorkerDocInfo {
  href: string;
  contentType: string;
  hasPasswordField: boolean;
  text: string;
}

/** Runs in the worker tab (serialized by executeScript — must be self-contained). */
function inspectWorkerDocument(): WorkerDocInfo {
  return {
    href: location.href,
    contentType: document.contentType,
    hasPasswordField: !!document.querySelector('input[type="password"]'),
    text: (document.body?.innerText ?? '').slice(0, 2000),
  };
}

function looksLikeLogin(info: WorkerDocInfo, site: SiteInfo): boolean {
  let url: URL;
  try {
    url = new URL(info.href);
  } catch {
    return true;
  }
  if (url.origin !== site.origin) return true; // SSO / id.atlassian.com redirect
  if (/login|signin|sign-in|authenticate|\/sso\//i.test(url.pathname)) return true;
  if (info.hasPasswordField) return true;
  if (/json/i.test(info.contentType) || /^\s*[{[]/.test(info.text)) {
    return /"(?:statusCode|status-code|status)"\s*:\s*401|AUTHENTICATED_FAILED|not logged in|unauthori[sz]ed/i.test(info.text);
  }
  return false;
}

async function pingWorker(tabId: number): Promise<boolean> {
  for (let i = 0; i < PING_ATTEMPTS; i++) {
    try {
      const r = await callWorker(tabId, { type: 'worker/ping' });
      if (r?.ready) return true;
    } catch {
      /* "Receiving end does not exist" until the script has registered its listener */
    }
    await delay(PING_INTERVAL_MS);
  }
  return false;
}

async function injectWorker(tabId: number, site: SiteInfo): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['/worker.js'] });
  } catch (e) {
    throw scriptingError(e, site.origin);
  }
  if (!(await pingWorker(tabId))) {
    throw new Error('The export helper did not start in the Confluence tab. Reload the extension and try again.');
  }
}

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

/**
 * Opens the worker tab for a site: `{base}/rest/api/space?limit=1` (same-origin JSON, no app
 * scripts, no CSP), waits for it, checks the user is logged in, injects /worker.js and pings it.
 * When `signal` aborts (the user cancelled while the tab was still opening), the tab is closed
 * and the promise rejects with an AbortError.
 */
export async function openWorkerTab(site: SiteInfo, nearTabId?: number, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw abortError();
  const tabId = await openBackgroundTab(markUrl(`${site.baseUrl}/rest/api/space?limit=1`, WORKER_TAB_MARKER), nearTabId);
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  try {
    await waitForTabComplete(tabId, LOAD_TIMEOUT_MS, signal);
    check();
    let info: WorkerDocInfo | undefined;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: inspectWorkerDocument });
      info = res?.result as WorkerDocInfo | undefined;
    } catch (e) {
      // Without access to the final URL we most likely ended up on another origin (SSO login).
      const msg = errorMessage(e);
      if (/cannot access|permission/i.test(msg)) {
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        if (!tab?.url || !tab.url.startsWith(site.origin)) throw new LoginRequiredError();
      }
      throw scriptingError(e, site.origin);
    }
    check();
    if (info && looksLikeLogin(info, site)) throw new LoginRequiredError();
    await injectWorker(tabId, site);
    check();
    workerSites.set(tabId, site);
    return tabId;
  } catch (e) {
    await closeTabQuietly(tabId);
    throw e;
  }
}

/**
 * Makes sure /worker.js is alive in the tab (it may have been lost if the tab navigated or
 * reloaded). Re-injects when the ping fails.
 */
export async function ensureWorker(tabId: number): Promise<void> {
  try {
    const r = await callWorker(tabId, { type: 'worker/ping' });
    if (r?.ready) return;
  } catch {
    /* not responding — fall through to re-inject */
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('An export helper tab was closed, so the export stopped.');
  }
  if (tab.status !== 'complete') await waitForTabComplete(tabId, LOAD_TIMEOUT_MS);
  const site = workerSites.get(tabId);
  const origin = site?.origin ?? (tab.url ? new URL(tab.url).origin : 'this site');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['/worker.js'] });
  } catch (e) {
    throw scriptingError(e, origin);
  }
  if (!(await pingWorker(tabId))) throw new Error('The export helper stopped responding.');
}
