import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipFiles } from '../../lib/pdf/zip';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('zipFiles', () => {
  it('stores files and de-duplicates names case-insensitively', async () => {
    const zip = await zipFiles([
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

  it('uses stored entries (level 0) — data appears verbatim', async () => {
    const data = bytes('%PDF-1.7 unique-marker-1234567890');
    const zip = await zipFiles([{ name: 'x.pdf', data }]);
    const hay = new TextDecoder('latin1').decode(zip);
    expect(hay).toContain('unique-marker-1234567890');
    // Local file header compression method (offset 8) = 0 (stored)
    expect(zip[8] | (zip[9] << 8)).toBe(0);
  });

  it('keeps unicode names and directories, never a path outside the archive', async () => {
    const out = unzipSync(
      await zipFiles([
        { name: 'ENG_Zażółć gęślą.pdf', data: bytes('1') },
        { name: '../evil/name.pdf', data: bytes('2') },
        { name: '', data: bytes('3') },
        { name: '/abs/./x\\..\\y.png', data: bytes('4') },
        { name: 'assets/12/.hidden.png', data: bytes('5') },
      ]),
    );
    expect(Object.keys(out)).toEqual(['ENG_Zażółć gęślą.pdf', 'evil/name.pdf', 'file', 'abs/x/y.png', 'assets/12/hidden.png']);
  });

  it('de-duplicates per full path and keeps the extension after a directory with a dot', async () => {
    const out = unzipSync(
      await zipFiles([
        { name: 'assets/1/a.png', data: bytes('1') },
        { name: 'assets/2/a.png', data: bytes('2') },
        { name: 'Assets/1/A.png', data: bytes('3') },
        { name: 'v1.2/readme', data: bytes('4') },
        { name: 'v1.2/readme', data: bytes('5') },
      ]),
    );
    expect(Object.keys(out)).toEqual(['assets/1/a.png', 'assets/2/a.png', 'Assets/1/A (2).png', 'v1.2/readme', 'v1.2/readme (2)']);
  });

  it('deflates entries marked compress and stores the others', async () => {
    const text = bytes('# Title\n\n' + 'lorem ipsum dolor sit amet '.repeat(400));
    const image = bytes('PNG-like-bytes-that-stay-verbatim-0123456789');
    const zip = await zipFiles([
      { name: 'doc.md', data: text, compress: true },
      { name: 'assets/1/i.png', data: image },
    ]);
    // Local header of the first entry: method 8 (deflate).
    expect(zip[8] | (zip[9] << 8)).toBe(8);
    expect(zip.length).toBeLessThan(text.length / 4);
    expect(new TextDecoder('latin1').decode(zip)).toContain('PNG-like-bytes-that-stay-verbatim-0123456789');
    const out = unzipSync(zip);
    expect(new TextDecoder().decode(out['doc.md'])).toBe(new TextDecoder().decode(text));
    expect(out['assets/1/i.png']).toEqual(image);
  });

  it('produces a valid empty archive', async () => {
    expect(Object.keys(unzipSync(await zipFiles([])))).toEqual([]);
  });

  it('stops when the signal aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(zipFiles([{ name: 'a.pdf', data: bytes('a') }], ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
