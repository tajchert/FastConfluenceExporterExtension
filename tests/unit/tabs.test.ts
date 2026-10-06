import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { waitForTabComplete } from '../../lib/render/tabs';

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
    await expect(waitForTabComplete(7, 2000)).rejects.toThrow(/export tab was closed/);
  });
});
