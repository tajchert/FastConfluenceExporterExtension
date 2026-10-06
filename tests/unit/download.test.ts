import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DownloadModule = typeof import('../../lib/download');

let dl: DownloadModule;
let onChanged: ((d: chrome.downloads.DownloadDelta) => void)[];
let items: Map<number, { state: string; exists?: boolean }>;
let calls: string[];
let offscreenOpen: boolean;

beforeEach(async () => {
  vi.resetModules();
  onChanged = [];
  items = new Map();
  calls = [];
  offscreenOpen = false;
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      getContexts: async () => (offscreenOpen ? [{}] : []),
      sendMessage: async (msg: { type: string; url?: string }) => {
        calls.push(msg.type);
        return { ok: true, value: msg.type === 'blob/end' ? { url: 'blob:x' } : undefined };
      },
    },
    offscreen: {
      Reason: { BLOBS: 'BLOBS' },
      createDocument: async () => {
        offscreenOpen = true;
        calls.push('create');
      },
      closeDocument: async () => {
        offscreenOpen = false;
        calls.push('close');
      },
    },
    downloads: {
      download: async () => {
        items.set(5, { state: 'in_progress' });
        return 5;
      },
      search: async ({ id }: { id: number }) => (items.has(id) ? [{ id, ...items.get(id) }] : []),
      onChanged: {
        addListener: (fn: (d: chrome.downloads.DownloadDelta) => void) => onChanged.push(fn),
        removeListener: (fn: (d: chrome.downloads.DownloadDelta) => void) => (onChanged = onChanged.filter((f) => f !== fn)),
      },
      cancel: vi.fn(async (id: number) => {
        calls.push(`cancel:${id}`);
      }),
      erase: vi.fn(async () => {
        calls.push('erase');
        return [];
      }),
      show: vi.fn(),
    },
  });
  dl = await import('../../lib/download');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bytes = new TextEncoder().encode('%PDF-1.7');
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('saveBytes', () => {
  it('waits for the download to complete, then revokes the blob and closes the offscreen document', async () => {
    const p = dl.saveBytes(bytes, 'a.pdf', 'application/pdf');
    await tick();
    expect(calls).not.toContain('blob/revoke');
    onChanged.forEach((f) => f({ id: 5, state: { current: 'complete' } } as chrome.downloads.DownloadDelta));
    await expect(p).resolves.toBe(5);
    expect(calls.slice(-2)).toEqual(['blob/revoke', 'close']);
  });

  it('has no timeout: a "Save as" dialog left open is not reported as success', async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = dl.saveBytes(bytes, 'a.pdf', 'application/pdf').finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(settled).toBe(false);
    onChanged.forEach((f) => f({ id: 5, state: { current: 'complete' } } as chrome.downloads.DownloadDelta));
    await expect(p).resolves.toBe(5);
    vi.useRealTimers();
  });

  it('cancels the download when the export is cancelled', async () => {
    const ac = new AbortController();
    const p = dl.saveBytes(bytes, 'a.pdf', 'application/pdf', ac.signal);
    await tick();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toContain('cancel:5');
    expect(calls).toContain('erase');
    expect(calls.indexOf('cancel:5')).toBeLessThan(calls.indexOf('blob/revoke'));
  });

  it('reports a user-cancelled "Save as" as DownloadInterruptedError', async () => {
    const p = dl.saveBytes(bytes, 'a.pdf', 'application/pdf');
    await tick();
    onChanged.forEach((f) => f({ id: 5, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } } as chrome.downloads.DownloadDelta));
    await expect(p).rejects.toMatchObject({ code: 'DOWNLOAD_INTERRUPTED', reason: 'USER_CANCELED' });
  });

  it('keeps the offscreen document while another save is still running', async () => {
    const first = dl.saveBytes(bytes, 'a.pdf', 'application/pdf');
    const second = dl.saveBytes(bytes, 'b.pdf', 'application/pdf');
    await tick();
    onChanged.forEach((f) => f({ id: 5, state: { current: 'complete' } } as chrome.downloads.DownloadDelta));
    await Promise.all([first, second]);
    expect(calls.filter((c) => c === 'create')).toHaveLength(1);
    expect(calls.filter((c) => c === 'close')).toHaveLength(1);
    expect(calls.at(-1)).toBe('close');
  });
});

describe('showDownloadItem', () => {
  it('shows only a completed download that still exists', async () => {
    items.set(1, { state: 'complete' });
    items.set(2, { state: 'complete', exists: false });
    items.set(3, { state: 'interrupted' });
    expect(await dl.showDownloadItem(1)).toBe(true);
    expect(await dl.showDownloadItem(2)).toBe(false);
    expect(await dl.showDownloadItem(3)).toBe(false);
    expect(await dl.showDownloadItem(4)).toBe(false); // erased from the history
    expect(await dl.showDownloadItem(undefined)).toBe(false);
    expect(chrome.downloads.show).toHaveBeenCalledTimes(1);
  });
});
