import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DEFAULT_OPTIONS, type ExportJobState, type ExportRequest } from '../../lib/types';

vi.mock('../../lib/render/cdp', () => ({
  DebuggerUnavailableError: class extends Error {},
  createPrintSession: vi.fn(),
  detachAll: vi.fn(async () => undefined),
  printTabToPdf: vi.fn(),
  toPrintParams: vi.fn(),
}));
vi.mock('../../lib/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/permissions')>()),
  hasSiteAccess: vi.fn(async () => true),
}));
const runJob = vi.fn(async () => undefined);
vi.mock('../../lib/job/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/job/runner')>()),
  runJob: (...args: unknown[]) => runJob(...(args as [])),
}));

const request: ExportRequest = {
  site: { origin: 'https://acme.atlassian.net', baseUrl: 'https://acme.atlassian.net/wiki', contextPath: '/wiki', flavour: 'cloud' },
  mode: 'current',
  root: { id: '1', type: 'page', title: 'One', spaceKey: 'ENG' },
  options: { ...DEFAULT_OPTIONS, customCss: 'body { color: red }' },
};

beforeEach(() => {
  fakeBrowser.reset();
  runJob.mockClear();
  vi.spyOn(chrome.runtime, 'getManifest').mockReturnValue({ version: '1.0.0' } as chrome.runtime.Manifest);
  vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue(undefined as never);
});

describe('job manager', () => {
  it('starts a pending export once, however often it is claimed', async () => {
    const manager = await import('../../lib/job/manager');
    const pending = { request, createdAt: 12345 };
    const [a, b] = await Promise.all([manager.claimPendingStart(pending), manager.claimPendingStart(pending)]);
    expect(a).toBe(b);
    expect(await manager.claimPendingStart(pending)).toBe(a);
    expect(runJob).toHaveBeenCalledTimes(1);
    const job = await manager.getJob(a);
    expect(job?.startKey).toBe(12345);
  });

  it('persists and broadcasts slim snapshots without the page list or custom CSS', async () => {
    const manager = await import('../../lib/job/manager');
    const job: ExportJobState = {
      id: 'j',
      request,
      pages: [{ id: '1', type: 'page', title: 'One', depth: 0, url: 'u', reason: 'root' }],
      status: 'fetching',
      progress: { done: 0, total: 1 },
      errors: [],
      createdAt: 1,
    };
    const slim = manager.slimJob(job);
    expect(slim.pages).toEqual([]);
    expect(slim.pageCount).toBe(1);
    expect(slim.request.options.customCss).toBe('');
    // The live job is untouched.
    expect(job.pages).toHaveLength(1);
    expect(job.request.options.customCss).toBe('body { color: red }');
  });

  it('collectKey ignores options that do not change the page list', async () => {
    const manager = await import('../../lib/job/manager');
    const base = { ...request, mode: 'subtree' as const, depth: 'all' as const };
    expect(manager.collectKey(base)).toBe(manager.collectKey({ ...base, options: { ...base.options, includeCover: false } }));
    expect(manager.collectKey(base)).not.toBe(manager.collectKey({ ...base, options: { ...base.options, includeArchived: true } }));
    expect(manager.collectKey(base)).not.toBe(manager.collectKey({ ...base, depth: 1 }));
  });
});
