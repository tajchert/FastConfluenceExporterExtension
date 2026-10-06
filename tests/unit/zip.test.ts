import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipFiles } from '../../lib/pdf/zip';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('zipFiles', () => {
  it('stores files and de-duplicates names case-insensitively', () => {
    const zip = zipFiles([
      { name: 'Page.pdf', data: bytes('a') },
      { name: 'page.pdf', data: bytes('b') },
      { name: 'Page.pdf', data: bytes('c') },
      { name: 'Other', data: bytes('d') },
      { name: 'Other', data: bytes('e') },
    ]);
    const out = unzipSync(zip);
    expect(Object.keys(out).sort()).toEqual(['Other', 'Other (2)', 'Page (3).pdf', 'Page.pdf', 'page (2).pdf'].sort());
    expect(new TextDecoder().decode(out['Page (3).pdf'])).toBe('c');
  });

  it('uses stored entries (level 0) — data appears verbatim', () => {
    const data = bytes('%PDF-1.7 unique-marker-1234567890');
    const zip = zipFiles([{ name: 'x.pdf', data }]);
    const hay = new TextDecoder('latin1').decode(zip);
    expect(hay).toContain('unique-marker-1234567890');
    // Local file header compression method (offset 8) = 0 (stored)
    expect(zip[8] | (zip[9] << 8)).toBe(0);
  });

  it('keeps unicode names and flattens path separators', () => {
    const out = unzipSync(
      zipFiles([
        { name: 'ENG_Zażółć gęślą.pdf', data: bytes('1') },
        { name: '../evil/name.pdf', data: bytes('2') },
        { name: '', data: bytes('3') },
      ]),
    );
    expect(Object.keys(out)).toEqual(['ENG_Zażółć gęślą.pdf', '_evil_name.pdf', 'file']);
  });

  it('produces a valid empty archive', () => {
    expect(Object.keys(unzipSync(zipFiles([])))).toEqual([]);
  });
});
