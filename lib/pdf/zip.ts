/**
 * ZIP bundling for "separate files" exports (FR-11) and Markdown exports with images. PDFs and
 * images are already compressed, so they are stored (no deflate): fast and no size gain is lost.
 * Text entries (`compress: true`: Markdown, plain text, SVG) are deflated. Files are added one by
 * one with a yield to the event loop in between, so a big archive never blocks the service worker
 * (a cancel is handled at once). fflate's async API needs Web Workers, which a service worker does
 * not have; its synchronous streaming classes are used instead.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export interface ZipEntry {
  /**
   * Relative POSIX path inside the archive (`assets/123/image.png`). Directories are kept; `.`,
   * `..` and empty segments are dropped, so an entry can never point outside the archive.
   */
  name: string;
  data: Uint8Array;
  /** Deflate this entry (text). Default: stored. */
  compress?: boolean;
}

/** Deflate level for text entries: a good ratio at a fraction of level 9's time. */
const DEFLATE_LEVEL = 6;

function splitExt(name: string): [string, string] {
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  return dot > slash + 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** One path segment: no control characters, no leading dots or spaces. */
function safeSegment(segment: string): string {
  return segment
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
}

/** Safe relative entry path: no absolute paths, no traversal, never empty. */
function safeEntryName(name: string): string {
  const parts = name
    .split(/[\\/]+/)
    .map(safeSegment)
    .filter((s) => s !== '');
  return parts.join('/') || 'file';
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Zips the files with unique names (`a.pdf`, `a (2).pdf`, …; case-insensitive, per full path). */
export async function zipFiles(files: ZipEntry[], signal?: AbortSignal): Promise<Uint8Array> {
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
    const entry = f.compress ? new ZipDeflate(unique, { level: DEFLATE_LEVEL }) : new ZipPassThrough(unique);
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
