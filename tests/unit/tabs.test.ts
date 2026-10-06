import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { closeOrphanTabs, markUrl, openWorkerTab, registerOrphan, waitForTabComplete } from '../../lib/render/tabs';
import type { SiteInfo } from '../../lib/types';

describe('waitForTabComplete', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves through polling when the "complete" event was missed', async () => {
    // Seen in real Chrome: a lazily added onUpdated listener is registered after the event fired,
    // and the first tabs.get still answered "loading".
    let calls = 0;
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => {
      calls++;
      return { id, status: calls < 3 ? 'loading' : 'complete' } as chrome.tabs.Tab;
    }) as never);
    const done = vi.fn();
    const p = waitForTabComplete(7, 30_000).then(done);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ id: 7, status: 'complete' }));
  });

  it('still times out when the tab never completes, and stops polling afterwards', async () => {
    const get = vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => ({ id, status: 'loading' }) as chrome.tabs.Tab) as never);
    const p = waitForTabComplete(7, 2000);
    const assertion = expect(p).rejects.toThrow(/did not finish loading within 2 s/);
    await vi.advanceTimersByTimeAsync(2100);
    await assertion;
    const n = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(get.mock.calls.length).toBe(n);
  });

  it('rejects when the tab is gone', async () => {
    vi.spyOn(chrome.tabs, 'get').mockRejectedValue(new Error('No tab with id: 7.'));
    await expect(waitForTabComplete(7, 2000)).rejects.toThrow(/helper tab was closed/);
  });
});

describe('helper tab bookkeeping', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('markUrl replaces any fragment with the marker', () => {
    expect(markUrl('https://x/wiki/rest/api/space?limit=1', '#cfp-worker')).toBe('https://x/wiki/rest/api/space?limit=1#cfp-worker');
    expect(markUrl('https://x/wiki/spaces/A/pages/1#Heading', '#cfp-live')).toBe('https://x/wiki/spaces/A/pages/1#cfp-live');
  });

  it('closes recorded orphans and marked tabs restored after a browser restart', async () => {
    await registerOrphan(3);
    vi.spyOn(chrome.tabs, 'query').mockImplementation((async () => [
      { id: 10, url: 'https://x/wiki/rest/api/space?limit=1#cfp-worker' },
      { id: 11, url: 'https://x/wiki/spaces/A/pages/1#cfp-live' },
      { id: 12, url: 'https://x/wiki/spaces/A/pages/1' },
      { id: 13 }, // no host access: no URL
    ]) as never);
    const removed: number[] = [];
    vi.spyOn(chrome.tabs, 'remove').mockImplementation((async (id: number) => {
      removed.push(id);
    }) as never);
    expect(await closeOrphanTabs()).toBe(3);
    expect(removed.sort()).toEqual([10, 11, 3]);
  });

  it('closes the worker tab it is opening when the export is cancelled', async () => {
    const site: SiteInfo = { origin: 'https://x', baseUrl: 'https://x/wiki', contextPath: '/wiki', flavour: 'cloud' };
    const created: string[] = [];
    vi.spyOn(chrome.tabs, 'create').mockImplementation((async (p: chrome.tabs.CreateProperties) => {
      created.push(p.url!);
      return { id: 77, status: 'loading' } as chrome.tabs.Tab;
    }) as never);
    vi.spyOn(chrome.tabs, 'update').mockImplementation((async () => ({})) as never);
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async () => ({ id: 77, status: 'loading' })) as never);
    const removed: number[] = [];
    vi.spyOn(chrome.tabs, 'remove').mockImplementation((async (id: number) => {
      removed.push(id);
    }) as never);
    const ac = new AbortController();
    const p = openWorkerTab(site, undefined, ac.signal);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(created).toEqual(['https://x/wiki/api/v2/spaces?limit=1#cfp-worker']);
    expect(removed).toEqual([77]);
  });
});
