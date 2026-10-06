import { describe, expect, it } from 'vitest';
import { isAbortError, sleep, throwIfAborted } from '../../lib/util/abort';
import { createPool, mapPool } from '../../lib/util/pool';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('createPool', () => {
  it('limits concurrency and returns results', async () => {
    const limit = createPool(2);
    let active = 0;
    let peak = 0;
    const task = (v: number) => async () => {
      active++;
      peak = Math.max(peak, active);
      await tick(5);
      active--;
      return v * 2;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((v) => limit(task(v))));
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  it('propagates errors without blocking the queue', async () => {
    const limit = createPool(1);
    const a = limit(async () => {
      throw new Error('boom');
    });
    const b = limit(async () => 'ok');
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('ok');
  });

  it('treats invalid concurrency as 1', async () => {
    const limit = createPool(0);
    await expect(limit(async () => 1)).resolves.toBe(1);
  });
});

describe('mapPool', () => {
  it('preserves order with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([30, 10, 20, 5], 3, async (ms, i) => {
      active++;
      peak = Math.max(peak, active);
      await tick(ms);
      active--;
      return `${i}:${ms}`;
    });
    expect(out).toEqual(['0:30', '1:10', '2:20', '3:5']);
    expect(peak).toBe(3);
  });

  it('handles empty input', async () => {
    await expect(mapPool([], 4, async () => 1)).resolves.toEqual([]);
  });

  it('rejects with the first error and stops starting new items', async () => {
    const started: number[] = [];
    await expect(
      mapPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        await tick(1);
        if (n === 2) throw new Error('fail 2');
        return n;
      }),
    ).rejects.toThrow('fail 2');
    await tick(10);
    expect(started.length).toBeLessThan(6);
  });

  it('rejects with AbortError when the signal aborts', async () => {
    const ac = new AbortController();
    const p = mapPool([1, 2, 3], 1, async () => {
      await tick(20);
      return 1;
    }, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(mapPool([1], 1, async () => 1, ac.signal)).rejects.toSatisfy(isAbortError);
  });
});

describe('abort helpers', () => {
  it('throwIfAborted throws an AbortError', () => {
    const ac = new AbortController();
    expect(() => throwIfAborted(ac.signal)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    ac.abort();
    try {
      throwIfAborted(ac.signal);
      expect.unreachable();
    } catch (e) {
      expect(isAbortError(e)).toBe(true);
      expect(e).toBeInstanceOf(DOMException);
    }
  });

  it('sleep resolves and can be aborted', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
  });

  it('isAbortError ignores other errors', () => {
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(new DOMException('t', 'TimeoutError'))).toBe(false);
  });
});
