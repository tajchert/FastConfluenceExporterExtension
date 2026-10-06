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
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

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

let creating: Promise<void> | null = null;
let activeSaves = 0;

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

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Create blob URLs for downloading generated PDF files',
      })
      .catch((e: unknown) => {
        // Another caller won the race — fine.
        if (!/single offscreen|already/i.test(e instanceof Error ? e.message : String(e))) throw e;
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

async function closeOffscreenIfIdle(): Promise<void> {
  if (activeSaves > 0) return;
  try {
    if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
  } catch {
    /* already closed */
  }
}

async function toBlobUrl(bytes: Uint8Array, mime: string): Promise<string> {
  const id = crypto.randomUUID();
  await callOffscreen({ target: 'offscreen', type: 'blob/begin', id, mime });
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
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

type FinalState = { state: 'complete' } | { state: 'interrupted'; error: string } | { state: 'timeout' };

/** Resolves when the download completes, is interrupted or the timeout expires. */
function waitForDownload(downloadId: number, timeoutMs: number): Promise<FinalState> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (s: FinalState) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(s);
    };
    const check = (item: { state?: string; error?: string } | undefined) => {
      if (!item) return;
      if (item.state === 'complete') finish({ state: 'complete' });
      else if (item.state === 'interrupted') finish({ state: 'interrupted', error: item.error ?? 'FAILED' });
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      check({ state: delta.state?.current, error: delta.error?.current });
    };
    const timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs);
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

/**
 * Saves bytes as a download and resolves with the download id once Chrome finished writing the
 * file. Rejects with DownloadInterruptedError when the download is interrupted (including the
 * user cancelling the "Save as" dialog). The blob URL is revoked afterwards in every case.
 */
export async function saveBytes(bytes: Uint8Array, filename: string, mime: string): Promise<number> {
  activeSaves++;
  let url: string | undefined;
  try {
    await ensureOffscreen();
    url = await toBlobUrl(bytes, mime);
    const downloadId = await startDownload(url, filename);
    const final = await waitForDownload(downloadId, DOWNLOAD_TIMEOUT_MS);
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
