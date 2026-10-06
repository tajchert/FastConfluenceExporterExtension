import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectAll,
  getJson,
  getText,
  HttpError,
  paginate,
  parseRetryAfter,
  resolveNextUrl,
} from '../../lib/confluence/http';
import { isAbortError } from '../../lib/util/abort';
import type { SiteInfo } from '../../lib/types';

const cloud: SiteInfo = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
};
const dc: SiteInfo = {
  origin: 'https://intranet.example.org',
  baseUrl: 'https://intranet.example.org/confluence',
  contextPath: '/confluence',
  flavour: 'server',
};

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

function mockFetch(replies: Reply[] | ((url: string) => Reply)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const r = typeof replies === 'function' ? replies(url) : replies.shift();
    if (!r) throw new Error(`unexpected fetch ${url}`);
    const text = r.raw ?? JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: r.headers });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    expect(parseRetryAfter('Tue, 06 Oct 2026 12:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Tue, 06 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('getJson', () => {
  it('sends a same-origin GET with credentials and JSON accept header', async () => {
    const calls = mockFetch([json({ ok: 1 })]);
    await expect(getJson('https://acme.atlassian.net/wiki/api/v2/pages/1')).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.credentials).toBe('include');
    expect((calls[0]!.init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('retries 429 honoring Retry-After and reports throttling', async () => {
    const calls = mockFetch([json({}, 429, { 'Retry-After': '0' }), json({}, 429, { 'Retry-After': '0' }), json({ v: 2 })]);
    const onThrottle = vi.fn();
    await expect(getJson('https://x/a', { onThrottle })).resolves.toEqual({ v: 2 });
    expect(calls).toHaveLength(3);
    expect(onThrottle).toHaveBeenCalledTimes(2);
    expect(onThrottle).toHaveBeenCalledWith(0);
  });

  it('uses exponential back-off without Retry-After', async () => {
    vi.useFakeTimers();
    const calls = mockFetch([json({}, 503), json({}, 503), json({ ok: true })]);
    const onThrottle = vi.fn();
    const p = getJson('https://x/a', { onThrottle });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    await expect(p).resolves.toEqual({ ok: true });
    expect(onThrottle.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('gives up after maxRetries', async () => {
    const calls = mockFetch(() => json({}, 429, { 'Retry-After': '0' }));
    const err = await getJson('https://x/a').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect(calls).toHaveLength(4);
  });

  it('retries 502 without reporting throttling', async () => {
    mockFetch([json({}, 502, { 'Retry-After': '0' }), json({ ok: 1 })]);
    const onThrottle = vi.fn();
    await expect(getJson('https://x/a', { onThrottle })).resolves.toEqual({ ok: 1 });
    expect(onThrottle).not.toHaveBeenCalled();
  });

  it('throws HttpError with status and server message for 4xx without retrying', async () => {
    const calls = mockFetch([json({ message: 'No content found with id 9' }, 404)]);
    const err = (await getJson('https://x/content/9').catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(err.url).toBe('https://x/content/9');
    expect(err.message).toContain('No content found with id 9');
    expect(calls).toHaveLength(1);
  });

  it('reports a non-JSON 200 (login page) as 401', async () => {
    mockFetch([{ raw: '<html>login</html>', headers: { 'Content-Type': 'text/html' } }]);
    const err = (await getJson('https://x/a').catch((e) => e)) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
  });

  it('aborts while waiting to retry', async () => {
    mockFetch(() => json({}, 429, { 'Retry-After': '30' }));
    const ac = new AbortController();
    const p = getJson('https://x/a', { signal: ac.signal, onThrottle: () => ac.abort() });
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('wraps network failures in HttpError(0) after one retry', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        throw new TypeError('Failed to fetch');
      }),
    );
    vi.useFakeTimers();
    const p = getJson('https://x/a').catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = (await p) as HttpError;
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(0);
    expect(n).toBe(2);
  });
});

describe('getText', () => {
  it('returns the body text', async () => {
    mockFetch([{ raw: '<p>x</p>' }]);
    await expect(getText('https://x/a')).resolves.toBe('<p>x</p>');
  });
});

describe('resolveNextUrl', () => {
  it('resolves v2 links that already include the context path against the origin', () => {
    expect(resolveNextUrl('/wiki/api/v2/pages/1/children?cursor=abc', cloud)).toBe(
      'https://acme.atlassian.net/wiki/api/v2/pages/1/children?cursor=abc',
    );
  });
  it('resolves v1 links against the base URL', () => {
    expect(resolveNextUrl('/rest/api/content/1/child/page?start=25', cloud)).toBe(
      'https://acme.atlassian.net/wiki/rest/api/content/1/child/page?start=25',
    );
    expect(resolveNextUrl('/rest/api/content/1/child/page?start=25', dc)).toBe(
      'https://intranet.example.org/confluence/rest/api/content/1/child/page?start=25',
    );
    expect(resolveNextUrl('/confluence/rest/api/x?start=5', dc)).toBe(
      'https://intranet.example.org/confluence/rest/api/x?start=5',
    );
  });
  it('accepts same-origin absolute links and refuses other origins', () => {
    expect(resolveNextUrl('https://acme.atlassian.net/wiki/api/v2/x?cursor=1', cloud)).toBe(
      'https://acme.atlassian.net/wiki/api/v2/x?cursor=1',
    );
    expect(resolveNextUrl('https://evil.example.com/wiki/api/v2/x', cloud)).toBeNull();
  });
});

describe('paginate', () => {
  it('follows v2 cursor links', async () => {
    const calls = mockFetch([
      json({ results: [{ id: 1 }, { id: 2 }], _links: { next: '/wiki/api/v2/spaces/1/pages?cursor=c2' } }),
      json({ results: [{ id: 3 }], _links: {} }),
    ]);
    const items = await collectAll<{ id: number }>('https://acme.atlassian.net/wiki/api/v2/spaces/1/pages', cloud);
    expect(items.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(calls[1]!.url).toBe('https://acme.atlassian.net/wiki/api/v2/spaces/1/pages?cursor=c2');
  });

  it('follows v1 next links relative to the base URL', async () => {
    const calls = mockFetch([
      json({ results: [{ id: 'a' }], start: 0, limit: 1, size: 1, _links: { next: '/rest/api/content/1/child/page?start=1&limit=1' } }),
      json({ results: [{ id: 'b' }], start: 1, limit: 1, size: 1, _links: {} }),
      json({ results: [], start: 2, limit: 1, size: 0 }),
    ]);
    const items = await collectAll<{ id: string }>(`${dc.baseUrl}/rest/api/content/1/child/page?limit=1`, dc);
    expect(items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(calls[1]!.url).toBe('https://intranet.example.org/confluence/rest/api/content/1/child/page?start=1&limit=1');
    // Without a next link but a full page, it tries the next offset.
    expect(calls[2]!.url).toContain('start=2');
  });

  it('stops on totalSize and on a short page', async () => {
    const calls = mockFetch([json({ results: [{ id: 1 }, { id: 2 }], start: 0, limit: 2, size: 2, totalSize: 2 })]);
    const items: unknown[] = [];
    for await (const it of paginate(`${dc.baseUrl}/rest/api/search?cql=x`, dc)) items.push(it);
    expect(items).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('does not loop on a repeated next link', async () => {
    const calls = mockFetch(() => json({ results: [{ id: 1 }], _links: { next: '/wiki/api/v2/same' } }));
    const items = await collectAll('https://acme.atlassian.net/wiki/api/v2/same', cloud);
    expect(items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe('request timeouts', () => {
  it('turns a request that never answers into HttpError(0) "timed out" instead of hanging', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        calls.push(String(input));
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }),
    );
    const err = await getJson('https://acme.atlassian.net/wiki/api/v2/pages/1', { timeoutMs: 20, maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect((err as HttpError).message).toMatch(/timed out/);
    expect(calls).toHaveLength(1);
  });

  it('retries a timed-out attempt once, then succeeds', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
        n++;
        if (n === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }),
    );
    vi.useFakeTimers();
    const p = getJson('https://acme.atlassian.net/wiki/api/v2/pages/1', { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(2000); // back-off
    await expect(p).resolves.toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('a cancel is an AbortError, not a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }),
    );
    const ac = new AbortController();
    const p = getJson('https://acme.atlassian.net/wiki/api/v2/pages/1', { signal: ac.signal, timeoutMs: 10_000 });
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
  });
});
