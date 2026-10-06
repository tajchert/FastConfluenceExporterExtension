/**
 * ZIP bundling for "separate files" exports (FR-11). PDFs are already compressed, so entries are
 * stored (no deflate): fast and no size gain is lost. Files are added one by one with a yield to
 * the event loop in between, so a big archive never blocks the service worker (a cancel is
 * handled at once). fflate's async API needs Web Workers, which a service worker does not have.
 */
import { Zip, ZipPassThrough } from 'fflate';

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

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Zips the files with unique names (`a.pdf`, `a (2).pdf`, …; case-insensitive). */
export async function zipFiles(files: { name: string; data: Uint8Array }[], signal?: AbortSignal): Promise<Uint8Array> {
  const used = new Set<string>();
  const mtime = new Date();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else {
      chunks.push(data);
      total += data.length;
    }
  });
  for (const f of files) {
    if (signal?.aborted) throw new DOMException('The export was cancelled.', 'AbortError');
    const name = safeEntryName(f.name);
    let unique = name;
    if (used.has(unique.toLowerCase())) {
      const [stem, ext] = splitExt(name);
      for (let n = 2; used.has(unique.toLowerCase()); n++) unique = `${stem} (${n})${ext}`;
    }
    used.add(unique.toLowerCase());
    const entry = new ZipPassThrough(unique);
    entry.mtime = mtime;
    zip.add(entry);
    entry.push(f.data, true);
    if (failure) throw failure;
    await tick();
  }
  zip.end();
  if (failure) throw failure;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
