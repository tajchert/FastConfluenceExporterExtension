/**
 * Saving generated files from the service worker. The SW cannot create blob: URLs, so the bytes
 * are streamed (base64 chunks) to the offscreen document, which returns a blob URL for
 * chrome.downloads. No `saveAs` → Chrome's own "Ask where to save each file" setting applies.
 */
import { callOffscreen } from './rpc';
import { bytesToBase64 } from './util/base64';

const OFFSCREEN_PATH = 'offscreen.html';
/** Raw bytes per message (≈ 11 MB of base64, below the 64 MiB message limit). */
const CHUNK_BYTES = 8 * 1024 * 1024;

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

export class DownloadInterruptedError extends Error {
  readonly code = 'DOWNLOAD_INTERRUPTED';
  constructor(
    message: string,
    readonly reason: string,
    readonly downloadId: number,
  ) {
    super(message);
    this.name = 'DownloadInterruptedError';
  }
}

let activeSaves = 0;
/**
 * Creating and closing the offscreen document are serialized on one chain, so a save that starts
 * while another one is closing the document never sends its chunks to a document being closed.
 */
let offscreenChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = offscreenChain.then(fn, fn);
  offscreenChain = run.catch(() => undefined);
  return run;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
      documentUrls: [url],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

function ensureOffscreen(): Promise<void> {
  return serialized(async () => {
    if (await hasOffscreenDocument()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Create blob URLs for downloading generated PDF files',
      });
    } catch (e) {
      // Another context created it meanwhile — fine.
      if (!/single offscreen|already/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  });
}

function closeOffscreenIfIdle(): Promise<void> {
  return serialized(async () => {
    if (activeSaves > 0) return;
    try {
      // Re-checked after the await as well: a save may have started in between.
      if ((await hasOffscreenDocument()) && activeSaves === 0) await chrome.offscreen.closeDocument();
    } catch {
      /* already closed */
    }
  });
}

async function toBlobUrl(bytes: Uint8Array, mime: string, signal?: AbortSignal): Promise<string> {
  const id = crypto.randomUUID();
  await callOffscreen({ target: 'offscreen', type: 'blob/begin', id, mime });
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    if (signal?.aborted) throw abortError();
    await callOffscreen({
      target: 'offscreen',
      type: 'blob/chunk',
      id,
      base64: bytesToBase64(bytes.subarray(i, i + CHUNK_BYTES)),
    });
  }
  const { url } = await callOffscreen({ target: 'offscreen', type: 'blob/end', id });
  return url;
}

type FinalState = { state: 'complete' } | { state: 'interrupted'; error: string } | { state: 'aborted' };

/**
 * Resolves when the download reaches a terminal state, or with 'aborted' when `signal` aborts.
 * There is deliberately no timeout: Chrome's "Save as" dialog may stay open for a long time, and
 * reporting success (or revoking the blob) while the file is still pending would be wrong. The
 * job keepalive keeps the service worker running meanwhile.
 */
function waitForDownload(downloadId: number, signal?: AbortSignal): Promise<FinalState> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s: FinalState) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      signal?.removeEventListener('abort', onAbort);
      resolve(s);
    };
    const onAbort = () => finish({ state: 'aborted' });
    const check = (item: { state?: string; error?: string } | undefined) => {
      if (!item) return;
      if (item.state === 'complete') finish({ state: 'complete' });
      else if (item.state === 'interrupted') finish({ state: 'interrupted', error: item.error ?? 'FAILED' });
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      check({ state: delta.state?.current, error: delta.error?.current });
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    chrome.downloads.onChanged.addListener(onChanged);
    // It may already be finished (small files complete almost instantly).
    chrome.downloads.search({ id: downloadId }).then(
      (items) => check(items[0] as { state?: string; error?: string } | undefined),
      () => undefined,
    );
  });
}

function interruptMessage(error: string): string {
  if (error === 'USER_CANCELED') return 'The download was cancelled.';
  if (/^FILE_NO_SPACE/.test(error)) return 'The download failed: not enough disk space.';
  if (/^FILE_ACCESS_DENIED/.test(error)) return 'The download failed: the destination folder is not writable.';
  if (/^FILE_NAME_TOO_LONG/.test(error)) return 'The download failed: the file name is too long.';
  return `The download failed (${error}).`;
}

async function startDownload(url: string, filename: string): Promise<number> {
  try {
    return await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch (e) {
    // Chrome rejects some names (reserved words, odd characters). Retry with a safe fallback.
    if (!/filename/i.test(e instanceof Error ? e.message : String(e))) throw e;
    const ext = /\.[a-z0-9]{1,5}$/i.exec(filename)?.[0] ?? '.pdf';
    return chrome.downloads.download({ url, filename: `confluence-export${ext}`, conflictAction: 'uniquify' });
  }
}

/** Cancels and forgets a download that is no longer wanted (best effort). */
async function cancelDownload(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.cancel(downloadId);
  } catch {
    /* already finished or gone */
  }
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch {
    /* not in the history */
  }
}

/**
 * Saves bytes as a download and resolves with the download id once Chrome finished writing the
 * file. Rejects with DownloadInterruptedError when the download is interrupted (including the
 * user cancelling the "Save as" dialog), and with an AbortError when `signal` aborts: the
 * download is then cancelled too, so a cancelled export never leaves a file behind. The blob URL
 * is revoked (and the offscreen document closed) only after the download reached a final state.
 */
export async function saveBytes(bytes: Uint8Array, filename: string, mime: string, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw abortError();
  activeSaves++;
  let url: string | undefined;
  try {
    await ensureOffscreen();
    url = await toBlobUrl(bytes, mime, signal);
    if (signal?.aborted) throw abortError();
    const downloadId = await startDownload(url, filename);
    const final = await waitForDownload(downloadId, signal);
    if (final.state === 'aborted') {
      await cancelDownload(downloadId);
      throw abortError();
    }
    if (final.state === 'interrupted') {
      throw new DownloadInterruptedError(interruptMessage(final.error), final.error, downloadId);
    }
    return downloadId;
  } finally {
    activeSaves--;
    if (url) await callOffscreen({ target: 'offscreen', type: 'blob/revoke', url }).catch(() => undefined);
    await closeOffscreenIfIdle();
  }
}

/**
 * Shows a finished download in the OS file manager. False when Chrome no longer has a usable
 * item (erased from the history, interrupted, file deleted) — `downloads.show` itself reports
 * such failures only through runtime.lastError and never throws.
 */
export async function showDownloadItem(downloadId: number | undefined): Promise<boolean> {
  if (downloadId === undefined) return false;
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item || item.state !== 'complete' || item.exists === false) return false;
    chrome.downloads.show(downloadId);
    return true;
  } catch {
    return false;
  }
}
