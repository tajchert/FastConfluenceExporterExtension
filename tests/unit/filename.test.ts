import { describe, expect, it } from 'vitest';
import { buildFilename, sanitizeFilenamePart } from '../../lib/util/filename';

const DATE = new Date(2026, 9, 6, 12, 0, 0); // 2026-10-06 local

describe('sanitizeFilenamePart', () => {
  it('keeps unicode titles', () => {
    expect(sanitizeFilenamePart('Zażółć gęślą jaźń – 設計書 🚀')).toBe('Zażółć gęślą jaźń – 設計書 🚀');
  });

  it('removes Windows reserved characters', () => {
    expect(sanitizeFilenamePart('a<b>c"d?e*f')).toBe('abcdef');
    expect(sanitizeFilenamePart('Q1/Q2 plan: draft')).toBe('Q1-Q2 plan- draft');
    expect(sanitizeFilenamePart('back\\slash|pipe')).toBe('back-slash-pipe');
  });

  it('removes control and bidi characters', () => {
    expect(sanitizeFilenamePart('a\u0000b\tc\nd')).toBe('a b c d');
    expect(sanitizeFilenamePart('evil‮fdp.exe')).toBe('evilfdp.exe');
    expect(sanitizeFilenamePart('zero​width')).toBe('zerowidth');
  });

  it('collapses whitespace and underscores and trims', () => {
    expect(sanitizeFilenamePart('   many    spaces here  ')).toBe('many spaces here');
    expect(sanitizeFilenamePart('a___b _ c')).toBe('a_b_c');
    expect(sanitizeFilenamePart('--x--')).toBe('x');
  });

  it('strips leading dots and trailing dots/spaces', () => {
    expect(sanitizeFilenamePart('...hidden')).toBe('hidden');
    expect(sanitizeFilenamePart('name. . ')).toBe('name');
    expect(sanitizeFilenamePart('..')).toBe('');
  });

  it('renames Windows reserved device names', () => {
    expect(sanitizeFilenamePart('CON')).toBe('CON_');
    expect(sanitizeFilenamePart('lpt1')).toBe('lpt1_');
    expect(sanitizeFilenamePart('nul.txt')).toBe('nul_.txt');
    // The extension stays last (bundled images must keep theirs).
    expect(sanitizeFilenamePart('CON.png')).toBe('CON_.png');
    expect(sanitizeFilenamePart('aux.jpg')).toBe('aux_.jpg');
    expect(sanitizeFilenamePart('Com1.tar.gz')).toBe('Com1_.tar.gz');
    expect(sanitizeFilenamePart('console.png')).toBe('console.png');
    expect(sanitizeFilenamePart('Console')).toBe('Console');
  });

  it('truncates by code points without splitting surrogate pairs', () => {
    const s = '😀'.repeat(20);
    const out = sanitizeFilenamePart(s, 5);
    expect(Array.from(out)).toHaveLength(5);
    expect(out).toBe('😀'.repeat(5));
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeFilenamePart('')).toBe('');
    expect(sanitizeFilenamePart('???')).toBe('');
  });
});

describe('buildFilename', () => {
  it('builds {spaceKey}_{title}_{date}.pdf', () => {
    expect(buildFilename({ spaceKey: 'ENG', title: 'Checkout v3 – Tech Spec', date: DATE, ext: 'pdf' })).toBe(
      'ENG_Checkout v3 – Tech Spec_2026-10-06.pdf',
    );
  });

  it('omits a missing space key', () => {
    expect(buildFilename({ title: 'Home', date: DATE, ext: 'zip' })).toBe('Home_2026-10-06.zip');
  });

  it('falls back to a default title', () => {
    expect(buildFilename({ spaceKey: 'X', title: '///', date: DATE, ext: 'pdf' })).toBe(
      'X_Confluence export_2026-10-06.pdf',
    );
  });

  it('handles personal space keys and reserved titles', () => {
    expect(buildFilename({ spaceKey: '~jdoe', title: 'CON', date: DATE, ext: 'pdf' })).toBe('~jdoe_CON_2026-10-06.pdf');
  });

  it('never exceeds 150 characters and keeps the date and extension', () => {
    const name = buildFilename({ spaceKey: 'LONGKEY', title: 'x'.repeat(500), date: DATE, ext: 'pdf' });
    expect(name.length).toBeLessThanOrEqual(150);
    expect(name.startsWith('LONGKEY_x')).toBe(true);
    expect(name.endsWith('_2026-10-06.pdf')).toBe(true);
  });

  it('supports Markdown and text extensions', () => {
    expect(buildFilename({ spaceKey: 'COC', title: 'Community Over Code Home', date: DATE, ext: 'md' })).toBe(
      'COC_Community Over Code Home_2026-10-06.md',
    );
    expect(buildFilename({ spaceKey: 'COC', title: 'Notes: Q1/Q2', date: DATE, ext: 'txt' })).toBe('COC_Notes- Q1-Q2_2026-10-06.txt');
    const long = buildFilename({ spaceKey: 'K', title: 'y'.repeat(400), date: DATE, ext: 'md' });
    expect(long.length).toBeLessThanOrEqual(150);
    expect(long.endsWith('_2026-10-06.md')).toBe(true);
  });

  it('pads month and day', () => {
    expect(buildFilename({ title: 'T', date: new Date(2026, 0, 2), ext: 'pdf' })).toBe('T_2026-01-02.pdf');
  });
});
