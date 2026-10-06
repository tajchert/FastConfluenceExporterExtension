/**
 * Page collection from an extension page (preview, popup) over the UI port: the service worker
 * runs it in the background, reports progress / throttling, cancels it when asked or when this
 * page goes away (the port disconnects), and closes its idle helper tab once no page is left.
 */
import { UI_PORT_NAME, type UiPortEvent, type UiPortRequest } from '../lib/messages';
import type { ExportRequest, PageRef } from '../lib/types';

type Handler = (event: UiPortEvent) => void;

let port: chrome.runtime.Port | null = null;
const handlers = new Map<string, Handler>();

/** Connects (once) and returns the port; also tells the SW this page is open. */
export function connectUiPort(): chrome.runtime.Port {
  if (port) return port;
  const p = chrome.runtime.connect({ name: UI_PORT_NAME });
  p.onMessage.addListener((raw: unknown) => {
    const event = raw as UiPortEvent | null;
    if (event && typeof event.requestId === 'string') handlers.get(event.requestId)?.(event);
  });
  p.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === p) port = null;
    // The service worker restarted: pending collections are gone.
    for (const [requestId, h] of [...handlers]) {
      h({ type: 'collect/failed', requestId, error: 'The extension restarted while collecting pages. Please try again.' });
    }
  });
  port = p;
  return p;
}

export interface CollectProgress {
  message?: string;
  /** Set while Confluence throttles us (ms until the next retry). */
  throttledForMs?: number;
}

export class CollectAbortedError extends Error {
  constructor() {
    super('Collecting pages was cancelled.');
    this.name = 'AbortError';
  }
}

/** Collects the page list for `request`. Rejects with an AbortError when `signal` aborts. */
export function collectPages(
  request: ExportRequest,
  o: { signal?: AbortSignal; onProgress?: (p: CollectProgress) => void } = {},
): Promise<{ pages: PageRef[]; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new CollectAbortedError());
      return;
    }
    const requestId = crypto.randomUUID();
    let p: chrome.runtime.Port;
    try {
      p = connectUiPort();
    } catch (e) {
      reject(e);
      return;
    }
    const send = (msg: UiPortRequest) => {
      try {
        p.postMessage(msg);
      } catch {
        /* disconnected: the handler reports it */
      }
    };
    const done = () => {
      handlers.delete(requestId);
      o.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      send({ type: 'collect/cancel', requestId });
      done();
      reject(new CollectAbortedError());
    };
    handlers.set(requestId, (event) => {
      if (event.type === 'collect/progress') {
        o.onProgress?.({ message: event.message, throttledForMs: event.throttledForMs });
      } else if (event.type === 'collect/done') {
        done();
        resolve(event.result);
      } else {
        done();
        reject(Object.assign(new Error(event.error), { code: event.code }));
      }
    });
    o.signal?.addEventListener('abort', onAbort, { once: true });
    send({ type: 'collect/start', requestId, request });
  });
}
