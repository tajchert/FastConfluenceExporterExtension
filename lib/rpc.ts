/**
 * Thin typed wrappers around chrome.runtime / chrome.tabs messaging using the protocol in
 * ./messages.ts. Every request is answered with an RpcResult so errors cross context boundaries
 * as data instead of being lost ("The message port closed before a response was received").
 */
import type {
  RpcResult,
  SwToOffscreen,
  SwToOffscreenResponses,
  SwToWorker,
  SwToWorkerResponses,
  UiToSw,
  UiToSwResponses,
} from './messages';

export class RpcError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function unwrap<T>(res: RpcResult<T> | undefined, what: string): T {
  if (!res) throw new RpcError(`No response to ${what}`, 'NO_RESPONSE');
  if (!res.ok) throw new RpcError(res.error, res.code);
  return res.value;
}

/** UI page → service worker. */
export async function callSw<M extends UiToSw>(
  msg: M,
): Promise<UiToSwResponses[M['type']]> {
  const res = (await chrome.runtime.sendMessage(msg)) as RpcResult<UiToSwResponses[M['type']]>;
  return unwrap(res, msg.type);
}

/** Service worker → worker tab content script. */
export async function callWorker<M extends SwToWorker>(
  tabId: number,
  msg: M,
): Promise<SwToWorkerResponses[M['type']]> {
  const res = (await chrome.tabs.sendMessage(tabId, msg)) as RpcResult<SwToWorkerResponses[M['type']]>;
  return unwrap(res, msg.type);
}

/** Service worker → offscreen document. */
export async function callOffscreen<M extends SwToOffscreen>(
  msg: M,
): Promise<SwToOffscreenResponses[M['type']]> {
  const res = (await chrome.runtime.sendMessage(msg)) as RpcResult<SwToOffscreenResponses[M['type']]>;
  return unwrap(res, msg.type);
}

/**
 * Helper for listeners: run an async handler and deliver its result (or error) via sendResponse.
 * Usage inside onMessage: `return respond(sendResponse, () => handle(msg));` (returns true).
 */
export function respond<T>(sendResponse: (r: RpcResult<T>) => void, fn: () => Promise<T> | T): true {
  Promise.resolve()
    .then(fn)
    .then(
      (value) => sendResponse({ ok: true, value }),
      (err: unknown) => {
        const e = err as { message?: string; code?: string };
        sendResponse({ ok: false, error: e?.message ?? String(err), code: e?.code });
      },
    );
  return true;
}
