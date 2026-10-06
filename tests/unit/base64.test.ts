import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, decodeRequestParam, encodeRequestParam } from '../../lib/util/base64';

describe('base64', () => {
  it('round-trips arbitrary bytes and matches Node’s encoder', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37 + 11) & 0xff);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64ToBytes(b64)).toEqual(bytes);
  });

  it('handles empty input and all padding lengths', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array());
    for (const n of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(n).fill(250);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('encodes large buffers across chunk boundaries without stack overflow', () => {
    const size = 5 * 1024 * 1024 + 7;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31) & 0xff;
    const b64 = bytesToBase64(bytes);
    expect(b64.length).toBe(Math.ceil(size / 3) * 4);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    const back = base64ToBytes(b64);
    expect(back.length).toBe(size);
    expect(back[size - 1]).toBe(bytes[size - 1]);
  });

  it('ignores whitespace when decoding', () => {
    expect(base64ToBytes('SGVs\nbG8=')).toEqual(new TextEncoder().encode('Hello'));
  });
});

describe('request param', () => {
  it('round-trips unicode JSON as url-safe text', () => {
    const req = { title: 'Zażółć gęślą jaźń ✓ 📄', ids: ['1', '2'], nested: { a: '?&=/+' } };
    const s = encodeRequestParam(req);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRequestParam<typeof req>(s)).toEqual(req);
  });

  it('rejects garbage', () => {
    expect(() => decodeRequestParam('a')).toThrow();
    expect(() => decodeRequestParam('////')).toThrow();
  });
});
