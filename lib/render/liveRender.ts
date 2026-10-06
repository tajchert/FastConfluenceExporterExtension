/**
 * Live render (FR-10): prints pages with client-rendered macros (draw.io, Gliffy,
 * charts, …) from their real Confluence URL. A small pool of inactive tabs in the source window
 * opens each page, /live.js prepares it (expand macros, hide app chrome, wait for render and
 * network quiet), and the tab is printed with the same parameters as the fast path.
 * Runs in the service worker. One failing page never fails the batch.
 */
import type { RpcResult, SwToLive, SwToLiveResponses } from '../messages';
import { effectiveMarginsMm, paperSizeMm } from '../assemble/geometry';
import type { ExportOptions, PageRef } from '../types';
import { printTabToPdf, toPrintParams, type PrintHooks } from './cdp';
import {
  closeTabQuietly,
  LIVE_TAB_MARKER,
  LoginRequiredError,
  markUrl,
  openBackgroundTab,
  scriptingError,
  waitForTabComplete,
} from './tabs';

type Prepared = SwToLiveResponses['live/prepare'];

const PAGE_LOAD_TIMEOUT_MS = 45_000;
const DEFAULT_RENDER_TIMEOUT_MS = 20_000;
/** Second, shorter render wait after focus emulation, for pages that were still incomplete. */
const RETRY_RENDER_TIMEOUT_MS = 8_000;
/** Slack on top of the content script's own timeout before we stop waiting for its answer. */
const PREPARE_GRACE_MS = 15_000;

export interface LiveRenderOptions {
  options: ExportOptions;
  concurrency: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, current?: string) => void;
  nearTabId?: number;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * @page rule matching the export options (printTabToPdf uses preferCSSPageSize). Same geometry
 * as the fast path's print document (lib/assemble/geometry.ts), so inserted sheets line up.
 */
export function livePageCss(options: ExportOptions): string {
  const sheet = paperSizeMm(options.paperSize, options.orientation);
  const m = effectiveMarginsMm(options);
  return `@page { size: ${fmt(sheet.width)}mm ${fmt(sheet.height)}mm; margin: ${fmt(m.top)}mm ${fmt(m.right)}mm ${fmt(m.bottom)}mm ${fmt(m.left)}mm; }`;
}

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError';
}

async function sendPrepare(tabId: number, msg: SwToLive, signal?: AbortSignal): Promise<Prepared> {
  if (signal?.aborted) throw abortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('The page did not finish rendering in time.')),
      msg.timeoutMs + PREPARE_GRACE_MS,
    );
    onAbort = () => reject(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const res = (await Promise.race([chrome.tabs.sendMessage(tabId, msg), guard])) as RpcResult<Prepared> | undefined;
    if (!res) throw new Error('The live render helper did not answer.');
    if (!res.ok) throw new Error(res.error);
    return res.value;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function assertSameSite(tab: chrome.tabs.Tab, pageUrl: string): void {
  const expected = new URL(pageUrl).origin;
  // Without access to the final URL the tab ended up on another origin (SSO / login page).
  if (!tab.url) throw new LoginRequiredError();
  let actual: URL;
  try {
    actual = new URL(tab.url);
  } catch {
    throw new LoginRequiredError();
  }
  if (actual.origin !== expected) throw new LoginRequiredError();
  if (/\/(login|signin|sign-in)(\.action|\.jsp)?(\/|$)|\/sso\//i.test(actual.pathname)) throw new LoginRequiredError();
}

async function renderOne(page: PageRef, o: LiveRenderOptions): Promise<Uint8Array> {
  const { signal } = o;
  const timeoutMs = Math.max(1000, o.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS);
  const customCss = `${livePageCss(o.options)}\n${o.options.customCss ?? ''}`;
  const params = toPrintParams(o.options);

  const tabId = await openBackgroundTab(markUrl(page.url, LIVE_TAB_MARKER), o.nearTabId);
  try {
    const tab = await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT_MS, signal);
    assertSameSite(tab, page.url);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['/live.js'] });
    } catch (e) {
      throw scriptingError(e, new URL(page.url).origin);
    }
    const prepared = await sendPrepare(tabId, { type: 'live/prepare', timeoutMs, customCss }, signal);

    let hooks: PrintHooks | undefined;
    if (!prepared.rendered) {
      // Background tabs are throttled; with the debugger attached we can make the page believe
      // it is focused and active, then give it one more (shorter) chance to finish rendering.
      hooks = {
        beforePrint: async (send) => {
          await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
          await send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
          await sendPrepare(
            tabId,
            { type: 'live/prepare', timeoutMs: Math.min(RETRY_RENDER_TIMEOUT_MS, timeoutMs), customCss },
            signal,
          ).catch((e) => {
            if (isAbort(e)) throw e;
          });
        },
      };
    }
    return await printTabToPdf(tabId, params, signal, hooks);
  } finally {
    await closeTabQuietly(tabId);
  }
}

export async function liveRenderPages(
  pages: PageRef[],
  o: LiveRenderOptions,
): Promise<Map<string, Uint8Array | Error>> {
  const results = new Map<string, Uint8Array | Error>();
  if (o.signal?.aborted) throw abortError();
  const queue = pages.filter((p, i) => pages.findIndex((q) => q.id === p.id) === i);
  if (queue.length === 0) return results;

  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(o.concurrency || 1, queue.length)) }, async () => {
    while (next < queue.length && !o.signal?.aborted) {
      const page = queue[next++];
      o.onProgress?.(done, page.title);
      try {
        results.set(page.id, await renderOne(page, o));
      } catch (e) {
        if (o.signal?.aborted) return;
        results.set(page.id, toError(e));
      }
      done++;
      o.onProgress?.(done);
    }
  });
  await Promise.all(workers);
  if (o.signal?.aborted) throw abortError();
  return results;
}
