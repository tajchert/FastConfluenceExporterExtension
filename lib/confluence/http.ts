/**
 * Same-origin GET helpers for the Confluence REST API: session cookies, retry with back-off on
 * throttling / gateway errors, AbortSignal support and pagination for both v1 and v2 APIs.
 */
import type { SiteInfo } from '../types';
import { abortError, isAbortError, sleep, throwIfAborted } from '../util/abort';

export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, url: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export interface HttpOptions {
  signal?: AbortSignal;
  /** Called before waiting because Confluence throttled us (429/503). */
  onThrottle?: (retryInMs: number) => void;
  /** Retries for 429/502/503/504 (default 3). */
  maxRetries?: number;
  /** Per attempt: time allowed until the response headers arrive (default 60 s). */
  timeoutMs?: number;
  /** Per attempt: time allowed to read the response body (default 180 s; export_view can be large). */
  bodyTimeoutMs?: number;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const THROTTLE_STATUSES = new Set([429, 503]);
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 120_000;
/** Network failures (connection reset, DNS, timeouts) are retried at most this many times. */
const NETWORK_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 60_000;
const BODY_TIMEOUT_MS = 180_000;

/** Parses `Retry-After` (delta seconds or HTTP date) into milliseconds; null if absent/invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const date = Date.parse(v);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  const jitter = Math.random() * 500;
  const base = retryAfterMs ?? BASE_DELAY_MS * 2 ** attempt + Math.random() * BASE_DELAY_MS * 0.5;
  return Math.min(MAX_DELAY_MS, Math.round(base + jitter));
}

function describeError(res: Response, body: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body.slice(0, 4000)) as {
      message?: unknown;
      errors?: { title?: unknown; detail?: unknown }[];
      errorMessage?: unknown;
    };
    const first = Array.isArray(j.errors) ? j.errors[0] : undefined;
    const m = j.message ?? first?.title ?? first?.detail ?? j.errorMessage;
    if (typeof m === 'string') detail = m;
  } catch {
    /* not JSON: ignore the HTML error page */
  }
  const head = `HTTP ${res.status}${res.statusText ? ' ' + res.statusText : ''}`;
  const hint =
    res.status === 401
      ? ' (not logged in to Confluence?)'
      : res.status === 403 || res.status === 404
        ? ' (not found or no permission)'
        : '';
  return detail ? `${head}${hint}: ${detail.slice(0, 300)}` : `${head}${hint}`;
}

type Attempt = { kind: 'response'; res: Response; text: string } | { kind: 'failed'; reason: string };

/** One fetch with its own timeouts (headers, then body) on top of the caller's signal. */
async function attemptOnce(url: string, accept: string, signal: AbortSignal | undefined, headerTimeout: number, bodyTimeout: number): Promise<Attempt> {
  const ctl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, ms);
  };
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    arm(headerTimeout);
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: accept },
      redirect: 'follow',
      cache: 'no-store',
      signal: ctl.signal,
    });
    arm(bodyTimeout);
    const text = await res.text();
    return { kind: 'response', res, text };
  } catch (e) {
    if (signal?.aborted || (!timedOut && isAbortError(e))) throw abortError();
    return {
      kind: 'failed',
      reason: timedOut ? 'Confluence did not answer in time (request timed out)' : `Network error: ${(e as Error)?.message ?? String(e)}`,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * GET with retries. Every attempt has its own timeout, so a connection that is accepted but never
 * answered cannot hang an export: a timeout is retried like a network failure and finally
 * reported as HttpError(0).
 */
async function request(url: string, accept: string, opts: HttpOptions = {}): Promise<{ res: Response; text: string }> {
  const { signal, onThrottle } = opts;
  const maxRetries = Math.max(0, opts.maxRetries ?? 3);
  const headerTimeout = Math.max(1, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const bodyTimeout = Math.max(1, opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS);
  let networkFailures = 0;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    const r = await attemptOnce(url, accept, signal, headerTimeout, bodyTimeout);
    if (r.kind === 'failed') {
      if (networkFailures < NETWORK_RETRIES && attempt < maxRetries) {
        networkFailures++;
        await sleep(backoffDelay(attempt, null), signal);
        continue;
      }
      throw new HttpError(0, url, r.reason);
    }
    const { res, text } = r;
    if (res.ok) return { res, text };
    if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
      const wait = backoffDelay(attempt, parseRetryAfter(res.headers.get('Retry-After')));
      if (THROTTLE_STATUSES.has(res.status)) onThrottle?.(wait);
      await sleep(wait, signal);
      continue;
    }
    throw new HttpError(res.status, url, describeError(res, text));
  }
}

export async function getJson<T>(url: string, opts?: HttpOptions): Promise<T> {
  const { res, text } = await request(url, 'application/json', opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A same-origin login page (HTML, 200) is the typical cause.
    throw new HttpError(
      401,
      res.url || url,
      'Confluence returned a non-JSON response. Are you logged in to Confluence in this browser?',
    );
  }
}

export async function getText(url: string, opts?: HttpOptions): Promise<string> {
  return (await request(url, 'text/html, application/xhtml+xml, */*;q=0.8', opts)).text;
}

interface PagedResponse<T> {
  results?: T[];
  start?: number;
  limit?: number;
  size?: number;
  totalSize?: number;
  _links?: { next?: string; base?: string };
}

/**
 * Resolves a pagination `next` link. v2 links are origin-relative and already contain the
 * context path (`/wiki/api/v2/...`); v1 links are relative to the base URL (`/rest/api/...`).
 * Cross-origin links are refused.
 */
export function resolveNextUrl(next: string, site: SiteInfo): string | null {
  const n = next.trim();
  if (!n) return null;
  let resolved: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(n)) resolved = new URL(n);
    else if (n.startsWith('/')) {
      const ctx = site.contextPath.replace(/\/+$/, '');
      const hasCtx = !ctx || n === ctx || n.startsWith(ctx + '/') || n.startsWith(ctx + '?');
      resolved = new URL((hasCtx ? site.origin : site.baseUrl.replace(/\/+$/, '')) + n);
    } else resolved = new URL(n, site.baseUrl.replace(/\/+$/, '') + '/');
  } catch {
    return null;
  }
  return resolved.origin === site.origin ? resolved.toString() : null;
}

function offsetNextUrl(current: string, data: PagedResponse<unknown>, count: number): string | null {
  const { start, limit, size, totalSize } = data;
  if (typeof start !== 'number' || typeof limit !== 'number' || limit <= 0) return null;
  const got = typeof size === 'number' ? size : count;
  if (got <= 0 || got < limit) return null;
  if (typeof totalSize === 'number' && start + got >= totalSize) return null;
  const u = new URL(current);
  u.searchParams.set('start', String(start + got));
  u.searchParams.set('limit', String(limit));
  return u.toString();
}

const MAX_PAGES = 10_000;

/** Follows v2 `_links.next` and v1 `_links.next`/`start`+`limit`; yields `results[]` items. */
export async function* paginate<T>(firstUrl: string, site: SiteInfo, opts?: HttpOptions): AsyncGenerator<T> {
  let url: string | null = firstUrl;
  const seen = new Set<string>();
  while (url && !seen.has(url) && seen.size < MAX_PAGES) {
    seen.add(url);
    const data: PagedResponse<T> = await getJson<PagedResponse<T>>(url, opts);
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const item of results) yield item;
    const next = data?._links?.next;
    url =
      typeof next === 'string' && next
        ? resolveNextUrl(next, site)
        : results.length > 0
          ? offsetNextUrl(url, data ?? {}, results.length)
          : null;
  }
}

/** Collects every item of a paginated endpoint. */
export async function collectAll<T>(firstUrl: string, site: SiteInfo, opts?: HttpOptions): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate<T>(firstUrl, site, opts)) {
    throwIfAborted(opts?.signal);
    out.push(item);
  }
  return out;
}
