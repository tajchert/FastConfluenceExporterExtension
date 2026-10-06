/**
 * Moving the files of a Markdown / text export from the worker tab to the service worker in
 * bounded messages (`worker/readOutput`). Extension messages are JSON: bytes travel as base64,
 * at most READ_OUTPUT_MAX_BYTES raw bytes per answer. Pure: shared by the worker tab (packing)
 * and the service worker (unpacking), unit-tested without Chrome.
 */
import { READ_OUTPUT_MAX_BYTES, type OutputEntry, type ReadOutputResponse } from '../messages';
import { base64ToBytes, bytesToBase64 } from '../util/base64';

/** Worker side: the chunks starting at entry `index`, byte `offset`. */
export function readOutputChunks(
  data: readonly Uint8Array[],
  index: number,
  offset: number,
  maxBytes: number = READ_OUTPUT_MAX_BYTES,
): ReadOutputResponse {
  const budget = Math.max(1, Math.min(READ_OUTPUT_MAX_BYTES, Math.floor(maxBytes) || READ_OUTPUT_MAX_BYTES));
  const chunks: ReadOutputResponse['chunks'] = [];
  let used = 0;
  let i = Math.max(0, Math.floor(index));
  let off = Math.max(0, Math.floor(offset));
  while (i < data.length && used < budget) {
    const bytes = data[i];
    if (off >= bytes.length) {
      // Empty entries (or a finished one) still get one chunk so the reader sees them.
      if (off === 0) chunks.push({ index: i, offset: 0, base64: '' });
      i++;
      off = 0;
      continue;
    }
    const n = Math.min(bytes.length - off, budget - used);
    chunks.push({ index: i, offset: off, base64: bytesToBase64(bytes.subarray(off, off + n)) });
    used += n;
    off += n;
    if (off >= bytes.length) {
      i++;
      off = 0;
    }
  }
  return { chunks, next: i < data.length ? { index: i, offset: off } : null };
}

/**
 * Service-worker side: reads every entry through `read` (one `worker/readOutput` per call) and
 * returns their bytes, in entry order. Sizes come from the convert result, so each buffer is
 * allocated once.
 */
export async function collectOutput(
  entries: readonly OutputEntry[],
  read: (index: number, offset: number) => Promise<ReadOutputResponse>,
  signal?: AbortSignal,
): Promise<Uint8Array[]> {
  const out = entries.map((e) => new Uint8Array(e.size));
  if (!entries.length) return out;
  let cursor: { index: number; offset: number } | null = { index: 0, offset: 0 };
  while (cursor) {
    if (signal?.aborted) throw new DOMException('The export was cancelled.', 'AbortError');
    const res: ReadOutputResponse = await read(cursor.index, cursor.offset);
    if (!res.chunks.length && res.next && res.next.index === cursor.index && res.next.offset === cursor.offset) {
      throw new Error('The export helper tab returned no data.');
    }
    for (const c of res.chunks) {
      const target = out[c.index];
      if (!target) throw new Error('The export helper tab returned an unknown file.');
      const bytes = base64ToBytes(c.base64);
      if (c.offset + bytes.length > target.length) throw new Error('The export helper tab returned more data than expected.');
      target.set(bytes, c.offset);
    }
    cursor = res.next;
  }
  return out;
}
