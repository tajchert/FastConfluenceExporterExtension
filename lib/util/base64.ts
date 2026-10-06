/**
 * Base64 helpers that work in every context (service worker, pages, content scripts) and on
 * large inputs (100 MB PDFs) without "Maximum call stack size exceeded" or giant intermediate
 * binary strings.
 */

/** Bytes per btoa() call. Multiple of 3 so the per-chunk outputs concatenate without padding. */
const ENCODE_CHUNK = 3 * 16 * 1024;

type Base64Uint8Array = Uint8Array & { toBase64?: () => string };
type Base64Uint8ArrayCtor = typeof Uint8Array & { fromBase64?: (s: string) => Uint8Array };

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Base64Uint8Array).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK) {
    const chunk = bytes.subarray(i, i + ENCODE_CHUNK);
    let bin = '';
    // Small fixed-size slices for fromCharCode keep argument lists well under engine limits.
    for (let j = 0; j < chunk.length; j += 8192) {
      bin += String.fromCharCode.apply(null, chunk.subarray(j, j + 8192) as unknown as number[]);
    }
    parts.push(btoa(bin));
  }
  return parts.join('');
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\s]/g, '');
  const native = (Uint8Array as Base64Uint8ArrayCtor).fromBase64;
  if (typeof native === 'function') return native(clean);
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url(JSON) — compact and safe to put in a query string (`preview.html?req=`). */
export function encodeRequestParam(req: unknown): string {
  const json = JSON.stringify(req);
  if (json === undefined) throw new TypeError('Cannot encode an undefined request');
  return bytesToBase64(new TextEncoder().encode(json))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeRequestParam<T>(s: string): T {
  let b64 = s.trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 1) throw new Error('Invalid request parameter');
  if (pad) b64 += '='.repeat(4 - pad);
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(b64));
  } catch {
    throw new Error('Invalid request parameter');
  }
  return JSON.parse(json) as T;
}
