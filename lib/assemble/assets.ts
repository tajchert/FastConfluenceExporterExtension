/**
 * Waits until every image in the print document has loaded (or replaces it with a placeholder)
 * and web fonts are ready, so `Page.printToPDF` never captures half-loaded content.
 *
 * Note: the worker tab is a background tab; `img.decode()` and requestAnimationFrame can stall
 * there, so success is judged from load/error events and `complete`/`naturalWidth`. Loaded
 * images are printed fine (Chrome decodes them at print time); decode() is only awaited, with a
 * short cap, for very large bitmaps and for SVGs that report no intrinsic size.
 */

import { refreshLayoutMarks } from './document';

const DEFAULT_TIMEOUT_MS = 15000;
const DECODE_CAP_MS = 300;
/** Bitmaps above this many pixels get a (capped) decode before printing. */
const LARGE_BITMAP_PIXELS = 4_000_000;
const FONTS_CAP_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Human-readable file name for a failed image. */
export function imageFileName(img: HTMLImageElement): string {
  const alias = (img.getAttribute('data-linked-resource-default-alias') || '').trim();
  if (alias) return alias;
  const src = (img.getAttribute('src') || '').trim();
  if (src.startsWith('data:')) return 'embedded image';
  if (src) {
    try {
      const u = new URL(src, img.ownerDocument.baseURI);
      const segments = u.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last) return safeDecode(last);
    } catch {
      /* fall through */
    }
  }
  const alt = (img.getAttribute('alt') || '').trim();
  return alt || 'image';
}

function isSvgSource(src: string): boolean {
  return /^data:image\/svg/i.test(src) || /\.svg(?:$|[?#])/i.test(src);
}

function isSmallIcon(img: HTMLImageElement): boolean {
  if (/(?:^|\s)(emoticon|icon|aui-icon)/i.test(img.className || '')) return true;
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  return (w > 0 && w <= 32) || (h > 0 && h <= 32);
}

type Outcome = 'ok' | 'failed' | 'pending';

function currentOutcome(img: HTMLImageElement): Outcome {
  const src = img.getAttribute('src');
  if (!src || !src.trim()) return 'failed';
  if (!img.complete) return 'pending';
  return img.naturalWidth > 0 ? 'ok' : 'failed';
}

/** Resolves when the image settles or the deadline passes. */
function settle(img: HTMLImageElement, deadline: number): Promise<Outcome> {
  const now = currentOutcome(img);
  if (now !== 'pending') return Promise.resolve(now);
  return new Promise<Outcome>((resolve) => {
    let done = false;
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      resolve(o);
    };
    const onLoad = () => finish('ok');
    const onError = () => finish('failed');
    const timer = setTimeout(() => finish(currentOutcome(img) === 'ok' ? 'ok' : 'pending'), Math.max(0, deadline - Date.now()));
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

/** Races `img.decode()` against a cap; true = decoded or undecidable, false = decode failed. */
async function decodes(img: HTMLImageElement, capMs: number): Promise<boolean> {
  if (typeof img.decode !== 'function') return true;
  const result = await Promise.race([
    img.decode().then(
      () => true,
      () => false,
    ),
    delay(capMs).then(() => true),
  ]);
  return result;
}

function replaceWithPlaceholder(img: HTMLImageElement): void {
  const doc = img.ownerDocument;
  if (isSmallIcon(img)) {
    // A box with a file name inside a table cell or a sentence would wreck the layout.
    const alt = (img.getAttribute('alt') || '').trim();
    const span = doc.createElement('span');
    span.className = 'cf-img-missing-inline';
    span.textContent = alt && !/\.(png|gif|jpe?g|svg|webp)$/i.test(alt) ? alt : '';
    img.replaceWith(span);
    return;
  }
  const name = imageFileName(img);
  const box = doc.createElement('span');
  box.className = 'cf-img-missing';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `Image not available: ${name}`);
  const label = doc.createElement('span');
  label.className = 'cf-img-missing-label';
  label.textContent = 'Image not available';
  const file = doc.createElement('span');
  file.className = 'cf-img-missing-name';
  file.textContent = name;
  box.append(label, file);
  img.replaceWith(box);
}

export async function waitForAssets(
  doc: Document,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ imageFailures: number }> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const images = Array.from(doc.querySelectorAll('img')) as HTMLImageElement[];

  for (const img of images) {
    // Responsive candidates could switch to a different (unloaded) file at print time.
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    if (img.getAttribute('loading') === 'lazy') img.removeAttribute('loading');
  }
  for (const source of Array.from(doc.querySelectorAll('picture > source'))) source.remove();

  const outcomes = await Promise.all(images.map((img) => settle(img, deadline)));

  const failed: HTMLImageElement[] = [];
  const loaded: HTMLImageElement[] = [];
  outcomes.forEach((o, i) => {
    const img = images[i]!;
    if (o === 'ok') loaded.push(img);
    else if (o === 'failed' && img.complete && img.getAttribute('src') && isSvgSource(img.getAttribute('src')!)) {
      // SVGs without intrinsic size report naturalWidth 0 even when fine: let decode() decide.
      loaded.push(img);
    } else failed.push(img);
  });

  // Decode only what may need it: very large bitmaps (so they are not printed blank) and SVGs
  // without an intrinsic size (decode() tells whether they are fine). Capped for background tabs;
  // a fully loaded image of ordinary size costs no wait at all.
  const toDecode = loaded.filter(
    (img) => !(img.naturalWidth > 0) || img.naturalWidth * img.naturalHeight > LARGE_BITMAP_PIXELS,
  );
  if (toDecode.length > 0) {
    const cap = Math.min(DECODE_CAP_MS, Math.max(100, deadline - Date.now()));
    const results = await Promise.all(toDecode.map((img) => decodes(img, cap)));
    results.forEach((ok, i) => {
      const img = toDecode[i]!;
      if (!ok && !(img.naturalWidth > 0)) failed.push(img);
    });
  }

  for (const img of failed) {
    if (!img.isConnected) continue;
    replaceWithPlaceholder(img);
    // Stop any in-flight request of the now detached image.
    img.removeAttribute('src');
  }

  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts?.ready) {
    const cap = Math.min(FONTS_CAP_MS, Math.max(100, deadline - Date.now()));
    await Promise.race([fonts.ready.then(() => undefined, () => undefined), delay(cap)]);
  }

  // Image sizes are final now: re-measure wide tables and keep-together blocks.
  refreshLayoutMarks(doc);

  return { imageFailures: failed.length };
}
