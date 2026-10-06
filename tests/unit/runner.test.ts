import { describe, expect, it, vi } from 'vitest';
import type { SwToWorker, WorkerToSw } from '../../lib/messages';
import type { FinalizeOptions } from '../../lib/pdf/merge';
import type { PrintParams } from '../../lib/render/cdp';
import { applyPolicyToPages, runJob, shiftStartPage, type RunnerDeps } from '../../lib/job/runner';
import {
  DEFAULT_OPTIONS,
  DEFAULT_SETTINGS,
  type ExportJobState,
  type ExportOptions,
  type FetchedPageInfo,
  type JobStatus,
  type ManagedPolicy,
  type PageRef,
  type SiteInfo,
} from '../../lib/types';

const SITE: SiteInfo = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
  siteTitle: 'Acme',
};
const WORKER_TAB = 42;
const NOW = new Date(2026, 9, 6, 10, 0, 0).getTime();

function ref(id: string, depth = 0, extra: Partial<PageRef> = {}): PageRef {
  return {
    id,
    type: 'page',
    title: `Page ${id}`,
    spaceKey: 'ENG',
    depth,
    url: `${SITE.baseUrl}/spaces/ENG/pages/${id}`,
    reason: depth === 0 ? 'root' : 'descendant',
    ...extra,
  };
}

function pdf(tag: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-${tag}`);
}

function makeJob(pages: PageRef[], options: Partial<ExportOptions> = {}, mode: ExportJobState['request']['mode'] = 'subtree'): ExportJobState {
  return {
    id: 'job-1',
    request: {
      site: SITE,
      mode,
      root: { id: '1', type: 'page', title: 'Root Title', spaceKey: 'ENG' },
      options: { ...DEFAULT_OPTIONS, ...options },
      userDisplayName: 'Jane Doe',
      sourceTabId: 7,
    },
    pages,
    status: 'collecting',
    progress: { done: 0, total: 0 },
    errors: [],
    createdAt: NOW,
  };
}

interface Harness {
  deps: RunnerDeps;
  calls: SwToWorker[];
  statuses: JobStatus[];
  prints: PrintParams[];
  saved: { bytes: Uint8Array; filename: string; mime: string }[];
  finalizeCalls: { base: Uint8Array; o: FinalizeOptions }[];
  closed: (number | undefined)[];
  controller: AbortController;
  emit: (msg: WorkerToSw) => void;
}

function harness(opts: {
  infos?: Record<string, Partial<FetchedPageInfo>>;
  collected?: PageRef[];
  policy?: ManagedPolicy;
  batchSize?: number;
  print?: (tabId: number, params: PrintParams) => Promise<Uint8Array>;
  live?: Map<string, Uint8Array | Error>;
  starts?: Map<string, number>;
  chromeOutline?: { title: string; pageIndex: number; children: never[] }[];
  onAssemble?: (msg: Extract<SwToWorker, { type: 'worker/assemble' }>) => void;
} = {}): Harness {
  const calls: SwToWorker[] = [];
  const statuses: JobStatus[] = [];
  const prints: PrintParams[] = [];
  const saved: Harness['saved'] = [];
  const finalizeCalls: Harness['finalizeCalls'] = [];
  const closed: (number | undefined)[] = [];
  const listeners = new Set<(m: WorkerToSw) => void>();
  const controller = new AbortController();
  let printCount = 0;

  const deps: RunnerDeps = {
    callWorker: (async (_tabId: number, msg: SwToWorker) => {
      calls.push(msg);
      switch (msg.type) {
        case 'worker/collect':
          return { pages: opts.collected ?? [], warnings: ['Depth limited'] };
        case 'worker/fetch': {
          const results = msg.pages.map((p) => ({
            id: p.id,
            ok: true,
            needsLiveRender: false,
            spaceKey: p.spaceKey,
            ...(opts.infos?.[p.id] ?? {}),
          }));
          msg.pages.forEach((p, i) => listeners.forEach((l) => l({ type: 'worker/progress', jobId: msg.jobId, done: i + 1, total: msg.pages.length, current: p.title })));
          return { results };
        }
        case 'worker/assemble':
          opts.onAssemble?.(msg);
          return { imageFailures: 1, pageIds: msg.pageIds };
        case 'worker/space':
          return { key: msg.spaceKey, name: 'Engineering' };
        default:
          return undefined;
      }
    }) as RunnerDeps['callWorker'],
    subscribeWorker: (_jobId, l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    openWorkerTab: vi.fn(async () => WORKER_TAB),
    closeTabQuietly: async (id) => {
      closed.push(id);
    },
    toPrintParams: (o) => ({
      paperWidthIn: 8.27,
      paperHeightIn: 11.69,
      marginTopIn: 0.7,
      marginBottomIn: 0.7,
      marginLeftIn: 0.6,
      marginRightIn: 0.6,
      landscape: o.orientation === 'landscape',
      displayHeaderFooter: o.pageNumbers,
      headerTemplate: '<div></div>',
      footerTemplate: 'n/t',
      outline: true,
      tagged: true,
    }),
    printTabToPdf: async (tabId, params) => {
      prints.push(params);
      if (opts.print) return opts.print(tabId, params);
      return pdf(`print${++printCount}`);
    },
    isDebuggerUnavailable: (e) => (e as Error)?.name === 'DebuggerUnavailableError',
    detachAll: vi.fn(async () => undefined),
    fallbackPrint: vi.fn(async () => undefined),
    liveRenderPages: vi.fn(async () => opts.live ?? new Map()),
    concatPdfs: vi.fn(async (parts: Uint8Array[]) => ({ bytes: pdf('concat'), offsets: parts.map((_, i) => i * 10) })),
    findSectionStartPages: vi.fn(async (_pdf: Uint8Array, pages: { id: string }[]) => {
      if (opts.starts) return opts.starts;
      return new Map(pages.map((p, i) => [p.id, 2 + i * 2]));
    }),
    finalizePdf: vi.fn(async (base: Uint8Array, o: FinalizeOptions) => {
      finalizeCalls.push({ base, o });
      return { bytes: pdf('final'), pageCount: 9 };
    }),
    buildOutline: vi.fn((pages: PageRef[], start: Map<string, number>) =>
      pages.map((p) => ({ title: p.title, pageIndex: start.get(p.id)!, children: [] })),
    ),
    readOutline: vi.fn(async () => opts.chromeOutline ?? []),
    countPdfPages: vi.fn(async () => 3),
    zipFiles: vi.fn((files: { name: string; data: Uint8Array }[]) => new Uint8Array(files.length * 100)),
    saveBytes: async (bytes, filename, mime) => {
      saved.push({ bytes, filename, mime });
      return 77;
    },
    settings: { ...DEFAULT_SETTINGS, printBatchSize: opts.batchSize ?? 150 },
    policy: opts.policy ?? {},
    version: '1.2.3',
    now: () => NOW,
    signal: controller.signal,
    onUpdate: (job) => {
      if (statuses[statuses.length - 1] !== job.status) statuses.push(job.status);
    },
  };
  return {
    deps,
    calls,
    statuses,
    prints,
    saved,
    finalizeCalls,
    closed,
    controller,
    emit: (m) => listeners.forEach((l) => l(m)),
  };
}

const assembles = (h: Harness) => h.calls.filter((c): c is Extract<SwToWorker, { type: 'worker/assemble' }> => c.type === 'worker/assemble');

describe('runJob: combined PDF', () => {
  it('runs the happy path and keeps Chrome’s outline for a single batch', async () => {
    const h = harness();
    const job = makeJob([ref('1'), ref('2', 1), ref('3', 1)]);
    await runJob(job, h.deps);

    expect(job.status).toBe('done');
    expect(h.statuses).toEqual(['collecting', 'fetching', 'rendering', 'merging', 'done']);
    expect(h.calls.some((c) => c.type === 'worker/collect')).toBe(false);
    const asm = assembles(h);
    expect(asm).toHaveLength(1);
    expect(asm[0].pageIds).toEqual(['1', '2', '3']);
    expect(asm[0].cover?.title).toBe('Root Title');
    expect(asm[0].cover?.pageCount).toBe(3);
    expect(asm[0].toc).toBe(true);
    expect(h.prints[0].displayHeaderFooter).toBe(true);

    const fin = h.finalizeCalls[0].o;
    expect(fin.outline).toBeUndefined();
    expect(fin.inserts).toBeUndefined();
    expect(fin.stampPageNumbers).toBeUndefined();
    expect(fin.metadata).toMatchObject({
      title: 'Root Title',
      author: 'Jane Doe',
      subject: 'Confluence export: ENG – 3 pages',
      creator: 'Fast PDF Export for Confluence v1.2.3',
    });

    expect(h.saved[0].filename).toBe('ENG_Root Title_2026-10-06.pdf');
    expect(h.saved[0].mime).toBe('application/pdf');
    expect(job.result).toMatchObject({ filename: 'ENG_Root Title_2026-10-06.pdf', downloadId: 77, pageCount: 3, sheetCount: 9 });
    expect(job.errors.map((e) => e.severity)).toEqual(['degraded']); // 1 image placeholder
    expect(h.closed).toEqual([WORKER_TAB]);
    expect(h.calls.some((c) => c.type === 'worker/dispose')).toBe(true);
  });

  it('collects when no pages are given and records warnings', async () => {
    const h = harness({ collected: [ref('1'), ref('2', 1)] });
    const job = makeJob([], {}, 'subtree');
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(h.calls[0].type).toBe('worker/collect');
    expect(job.pages.map((p) => p.id)).toEqual(['1', '2']);
    expect(job.warnings).toEqual(['Depth limited']);
  });

  it('skips pages that fail to load and finishes', async () => {
    const h = harness({ infos: { '2': { ok: false, httpStatus: 403 } } });
    const job = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(assembles(h)[0].pageIds).toEqual(['1']);
    expect(assembles(h)[0].allPages.map((p) => p.id)).toEqual(['1']);
    const skipped = job.errors.filter((e) => e.severity === 'skipped');
    expect(skipped).toEqual([
      { pageId: '2', title: 'Page 2', message: 'You do not have permission to view this page.', severity: 'skipped' },
    ]);
    expect(job.message).toContain('1 page skipped');
  });

  it('fails when every page fails', async () => {
    const h = harness({ infos: { '1': { ok: false, httpStatus: 404 }, '2': { ok: false, error: 'boom' } } });
    const job = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job, h.deps);
    expect(job.status).toBe('error');
    expect(job.message).toMatch(/None of the 2 pages/);
    expect(h.saved).toHaveLength(0);
    expect(h.closed).toEqual([WORKER_TAB]);
  });

  it('enforces blocked spaces and maxPages', async () => {
    const policy: ManagedPolicy = { blockedSpaceKeys: ['hr'] };
    const h = harness({ policy });
    const job = makeJob([ref('1'), ref('2', 1, { spaceKey: 'HR', reason: 'linked' })]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(job.errors.find((e) => e.pageId === '2')?.message).toBe('Blocked by your administrator');
    const fetch = h.calls.find((c) => c.type === 'worker/fetch') as Extract<SwToWorker, { type: 'worker/fetch' }>;
    expect(fetch.pages.map((p) => p.id)).toEqual(['1']);

    const h2 = harness({ policy: { maxPages: 1 } });
    const job2 = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job2, h2.deps);
    expect(job2.status).toBe('error');
    expect(job2.message).toMatch(/at most 1 pages/);
  });

  it('drops pages whose fetched space key is blocked', async () => {
    const h = harness({ policy: { blockedSpaceKeys: ['SECRET'] }, infos: { '2': { spaceKey: 'SECRET' } } });
    const job = makeJob([ref('1'), ref('2', 1, { spaceKey: undefined, reason: 'linked' })]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(assembles(h)[0].pageIds).toEqual(['1']);
  });

  it('prints in batches: cover and TOC in the first batch only, outline rebuilt, numbers stamped', async () => {
    const h = harness({ batchSize: 2 });
    const pages = [ref('1'), ref('2', 1), ref('3', 1), ref('4', 2), ref('5', 1)];
    const job = makeJob(pages);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const asm = assembles(h);
    expect(asm.map((a) => a.pageIds)).toEqual([['1', '2'], ['3', '4'], ['5']]);
    expect(asm.map((a) => a.cover !== null)).toEqual([true, false, false]);
    expect(asm.map((a) => a.toc)).toEqual([true, false, false]);
    expect(asm.every((a) => a.allPages.length === 5)).toBe(true);
    expect(h.deps.concatPdfs).toHaveBeenCalledTimes(1);
    expect(h.prints.every((p) => p.displayHeaderFooter === false)).toBe(true);
    const fin = h.finalizeCalls[0].o;
    expect(h.finalizeCalls[0].base).toEqual(pdf('concat'));
    expect(fin.outline?.map((o) => o.pageIndex)).toEqual([2, 4, 6, 8, 10]);
    expect(fin.stampPageNumbers).toEqual({});
  });

  it('keeps Chrome’s (merged) outline after batches and inserts instead of rebuilding it', async () => {
    const h = harness({
      batchSize: 2,
      chromeOutline: [{ title: 'Page 1', pageIndex: 2, children: [] }],
      infos: { '2': { needsLiveRender: true } },
      live: new Map([['2', pdf('live2')]]),
    });
    const job = makeJob([ref('1'), ref('2', 1), ref('3', 1)], { liveRender: true, marginsMm: { top: 10, right: 10, bottom: 5, left: 10 } });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const fin = h.finalizeCalls[0].o;
    expect(fin.outline).toBeUndefined();
    expect(fin.inserts?.length).toBe(1);
    expect(h.deps.buildOutline).not.toHaveBeenCalled();
    // Live pages print without Chrome's footer but keep room for the stamped numbers.
    const liveOpts = (h.deps.liveRenderPages as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(liveOpts.options.pageNumbers).toBe(false);
    expect(liveOpts.options.marginsMm.bottom).toBe(12);
  });

  it('inserts live-rendered pages after their header sheet and shifts the outline', async () => {
    const live = new Map<string, Uint8Array | Error>([
      ['2', pdf('live2')],
      ['3', new Error('timeout')],
    ]);
    const h = harness({
      infos: { '2': { needsLiveRender: true }, '3': { needsLiveRender: true } },
      live,
      starts: new Map([
        ['1', 2],
        ['2', 4],
        ['3', 5],
      ]),
    });
    const job = makeJob([ref('1'), ref('2', 1), ref('3', 1)], { liveRender: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');

    const fetch = h.calls.find((c) => c.type === 'worker/fetch') as Extract<SwToWorker, { type: 'worker/fetch' }>;
    expect(fetch.needStorage).toBe(true);
    expect(fetch.liveRenderMacros.length).toBeGreaterThan(0);
    const liveOpts = (h.deps.liveRenderPages as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(liveOpts.options.pageNumbers).toBe(false);

    // Page 3's live render failed → assembled statically.
    expect(assembles(h)[0].liveRenderIds).toEqual(['2']);
    const fin = h.finalizeCalls[0].o;
    expect(fin.inserts).toEqual([{ afterPageIndex: 4, pdf: pdf('live2') }]);
    // countPdfPages → 3 inserted sheets after index 4: page 3 moves from 5 to 8.
    expect(fin.outline?.map((o) => o.pageIndex)).toEqual([2, 4, 8]);
    expect(fin.stampPageNumbers).toEqual({});
    expect(job.errors.find((e) => e.pageId === '3')?.severity).toBe('degraded');
  });

  it('ignores live render when the policy disables it', async () => {
    const h = harness({ policy: { disableLiveRender: true }, infos: { '1': { needsLiveRender: true } } });
    const job = makeJob([ref('1')], { liveRender: true }, 'current');
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(h.deps.liveRenderPages).not.toHaveBeenCalled();
    const fetch = h.calls.find((c) => c.type === 'worker/fetch') as Extract<SwToWorker, { type: 'worker/fetch' }>;
    expect(fetch.liveRenderMacros).toEqual([]);
    expect(fetch.needStorage).toBe(false);
  });

  it('uses the space name for space exports', async () => {
    const h = harness();
    const job = makeJob([ref('1'), ref('2', 1)], {}, 'space');
    await runJob(job, h.deps);
    expect(h.saved[0].filename).toBe('ENG_Engineering_2026-10-06.pdf');
    expect(h.finalizeCalls[0].o.metadata.title).toBe('Engineering');
    expect(h.finalizeCalls[0].o.metadata.subject).toBe('Confluence export: Engineering – 2 pages');
  });

  it('reports fetch progress and throttling from the worker', async () => {
    const h = harness();
    const seen: string[] = [];
    const onUpdate = h.deps.onUpdate;
    h.deps.onUpdate = (job) => {
      onUpdate(job);
      if (job.status === 'fetching') seen.push(`${job.progress.done}/${job.progress.total}${job.throttled ? ' T' : ''}`);
    };
    const job = makeJob([ref('1'), ref('2', 1)]);
    const p = runJob(job, h.deps);
    await p;
    expect(seen).toContain('1/2');
    expect(seen).toContain('2/2');
  });
});

describe('runJob: separate files', () => {
  it('prints each page on its own and zips them', async () => {
    const h = harness();
    const job = makeJob([ref('1'), ref('2', 1), ref('f', 1, { type: 'folder', title: 'Folder' })], { separateFiles: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const asm = assembles(h);
    expect(asm.map((a) => a.pageIds)).toEqual([['1'], ['2']]);
    expect(asm.every((a) => a.cover === null && a.toc === false && a.allPages.length === 1)).toBe(true);
    const files = (h.deps.zipFiles as ReturnType<typeof vi.fn>).mock.calls[0][0] as { name: string }[];
    expect(files.map((f) => f.name)).toEqual(['1_Page 1.pdf', '2_Page 2.pdf']);
    expect(h.saved[0]).toMatchObject({ filename: 'ENG_Root Title_2026-10-06.zip', mime: 'application/zip' });
  });

  it('saves a single page as a plain PDF', async () => {
    const h = harness();
    const job = makeJob([ref('1')], { separateFiles: true }, 'current');
    await runJob(job, h.deps);
    expect(h.deps.zipFiles).not.toHaveBeenCalled();
    expect(h.saved[0]).toMatchObject({ filename: 'ENG_Page 1_2026-10-06.pdf', mime: 'application/pdf' });
  });
});

describe('runJob: debugger fallback and cancel', () => {
  it('opens the print dialog when the debugger is unavailable', async () => {
    const err = new Error('Another debugger is attached');
    err.name = 'DebuggerUnavailableError';
    const h = harness({ batchSize: 1, print: async () => Promise.reject(err) });
    const job = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(job.printDialog).toBe(true);
    expect(job.message).toMatch(/print dialog/);
    expect(h.deps.fallbackPrint).toHaveBeenCalledWith(WORKER_TAB);
    const last = assembles(h).at(-1)!;
    expect(last.pageIds).toEqual(['1', '2']);
    expect(last.liveRenderIds).toEqual([]);
    expect(h.closed).toEqual([]); // the tab stays open for the dialog
    expect(h.saved).toHaveLength(0);
  });

  it('cancels while printing', async () => {
    let h!: Harness;
    h = harness({
      print: () =>
        new Promise<Uint8Array>((_resolve, reject) => {
          queueMicrotask(() => h.controller.abort());
          h.controller.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    const job = makeJob([ref('1')]);
    await runJob(job, h.deps);
    expect(job.status).toBe('cancelled');
    expect(h.calls.some((c) => c.type === 'worker/cancel')).toBe(true);
    expect(h.calls.some((c) => c.type === 'worker/dispose')).toBe(false);
    expect(h.deps.detachAll).toHaveBeenCalled();
    expect(h.closed).toEqual([WORKER_TAB]);
    expect(h.saved).toHaveLength(0);
  });

  it('cancels before the worker tab opens', async () => {
    const h = harness();
    h.controller.abort();
    const job = makeJob([ref('1')]);
    await runJob(job, h.deps);
    expect(job.status).toBe('cancelled');
    expect(h.deps.openWorkerTab).not.toHaveBeenCalled();
  });

  it('treats a dismissed "Save as" dialog as a cancel, not a failure', async () => {
    const h = harness();
    h.deps.saveBytes = async () => {
      throw Object.assign(new Error('The download was cancelled.'), { code: 'DOWNLOAD_INTERRUPTED', reason: 'USER_CANCELED' });
    };
    const job = makeJob([ref('1')]);
    await runJob(job, h.deps);
    expect(job.status).toBe('cancelled');
    expect(job.errors.some((e) => e.severity === 'fatal')).toBe(false);
    expect(h.closed).toEqual([WORKER_TAB]);
  });

  it('reports worker errors as a fatal job error and still closes the tab', async () => {
    const h = harness();
    const original = h.deps.callWorker;
    h.deps.callWorker = (async (tabId: number, msg: SwToWorker) => {
      if (msg.type === 'worker/assemble') throw new Error('assemble exploded');
      return original(tabId, msg);
    }) as RunnerDeps['callWorker'];
    const job = makeJob([ref('1')]);
    await runJob(job, h.deps);
    expect(job.status).toBe('error');
    expect(job.message).toBe('assemble exploded');
    expect(job.errors.at(-1)?.severity).toBe('fatal');
    expect(h.closed).toEqual([WORKER_TAB]);
  });
});

describe('runner helpers', () => {
  it('applyPolicyToPages uses the root space for same-tree pages without a key', () => {
    const pages = [ref('1', 0, { spaceKey: undefined }), ref('2', 1, { spaceKey: undefined, reason: 'linked' })];
    const res = applyPolicyToPages(pages, { blockedSpaceKeys: ['ENG'] }, 'eng');
    expect(res.pages.map((p) => p.id)).toEqual(['2']);
    expect(res.errors.map((e) => e.pageId)).toEqual(['1']);
  });

  it('shiftStartPage accounts for inserts before the start', () => {
    const inserts = [
      { afterPageIndex: 1, count: 2 },
      { afterPageIndex: 5, count: 3 },
    ];
    expect(shiftStartPage(0, inserts)).toBe(0);
    expect(shiftStartPage(1, inserts)).toBe(1);
    expect(shiftStartPage(2, inserts)).toBe(4);
    expect(shiftStartPage(6, inserts)).toBe(11);
  });
});
