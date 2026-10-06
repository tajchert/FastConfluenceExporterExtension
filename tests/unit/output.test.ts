import { describe, expect, it, vi } from 'vitest';
import { READ_OUTPUT_MAX_BYTES, type OutputEntry } from '../../lib/messages';
import { downloadAssets } from '../../lib/output/assets';
import { collectOutput, readOutputChunks } from '../../lib/output/chunks';
import { FORMATS, exportButtonLabel, formatOf, isCompressible } from '../../lib/format';

const enc = (s: string) => new TextEncoder().encode(s);

describe('readOutputChunks / collectOutput', () => {
  const data = [enc('hello'), new Uint8Array(0), new Uint8Array(1000).map((_, i) => i % 256), enc('ä✓')];
  const entries: OutputEntry[] = data.map((d, i) => ({ path: `f${i}`, size: d.length, kind: 'document' }));

  it('packs whole entries up to the budget and splits bigger ones', () => {
    const first = readOutputChunks(data, 0, 0, 300);
    expect(first.chunks.map((c) => [c.index, c.offset])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    expect(first.next).toEqual({ index: 2, offset: 295 });
    const last = readOutputChunks(data, 2, 900, 300);
    expect(last.chunks.map((c) => [c.index, c.offset])).toEqual([
      [2, 900],
      [3, 0],
    ]);
    expect(last.next).toBeNull();
  });

  it('never exceeds the 8 MiB message budget', () => {
    const big = [new Uint8Array(READ_OUTPUT_MAX_BYTES + 10)];
    const res = readOutputChunks(big, 0, 0, Number.MAX_SAFE_INTEGER);
    expect(res.next).toEqual({ index: 0, offset: READ_OUTPUT_MAX_BYTES });
  });

  it('round-trips every byte for any budget', async () => {
    for (const budget of [1, 7, 64, 5000]) {
      const read = vi.fn(async (i: number, o: number) => readOutputChunks(data, i, o, budget));
      const out = await collectOutput(entries, read);
      expect(out).toEqual(data);
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(1);
    }
    expect(await collectOutput([], async () => ({ chunks: [], next: null }))).toEqual([]);
  });

  it('rejects inconsistent answers and stops on cancel', async () => {
    await expect(collectOutput(entries, async () => ({ chunks: [], next: { index: 0, offset: 0 } }))).rejects.toThrow(/no data/);
    await expect(
      collectOutput(entries, async () => ({ chunks: [{ index: 0, offset: 3, base64: btoa('xyz') }], next: null })),
    ).rejects.toThrow(/more data/);
    const ac = new AbortController();
    ac.abort();
    await expect(collectOutput(entries, async () => readOutputChunks(data, 0, 0), ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function response(body: Uint8Array | string, init: { status?: number; type?: string; length?: number } = {}): Response {
  const headers = new Headers({ 'content-type': init.type ?? 'image/png' });
  if (init.length !== undefined) headers.set('content-length', String(init.length));
  return new Response(typeof body === 'string' ? body : (body as Uint8Array<ArrayBuffer>), { status: init.status ?? 200, headers });
}

describe('downloadAssets', () => {
  const site = 'https://acme.atlassian.net/wiki/download/attachments/1';

  it('fetches with same-origin credentials, follows redirects, keeps the converter order', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'follow', referrerPolicy: 'no-referrer' });
      const u = String(url);
      if (u.endsWith('a.png')) await new Promise((r) => setTimeout(r, 10));
      return response(enc(u.slice(-5)));
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const { ok, failed } = await downloadAssets(
      [
        { url: `${site}/a.png`, path: 'assets/1/a.png' },
        { url: `${site}/b.png`, path: 'assets/1/b.png' },
        { url: `${site}/b.png?v=2`, path: 'assets/1/b.png' }, // same path: downloaded once
      ],
      { concurrency: 2, fetchImpl, onProgress: (d) => progress.push(d) },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ok.map((a) => a.path)).toEqual(['assets/1/a.png', 'assets/1/b.png']);
    expect(new TextDecoder().decode(ok[0].bytes)).toBe('a.png');
    expect(failed).toEqual([]);
    expect(progress).toEqual([1, 2]);
  });

  it('never requests images outside the allowed origin', async () => {
    const fetchImpl = vi.fn(async () => response(enc('img'))) as unknown as typeof fetch;
    const { ok, failed } = await downloadAssets(
      [
        { url: `${site}/a.png`, path: 'assets/1/a.png' },
        { url: 'https://images.example.com/logo.svg', path: 'assets/1/logo.svg' },
      ],
      { concurrency: 2, fetchImpl, allowedOrigin: 'https://acme.atlassian.net' },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ok.map((a) => a.path)).toEqual(['assets/1/a.png']);
    expect(failed).toEqual([expect.objectContaining({ path: 'assets/1/logo.svg', reason: 'not on the Confluence site' })]);
  });

  it('reports HTTP errors, HTML answers, network errors, size caps and timeouts per image', async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('404.png')) return response('', { status: 404 });
      if (u.endsWith('login.png')) return response('<html>', { type: 'text/html; charset=utf-8' });
      if (u.endsWith('cors.png')) throw new TypeError('Failed to fetch');
      if (u.endsWith('declared.png')) return response(enc('x'), { length: 50 });
      if (u.endsWith('stream.png')) return response(new Uint8Array(40));
      if (u.endsWith('slow.png')) {
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
      }
      return response(new Uint8Array(8));
    }) as unknown as typeof fetch;
    const names = ['404', 'login', 'cors', 'declared', 'stream', 'slow', 'ok1', 'ok2', 'ok3'];
    const { ok, failed } = await downloadAssets(
      names.map((n) => ({ url: `${site}/${n}.png`, path: `assets/1/${n}.png` })),
      { concurrency: 3, fetchImpl, limits: { maxBytes: 30, maxTotalBytes: 20, timeoutMs: 30 } },
    );
    expect(Object.fromEntries(failed.map((f) => [f.path.slice(9, -4), f.reason]))).toEqual({
      '404': 'HTTP 404',
      login: 'not an image (got an HTML page)',
      cors: 'network error (Failed to fetch)',
      declared: 'larger than 0 MB',
      stream: 'larger than 0 MB',
      slow: 'timed out',
      ok3: 'all images together exceed 0 MB',
    });
    expect(ok.map((a) => a.path)).toEqual(['assets/1/ok1.png', 'assets/1/ok2.png']);
  });

  it('rejects with an AbortError on cancel', async () => {
    const ac = new AbortController();
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          setTimeout(() => ac.abort(), 5);
        }),
    ) as unknown as typeof fetch;
    await expect(
      downloadAssets([{ url: `${site}/a.png`, path: 'assets/1/a.png' }], { concurrency: 1, fetchImpl, signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('format helpers', () => {
  it('maps formats to extensions, MIME types and labels', () => {
    expect(FORMATS.markdown).toMatchObject({ ext: 'md', mime: 'text/markdown;charset=utf-8' });
    expect(FORMATS.text).toMatchObject({ ext: 'txt', mime: 'text/plain;charset=utf-8' });
    expect(formatOf(undefined)).toBe('pdf');
    expect(formatOf({ format: 'bogus' as never })).toBe('pdf');
    expect(exportButtonLabel({ format: 'pdf', separateFiles: false })).toBe('Export PDF');
    expect(exportButtonLabel({ format: 'markdown', separateFiles: false })).toBe('Export Markdown');
    expect(exportButtonLabel({ format: 'text', separateFiles: false })).toBe('Export text');
    expect(exportButtonLabel({ format: 'text', separateFiles: true })).toBe('Export ZIP');
    expect(isCompressible('a/b.md')).toBe(true);
    expect(isCompressible('x.TXT')).toBe(true);
    expect(isCompressible('assets/1/i.png')).toBe(false);
  });
});
