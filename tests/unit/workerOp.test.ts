import { describe, expect, it } from 'vitest';
import type { SwToWorker, WorkerToSw } from '../../lib/messages';
import { runWorkerOp, type WorkerOpDeps } from '../../lib/job/workerOp';
import { isAbortError } from '../../lib/util/abort';

function deps(onCall: (msg: SwToWorker, emit: (m: WorkerToSw) => void) => unknown): WorkerOpDeps & { listeners: number } {
  const listeners = new Set<(m: WorkerToSw) => void>();
  const emit = (m: WorkerToSw) => [...listeners].forEach((l) => l(m));
  const d = {
    listeners: 0,
    callWorker: (async (_tab: number, msg: SwToWorker) => onCall(msg, emit)) as WorkerOpDeps['callWorker'],
    subscribeWorker: (_id: string, l: (m: WorkerToSw) => void) => {
      listeners.add(l);
      d.listeners = listeners.size;
      return () => {
        listeners.delete(l);
        d.listeners = listeners.size;
      };
    },
  };
  return d;
}

const collectMsg = { type: 'worker/collect', jobId: 'r1', request: {} } as Extract<SwToWorker, { type: 'worker/collect' }>;

describe('runWorkerOp', () => {
  it('resolves with the result of the worker/done notification', async () => {
    const d = deps((msg, emit) => {
      if (msg.type === 'worker/collect') {
        queueMicrotask(() => emit({ type: 'worker/done', jobId: 'r1', op: 'collect', result: { pages: [], warnings: ['w'] } }));
        return { started: true };
      }
      return { ready: true };
    });
    await expect(runWorkerOp(d, { tabId: 1, id: 'r1', op: 'collect', msg: collectMsg })).resolves.toEqual({ pages: [], warnings: ['w'] });
    expect(d.listeners).toBe(0);
  });

  it('rejects with the worker’s error and code', async () => {
    const d = deps((msg, emit) => {
      queueMicrotask(() => emit({ type: 'worker/done', jobId: 'r1', op: 'collect', error: 'Signed out', code: 'LOGIN_REQUIRED' }));
      return { started: true };
    });
    await expect(runWorkerOp(d, { tabId: 1, id: 'r1', op: 'collect', msg: collectMsg })).rejects.toMatchObject({
      message: 'Signed out',
      code: 'LOGIN_REQUIRED',
    });
  });

  it('rejects when the tab stops answering pings', async () => {
    const d = deps((msg) => {
      if (msg.type === 'worker/ping') throw new Error('No tab');
      return { started: true };
    });
    await expect(runWorkerOp(d, { tabId: 1, id: 'r1', op: 'collect', msg: collectMsg, pingMs: 5 })).rejects.toThrow(/closed or stopped/);
  });

  it('rejects with an AbortError when the signal aborts', async () => {
    const d = deps(() => ({ started: true }));
    const ac = new AbortController();
    const p = runWorkerOp(d, { tabId: 1, id: 'r1', op: 'collect', msg: collectMsg, signal: ac.signal, pingMs: 1000 });
    ac.abort();
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(d.listeners).toBe(0);
  });
});
