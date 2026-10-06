/**
 * ZIP bundling for "separate files" exports (FR-11). PDFs are already compressed, so entries are
 * stored (level 0): fast and no size gain is lost.
 */
import { zipSync, type Zippable } from 'fflate';

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** Flat, safe entry name: no directories, no leading dots, never empty. */
function safeEntryName(name: string): string {
  const flat = name
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  return flat || 'file';
}

/** Zips the files with unique names (`a.pdf`, `a (2).pdf`, …; case-insensitive). */
export function zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const used = new Set<string>();
  const entries: Zippable = {};
  const mtime = new Date();
  for (const f of files) {
    const name = safeEntryName(f.name);
    let unique = name;
    if (used.has(unique.toLowerCase())) {
      const [stem, ext] = splitExt(name);
      for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${stem} (${n})${ext}`;
    }
    used.add(unique.toLowerCase());
    entries[unique] = [f.data, { level: 0, mtime }];
  }
  return zipSync(entries);
}
