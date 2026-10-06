/**
 * Offscreen document: assembles bytes streamed from the service worker into a Blob and hands
 * back a blob: URL for chrome.downloads. Only answers messages addressed to it
 * (`target: 'offscreen'`) so it never swallows UI → service worker requests.
 */
import type { SwToOffscreen, SwToOffscreenResponses } from '../../lib/messages';
import { respond } from '../../lib/rpc';
import { base64ToBytes } from '../../lib/util/base64';

/** Safety net: revoke URLs the service worker never revoked (e.g. it was restarted). */
const URL_TTL_MS = 15 * 60 * 1000;
/** Drop half-received blobs that never got their `blob/end`. */
const PENDING_TTL_MS = 5 * 60 * 1000;

interface Pending {
  mime: string;
  parts: Uint8Array[];
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const urls = new Map<string, ReturnType<typeof setTimeout>>();

function revoke(url: string): void {
  const t = urls.get(url);
  if (t !== undefined) clearTimeout(t);
  urls.delete(url);
  URL.revokeObjectURL(url);
}

function handle(msg: SwToOffscreen): SwToOffscreenResponses[SwToOffscreen['type']] {
  switch (msg.type) {
    case 'blob/begin': {
      const old = pending.get(msg.id);
      if (old) clearTimeout(old.timer);
      pending.set(msg.id, {
        mime: msg.mime || 'application/octet-stream',
        parts: [],
        timer: setTimeout(() => pending.delete(msg.id), PENDING_TTL_MS),
      });
      return undefined;
    }
    case 'blob/chunk': {
      const p = pending.get(msg.id);
      if (!p) throw new Error('Unknown blob transfer');
      p.parts.push(base64ToBytes(msg.base64));
      return undefined;
    }
    case 'blob/end': {
      const p = pending.get(msg.id);
      if (!p) throw new Error('Unknown blob transfer');
      clearTimeout(p.timer);
      pending.delete(msg.id);
      const url = URL.createObjectURL(new Blob(p.parts as BlobPart[], { type: p.mime }));
      urls.set(url, setTimeout(() => revoke(url), URL_TTL_MS));
      return { url };
    }
    case 'blob/revoke':
      revoke(msg.url);
      return undefined;
    default:
      throw new Error('Unsupported offscreen request');
  }
}

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  const m = msg as Partial<SwToOffscreen> | undefined;
  if (!m || m.target !== 'offscreen' || sender.id !== chrome.runtime.id) return false;
  return respond(sendResponse, () => handle(m as SwToOffscreen));
});
