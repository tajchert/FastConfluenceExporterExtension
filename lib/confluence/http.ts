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
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const THROTTLE_STATUSES = new Set([429, 503]);
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 120_000;
/** Network failures (connection reset, DNS) are retried at most this many times. */
const NETWORK_RETRIES = 1;

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

async function describeError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = (await res.text()).slice(0, 4000);
    try {
      const j = JSON.parse(text) as {
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
  } catch {
    /* body unreadable */
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

async function request(url: string, accept: string, opts: HttpOptions = {}): Promise<Response> {
  const { signal, onThrottle } = opts;
  const maxRetries = Math.max(0, opts.maxRetries ?? 3);
  let networkFailures = 0;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: accept },
        redirect: 'follow',
        cache: 'no-store',
        signal,
      });
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw abortError();
      if (networkFailures < NETWORK_RETRIES && attempt < maxRetries) {
        networkFailures++;
        await sleep(backoffDelay(attempt, null), signal);
        continue;
      }
      throw new HttpError(0, url, `Network error: ${(e as Error)?.message ?? String(e)}`);
    }
    if (res.ok) return res;
    if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
      const wait = backoffDelay(attempt, parseRetryAfter(res.headers.get('Retry-After')));
      if (THROTTLE_STATUSES.has(res.status)) onThrottle?.(wait);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      await sleep(wait, signal);
      continue;
    }
    throw new HttpError(res.status, url, await describeError(res));
  }
}

export async function getJson<T>(url: string, opts?: HttpOptions): Promise<T> {
  const res = await request(url, 'application/json', opts);
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (opts?.signal?.aborted || isAbortError(e)) throw abortError();
    throw new HttpError(0, url, `Network error while reading the response: ${(e as Error)?.message ?? e}`);
  }
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
  const res = await request(url, 'text/html, application/xhtml+xml, */*;q=0.8', opts);
  try {
    return await res.text();
  } catch (e) {
    if (opts?.signal?.aborted || isAbortError(e)) throw abortError();
    throw new HttpError(0, url, `Network error while reading the response: ${(e as Error)?.message ?? e}`);
  }
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
