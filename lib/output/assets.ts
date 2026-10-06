/**
 * Image downloads for Markdown exports with "Include images" (runs in the worker tab, which sits
 * on the Confluence origin).
 *
 * `credentials: 'same-origin'`: the session cookie goes to Confluence attachment URLs, but not to
 * the hosts a redirect leads to. Cloud attachments answer 302 → `api.media.atlassian.com/…?token=…`
 * (the token authorizes the read), which sends `Access-Control-Allow-Origin: *`; a credentialed
 * request would be rejected there by CORS. Only images on the Confluence site are requested
 * (`allowedOrigin`; the converter bundles no others): a cross-origin fetch from this tab would
 * send the Confluence origin to the other host. Failed images keep their absolute URL in the
 * Markdown (reported as degraded, never fatal).
 */
import { mapPool } from '../util/pool';

export interface AssetRequest {
  /** Absolute image URL. */
  url: string;
  /** Relative path in the output bundle. */
  path: string;
}

export interface DownloadedAsset extends AssetRequest {
  bytes: Uint8Array;
}

export interface FailedAsset extends AssetRequest {
  reason: string;
}

export interface AssetLimits {
  /** Per-image timeout (headers and body), ms. */
  timeoutMs: number;
  /** Largest single image, bytes. */
  maxBytes: number;
  /** Largest total of all images, bytes. */
  maxTotalBytes: number;
}

export const DEFAULT_ASSET_LIMITS: AssetLimits = {
  timeoutMs: 60_000,
  maxBytes: 25 * 1024 * 1024,
  maxTotalBytes: 300 * 1024 * 1024,
};

export interface DownloadAssetsOptions {
  concurrency: number;
  signal?: AbortSignal;
  limits?: Partial<AssetLimits>;
  onProgress?: (done: number, total: number, current?: string) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Only URLs on this origin are requested (the Confluence site); others fail without a request.
   * Redirects (Cloud's media service) are still followed.
   */
  allowedOrigin?: string;
}

class AssetError extends Error {}

function mb(n: number): string {
  return `${Math.round(n / (1024 * 1024))} MB`;
}

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

/**
 * Downloads every asset (de-duplicated by path, first URL wins). One failing image never fails
 * the others; a cancel (`signal`) rejects with an AbortError.
 */
export async function downloadAssets(
  assets: AssetRequest[],
  o: DownloadAssetsOptions,
): Promise<{ ok: DownloadedAsset[]; failed: FailedAsset[] }> {
  const limits: AssetLimits = { ...DEFAULT_ASSET_LIMITS, ...(o.limits ?? {}) };
  const doFetch = o.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const seen = new Set<string>();
  const unique = assets.filter((a) => (seen.has(a.path) ? false : (seen.add(a.path), true)));
  const total = unique.length;
  let done = 0;
  let totalBytes = 0;
  const ok: DownloadedAsset[] = [];
  const failed: FailedAsset[] = [];

  const fetchOne = async (asset: AssetRequest): Promise<Uint8Array> => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limits.timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(asset.url, {
          credentials: 'same-origin',
          redirect: 'follow',
          // Like the print document: other hosts don't learn the Confluence address.
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: { Accept: 'image/*,*/*;q=0.8' },
        });
      } catch (e) {
        if (o.signal?.aborted) throw abortError();
        if (timedOut) throw new AssetError('timed out');
        throw new AssetError(e instanceof Error && e.message ? `network error (${e.message})` : 'network error');
      }
      if (!res.ok) throw new AssetError(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      // A login or error page instead of the image (e.g. an expired session behind a proxy).
      if (type.startsWith('text/html')) throw new AssetError('not an image (got an HTML page)');
      const declared = Number(res.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > limits.maxBytes) {
        controller.abort();
        throw new AssetError(`larger than ${mb(limits.maxBytes)}`);
      }
      try {
        return await readLimited(res, limits.maxBytes, () => controller.abort());
      } catch (e) {
        if (o.signal?.aborted) throw abortError();
        if (timedOut) throw new AssetError('timed out');
        throw e instanceof AssetError ? e : new AssetError(e instanceof Error ? e.message : 'read failed');
      }
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
    }
  };

  await mapPool(
    unique,
    Math.max(1, o.concurrency || 1),
    async (asset) => {
      if (o.signal?.aborted) throw abortError();
      try {
        if (o.allowedOrigin && originOf(asset.url) !== o.allowedOrigin) throw new AssetError('not on the Confluence site');
        if (totalBytes >= limits.maxTotalBytes) throw new AssetError(`all images together exceed ${mb(limits.maxTotalBytes)}`);
        const bytes = await fetchOne(asset);
        if (totalBytes + bytes.length > limits.maxTotalBytes) {
          throw new AssetError(`all images together exceed ${mb(limits.maxTotalBytes)}`);
        }
        totalBytes += bytes.length;
        ok.push({ ...asset, bytes });
      } catch (e) {
        if (o.signal?.aborted || (e as { name?: string })?.name === 'AbortError') throw abortError();
        failed.push({ ...asset, reason: e instanceof Error ? e.message : String(e) });
      }
      done++;
      o.onProgress?.(done, total, asset.path.split('/').pop());
    },
    o.signal,
  );
  // Keep the converter's order (deterministic output) regardless of completion order.
  const order = new Map(unique.map((a, i) => [a.path, i]));
  ok.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
  failed.sort((a, b) => order.get(a.path)! - order.get(b.path)!);
  return { ok, failed };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Reads a body, giving up as soon as it grows beyond `maxBytes`. */
async function readLimited(res: Response, maxBytes: number, cancel: () => void): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new AssetError(`larger than ${mb(maxBytes)}`);
    return buf;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      cancel();
      await reader.cancel().catch(() => undefined);
      throw new AssetError(`larger than ${mb(maxBytes)}`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
