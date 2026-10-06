/**
 * Long worker-tab operations (`worker/collect`, `worker/fetch`) run in the background: the worker
 * answers `{ started: true }` at once and later sends a `worker/done` notification. Waiting on
 * one tabs.sendMessage for minutes would hit Chrome's 5-minute limit for a single service-worker
 * event or API call. This helper starts such an operation and waits for its outcome, while
 * checking that the worker tab is still alive (a closed tab never sends `worker/done`).
 * Chrome-API free (everything goes through the given functions) so the runner can use it in tests.
 */
import type { SwToWorker, SwToWorkerResponses, WorkerOp, WorkerOpResults, WorkerToSw } from '../messages';

export interface WorkerOpDeps {
  callWorker<M extends SwToWorker>(tabId: number, msg: M): Promise<SwToWorkerResponses[M['type']]>;
  subscribeWorker(jobId: string, listener: (msg: WorkerToSw) => void): () => void;
}

/** How often the worker tab is pinged while an operation runs. */
export const LIVENESS_PING_MS = 5000;

export class WorkerOpError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = code === 'ABORTED' ? 'AbortError' : 'WorkerOpError';
  }
}

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

/**
 * Sends `msg` (a background operation `op` for `id`) and resolves with its result. Rejects when
 * the worker reports a failure (code preserved), when the tab stops answering pings, or with an
 * AbortError when `signal` aborts (the caller then tells the worker to cancel).
 */
export function runWorkerOp<O extends WorkerOp>(
  deps: WorkerOpDeps,
  o: {
    tabId: number;
    id: string;
    op: O;
    msg: Extract<SwToWorker, { type: 'worker/collect' | 'worker/fetch' }>;
    signal?: AbortSignal;
    pingMs?: number;
  },
): Promise<WorkerOpResults[O]> {
  return new Promise<WorkerOpResults[O]>((resolve, reject) => {
    let settled = false;
    let pinging = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearInterval(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    // Subscribe before sending so a fast outcome is never missed.
    const unsubscribe = deps.subscribeWorker(o.id, (m) => {
      if (m.type !== 'worker/done' || m.op !== o.op) return;
      if (m.error !== undefined) finish(() => reject(new WorkerOpError(m.error!, m.code)));
      else finish(() => resolve(m.result as WorkerOpResults[O]));
    });
    const onAbort = () => finish(() => reject(abortError()));
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setInterval(() => {
      if (pinging || settled) return;
      pinging = true;
      deps.callWorker(o.tabId, { type: 'worker/ping' }).then(
        () => {
          pinging = false;
        },
        () => finish(() => reject(new Error('An export helper tab was closed or stopped responding, so the export stopped.'))),
      );
    }, o.pingMs ?? LIVENESS_PING_MS);
    deps.callWorker(o.tabId, o.msg).then(
      () => undefined,
      (e: unknown) => finish(() => reject(e)),
    );
  });
}
