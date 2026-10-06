import { abortError, throwIfAborted } from './abort';

function normalizeConcurrency(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Returns a limiter: `limit(() => work())` runs at most `concurrency` tasks at a time,
 * in submission order.
 */
export function createPool(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = normalizeConcurrency(concurrency);
  let active = 0;
  const queue: (() => void)[] = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
}

/**
 * Maps `items` through `fn` with bounded concurrency, preserving order in the result.
 * Rejects with the first error thrown by `fn` (no further items are started), or with an
 * AbortError as soon as `signal` aborts.
 */
export async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  throwIfAborted(signal);
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped) {
      throwIfAborted(signal);
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (e) {
        stopped = true;
        throw e;
      }
    }
  };

  const workers = Array.from({ length: Math.min(items.length, normalizeConcurrency(concurrency)) }, worker);
  const all = Promise.all(workers).then(() => results);
  if (!signal) return all;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      stopped = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([all, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
    // Swallow late rejections from workers still finishing after an abort/failure.
    all.catch(() => undefined);
  }
}
