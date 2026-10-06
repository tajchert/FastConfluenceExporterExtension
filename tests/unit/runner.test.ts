import { describe, expect, it, vi } from 'vitest';
import type { ConvertOpResult, OutputEntry, SwToWorker, WorkerToSw } from '../../lib/messages';
import { readOutputChunks } from '../../lib/output/chunks';
import type { ZipEntry } from '../../lib/pdf/zip';
import type { ExportFinalizeOptions, FinalizeOptions } from '../../lib/pdf/merge';
import type { PrintParams } from '../../lib/render/cdp';
import {
  UNVERIFIED_SPACE_MESSAGE,
  applyPolicyToPages,
  currentPageRef,
  destinationPageId,
  runJob,
  type RunnerDeps,
} from '../../lib/job/runner';
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
  sessions: number;
  zipped: string[][];
  zipEntries: ZipEntry[][];
  saved: { bytes: Uint8Array; filename: string; mime: string; signal?: AbortSignal }[];
  finalizeCalls: { base: Uint8Array; o: ExportFinalizeOptions }[];
  pageFinalizeCalls: { base: Uint8Array; o: FinalizeOptions }[];
  closed: (number | undefined)[];
  controller: AbortController;
  emit: (msg: WorkerToSw) => void;
}

function harness(opts: {
  infos?: Record<string, Partial<FetchedPageInfo>>;
  collected?: PageRef[];
  policy?: ManagedPolicy;
  batchSize?: number;
  print?: (params: PrintParams) => Promise<Uint8Array>;
  live?: Map<string, Uint8Array | Error>;
  unplacedLive?: string[];
  onAssemble?: (msg: Extract<SwToWorker, { type: 'worker/assemble' }>) => void;
  /** Answer for a background worker operation: default = success. */
  workerOp?: (msg: Extract<SwToWorker, { type: 'worker/collect' | 'worker/fetch' | 'worker/convert' }>) => Partial<Extract<WorkerToSw, { type: 'worker/done' }>> | null;
  /** Output of `worker/convert` (Markdown / text). Default: one document named after baseName. */
  convert?: (msg: Extract<SwToWorker, { type: 'worker/convert' }>) => {
    files: { path: string; text: string }[];
    assets?: { path: string; bytes: Uint8Array }[];
    failedAssets?: ConvertOpResult['failedAssets'];
    placeholders?: number;
  };
  /** Max bytes per `worker/readOutput` answer (tests the chunking). */
  readMaxBytes?: number;
} = {}): Harness {
  const calls: SwToWorker[] = [];
  const statuses: JobStatus[] = [];
  const prints: PrintParams[] = [];
  const saved: Harness['saved'] = [];
  const finalizeCalls: Harness['finalizeCalls'] = [];
  const pageFinalizeCalls: Harness['pageFinalizeCalls'] = [];
  const closed: (number | undefined)[] = [];
  const listeners = new Map<string, Set<(m: WorkerToSw) => void>>();
  const controller = new AbortController();
  let printCount = 0;
  const zipped: string[][] = [];
  const zipEntries: ZipEntry[][] = [];
  const h = { sessions: 0, zipped, zipEntries } as Harness;
  let output: Uint8Array[] = [];
  const emit = (m: WorkerToSw) => {
    if (m.type === 'worker/ready') return;
    for (const l of [...(listeners.get(m.jobId) ?? [])]) l(m);
  };

  const deps: RunnerDeps = {
    callWorker: (async (_tabId: number, msg: SwToWorker) => {
      calls.push(msg);
      switch (msg.type) {
        case 'worker/collect':
        case 'worker/fetch': {
          const op = msg.type === 'worker/collect' ? 'collect' : 'fetch';
          let result: unknown;
          if (msg.type === 'worker/collect') {
            result = { pages: opts.collected ?? [], warnings: ['Depth limited'] };
          } else {
            const results = msg.pages.map((p) => ({
              id: p.id,
              ok: true,
              needsLiveRender: false,
              spaceKey: p.spaceKey,
              title: p.title || `Fetched ${p.id}`,
              ...(opts.infos?.[p.id] ?? {}),
            }));
            msg.pages.forEach((p, i) => emit({ type: 'worker/progress', jobId: msg.jobId, done: i + 1, total: msg.pages.length, current: p.title }));
            result = { results };
          }
          const custom = opts.workerOp?.(msg);
          if (custom !== null) {
            queueMicrotask(() => emit({ type: 'worker/done', jobId: msg.jobId, op, result, ...(custom ?? {}) }));
          }
          return { started: true };
        }
        case 'worker/convert': {
          const ext = msg.options.format === 'markdown' ? 'md' : 'txt';
          const out = opts.convert?.(msg) ?? { files: [{ path: `${msg.baseName}.${ext}`, text: `# Ünïcode ✓ ${msg.pageIds.join(',')}\n` }] };
          const enc = new TextEncoder();
          const entries: OutputEntry[] = [];
          output = [];
          for (const f of out.files) {
            const b = enc.encode(f.text);
            entries.push({ path: f.path, size: b.length, kind: 'document' });
            output.push(b);
          }
          for (const a of out.assets ?? []) {
            entries.push({ path: a.path, size: a.bytes.length, kind: 'asset' });
            output.push(a.bytes);
          }
          emit({ type: 'worker/progress', jobId: msg.jobId, done: 1, total: 2, current: 'a.png' });
          const result: ConvertOpResult = { entries, placeholders: out.placeholders ?? 0, failedAssets: out.failedAssets ?? [] };
          const custom = opts.workerOp?.(msg);
          if (custom !== null) {
            queueMicrotask(() => emit({ type: 'worker/done', jobId: msg.jobId, op: 'convert', result, ...(custom ?? {}) }));
          }
          return { started: true };
        }
        case 'worker/readOutput':
          return readOutputChunks(output, msg.index, msg.offset, opts.readMaxBytes ?? msg.maxBytes);
        case 'worker/assemble':
          opts.onAssemble?.(msg);
          return { imageFailures: 1, pageIds: msg.pageIds };
        case 'worker/space':
          return { key: msg.spaceKey, name: 'Engineering' };
        case 'worker/ping':
          return { ready: true };
        default:
          return undefined;
      }
    }) as RunnerDeps['callWorker'],
    subscribeWorker: (jobId, l) => {
      let set = listeners.get(jobId);
      if (!set) listeners.set(jobId, (set = new Set()));
      set.add(l);
      return () => set!.delete(l);
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
    printSession: vi.fn(() => {
      h.sessions++;
      return {
        print: async (params: PrintParams) => {
          prints.push(params);
          if (opts.print) return opts.print(params);
          return pdf(`print${++printCount}`);
        },
        close: vi.fn(async () => undefined),
      };
    }),
    isDebuggerUnavailable: (e) => (e as Error)?.name === 'DebuggerUnavailableError',
    detachAll: vi.fn(async () => undefined),
    fallbackPrint: vi.fn(async () => undefined),
    liveRenderPages: vi.fn(async () => opts.live ?? new Map()),
    concatPdfs: vi.fn(async (parts: Uint8Array[]) => ({ bytes: pdf('concat'), offsets: parts.map((_, i) => i * 10) })),
    finalizeExport: vi.fn(async (base: Uint8Array, o: ExportFinalizeOptions) => {
      // The runner releases the live PDFs right after: keep a copy.
      finalizeCalls.push({ base, o: { ...o, live: o.live ? new Map(o.live) : undefined } });
      return { bytes: pdf('final'), pageCount: 9, unplacedLive: opts.unplacedLive ?? [] };
    }),
    finalizePdf: vi.fn(async (base: Uint8Array, o: FinalizeOptions) => {
      pageFinalizeCalls.push({ base, o });
      return { bytes: pdf('page'), pageCount: 1 };
    }),
    zipFiles: vi.fn(async (files: ZipEntry[]) => {
      zipped.push(files.map((f) => f.name));
      zipEntries.push(files);
      return new Uint8Array(files.length * 100);
    }),
    saveBytes: async (bytes, filename, mime, signal) => {
      saved.push({ bytes, filename, mime, signal });
      return 77;
    },
    saveCheckpoint: vi.fn(),
    settings: { ...DEFAULT_SETTINGS, printBatchSize: opts.batchSize ?? 150 },
    policy: opts.policy ?? {},
    version: '1.2.3',
    now: () => NOW,
    signal: controller.signal,
    onUpdate: (job) => {
      if (statuses[statuses.length - 1] !== job.status) statuses.push(job.status);
    },
    workerPingMs: 5,
  };
  return Object.assign(h, {
    deps,
    calls,
    statuses,
    prints,
    saved,
    finalizeCalls,
    pageFinalizeCalls,
    closed,
    controller,
    emit,
  });
}

const assembles = (h: Harness) => h.calls.filter((c): c is Extract<SwToWorker, { type: 'worker/assemble' }> => c.type === 'worker/assemble');
const fetchCall = (h: Harness) => h.calls.find((c) => c.type === 'worker/fetch') as Extract<SwToWorker, { type: 'worker/fetch' }>;

describe('runJob: combined PDF', () => {
  it('runs the happy path: one batch, cover unnumbered, page-tree bookmarks built from all pages', async () => {
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
    // With a cover, Chrome's footer (which cannot skip the cover) is off and numbers are stamped.
    expect(h.prints[0].displayHeaderFooter).toBe(false);

    const fin = h.finalizeCalls[0].o;
    expect(fin.pages.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(fin.excludeIds).toEqual([]);
    expect(fin.live).toBeUndefined();
    expect(fin.stampPageNumbers).toEqual({ skipFirst: 1 });
    expect(fin.metadata).toMatchObject({
      title: 'Root Title',
      author: 'Jane Doe',
      subject: 'Confluence export: ENG – 3 pages',
      creator: 'Fast PDF Export for Confluence v1.2.3',
    });

    expect(h.saved[0].filename).toBe('ENG_Root Title_2026-10-06.pdf');
    expect(h.saved[0].mime).toBe('application/pdf');
    expect(h.saved[0].signal).toBe(h.controller.signal);
    expect(job.result).toMatchObject({ filename: 'ENG_Root Title_2026-10-06.pdf', downloadId: 77, pageCount: 3, sheetCount: 9 });
    expect(job.errors.map((e) => e.severity)).toEqual(['degraded']); // 1 image placeholder
    expect(h.closed).toEqual([WORKER_TAB]);
    expect(h.calls.some((c) => c.type === 'worker/dispose')).toBe(true);
    expect(h.deps.saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(job.pageCount).toBe(3);
  });

  it('keeps Chrome’s footer when there is no cover and a single batch', async () => {
    const h = harness();
    const job = makeJob([ref('1'), ref('2', 1)], { includeCover: false });
    await runJob(job, h.deps);
    expect(h.prints[0].displayHeaderFooter).toBe(true);
    expect(h.finalizeCalls[0].o.stampPageNumbers).toBeUndefined();
  });

  it('collects in the background when no pages are given and records warnings', async () => {
    const h = harness({ collected: [ref('1'), ref('2', 1)], policy: { maxPages: 50 } });
    const job = makeJob([], {}, 'subtree');
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const collect = h.calls[0] as Extract<SwToWorker, { type: 'worker/collect' }>;
    expect(collect.type).toBe('worker/collect');
    expect(collect.maxItems).toBe(51);
    expect(job.pages.map((p) => p.id)).toEqual(['1', '2']);
    expect(job.warnings).toEqual(['Depth limited']);
  });

  it('"This page" needs no collection; the title comes from the fetch', async () => {
    const h = harness();
    const job = makeJob([], {}, 'current');
    job.request.root = { id: '9', type: 'page', spaceKey: 'ENG' };
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(h.calls.some((c) => c.type === 'worker/collect')).toBe(false);
    expect(fetchCall(h).pages).toEqual([
      expect.objectContaining({ id: '9', reason: 'root', depth: 0, url: `${SITE.baseUrl}/spaces/ENG/pages/9` }),
    ]);
    expect(job.pages[0].title).toBe('Fetched 9');
    expect(h.saved[0].filename).toBe('ENG_Fetched 9_2026-10-06.pdf');
  });

  it('skips pages that fail to load; they stay in the page list as excluded', async () => {
    const h = harness({ infos: { '2': { ok: false, httpStatus: 403 } } });
    const job = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(assembles(h)[0].pageIds).toEqual(['1']);
    expect(assembles(h)[0].allPages.map((p) => p.id)).toEqual(['1', '2']);
    expect(assembles(h)[0].excludeIds).toEqual(['2']);
    expect(h.finalizeCalls[0].o.excludeIds).toEqual(['2']);
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

  it('fails clearly for a folder without pages', async () => {
    const h = harness();
    const job = makeJob([ref('f', 0, { type: 'folder', title: 'Empty' }), ref('g', 1, { type: 'folder', title: 'Sub' })], {}, 'folder');
    await runJob(job, h.deps);
    expect(job.status).toBe('error');
    expect(job.message).toBe('This folder has no pages you can export.');
    expect(h.saved).toHaveLength(0);
  });

  it('enforces blocked spaces and maxPages', async () => {
    const policy: ManagedPolicy = { blockedSpaceKeys: ['hr'] };
    const h = harness({ policy });
    const job = makeJob([ref('1'), ref('2', 1, { spaceKey: 'HR', reason: 'linked' })]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(job.errors.find((e) => e.pageId === '2')?.message).toBe('Blocked by your administrator');
    expect(fetchCall(h).pages.map((p) => p.id)).toEqual(['1']);

    const h2 = harness({ policy: { maxPages: 1 } });
    const job2 = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job2, h2.deps);
    expect(job2.status).toBe('error');
    expect(job2.message).toMatch(/at most 1 pages/);
  });

  it('drops pages whose fetched space key is blocked', async () => {
    const h = harness({ policy: { blockedSpaceKeys: ['SECRET'] }, infos: { '2': { spaceKey: 'SECRET' } } });
    const job = makeJob([ref('1'), ref('2', 1, { spaceKey: 'OPS', reason: 'linked' })]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(assembles(h)[0].pageIds).toEqual(['1']);
    expect(job.errors.find((e) => e.pageId === '2')?.message).toBe('Blocked by your administrator');
  });

  it('fails closed for a linked page whose space is unknown when spaces are blocked', async () => {
    const h = harness({ policy: { blockedSpaceKeys: ['SECRET'] } });
    const job = makeJob([ref('1'), ref('2', 1, { spaceKey: undefined, reason: 'linked' })]);
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(assembles(h)[0].pageIds).toEqual(['1']);
    expect(job.errors.find((e) => e.pageId === '2')?.message).toBe(UNVERIFIED_SPACE_MESSAGE);
  });

  it('prints in batches: cover and TOC in the first only, destinations owned by the real section, numbers stamped', async () => {
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
    // One debugger session for all batches.
    expect(h.sessions).toBe(1);
    expect(h.prints.every((p) => p.displayHeaderFooter === false)).toBe(true);
    const concat = h.deps.concatPdfs as ReturnType<typeof vi.fn>;
    expect(concat).toHaveBeenCalledTimes(1);
    const owner = concat.mock.calls[0][1] as (name: string) => number | undefined;
    expect(owner('p-3')).toBe(1);
    expect(owner('p5-Some-heading')).toBe(2);
    expect(owner('p-1')).toBe(0);
    expect(owner('elsewhere')).toBeUndefined();
    expect(h.finalizeCalls[0].base).toEqual(pdf('concat'));
    expect(h.finalizeCalls[0].o.stampPageNumbers).toEqual({ skipFirst: 1 });
  });

  it('passes live-rendered pages to the finalizer and reports one that could not be placed', async () => {
    const live = new Map<string, Uint8Array | Error>([
      ['2', pdf('live2')],
      ['3', new Error('timeout')],
      ['4', pdf('live4')],
    ]);
    const h = harness({
      infos: { '2': { needsLiveRender: true }, '3': { needsLiveRender: true }, '4': { needsLiveRender: true } },
      live,
      unplacedLive: ['4'],
    });
    const job = makeJob([ref('1'), ref('2', 1), ref('3', 1), ref('4', 1)], { liveRender: true, marginsMm: { top: 10, right: 10, bottom: 5, left: 10 } });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');

    expect(fetchCall(h).needStorage).toBe(true);
    expect(fetchCall(h).liveRenderMacros.length).toBeGreaterThan(0);
    // Live pages print without Chrome's footer but keep room for the stamped numbers.
    const liveOpts = (h.deps.liveRenderPages as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(liveOpts.options.pageNumbers).toBe(false);
    expect(liveOpts.options.marginsMm.bottom).toBe(12);

    // Page 3's live render failed → assembled statically.
    expect(assembles(h)[0].liveRenderIds).toEqual(['2', '4']);
    const fin = h.finalizeCalls[0].o;
    expect([...(fin.live?.keys() ?? [])]).toEqual(['2', '4']);
    expect(fin.stampPageNumbers).toEqual({ skipFirst: 1 });
    expect(job.errors.find((e) => e.pageId === '3')?.severity).toBe('degraded');
    expect(job.errors.find((e) => e.pageId === '4')?.message).toMatch(/could not be placed/);
  });

  it('ignores live render when the policy disables it', async () => {
    const h = harness({ policy: { disableLiveRender: true }, infos: { '1': { needsLiveRender: true } } });
    const job = makeJob([ref('1')], { liveRender: true }, 'current');
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(h.deps.liveRenderPages).not.toHaveBeenCalled();
    expect(fetchCall(h).liveRenderMacros).toEqual([]);
    expect(fetchCall(h).needStorage).toBe(false);
  });

  it('uses the space name for space exports', async () => {
    const h = harness();
    const job = makeJob([ref('1'), ref('2', 1)], {}, 'space');
    await runJob(job, h.deps);
    expect(h.saved[0].filename).toBe('ENG_Engineering_2026-10-06.pdf');
    expect(h.finalizeCalls[0].o.metadata.title).toBe('Engineering');
    expect(h.finalizeCalls[0].o.metadata.subject).toBe('Confluence export: Engineering – 2 pages');
  });

  it('reports fetch progress in pages', async () => {
    const h = harness();
    const seen: string[] = [];
    const onUpdate = h.deps.onUpdate;
    h.deps.onUpdate = (job) => {
      onUpdate(job);
      if (job.status === 'fetching') seen.push(`${job.progress.done}/${job.progress.total} ${job.progress.unit}`);
    };
    const job = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job, h.deps);
    expect(seen).toContain('1/2 page');
    expect(seen).toContain('2/2 page');
  });

  it('fails with the worker’s message when the session expired mid-fetch', async () => {
    const h = harness({
      workerOp: (msg) => (msg.type === 'worker/fetch' ? { error: 'Your Confluence session has expired.', code: 'LOGIN_REQUIRED', result: undefined } : {}),
    });
    const job = makeJob([ref('1'), ref('2', 1)]);
    await runJob(job, h.deps);
    expect(job.status).toBe('error');
    expect(job.message).toBe('Your Confluence session has expired.');
    expect(h.closed).toEqual([WORKER_TAB]);
  });

  it('fails when the worker tab dies during a background operation', async () => {
    const h = harness({ workerOp: () => null });
    const original = h.deps.callWorker;
    h.deps.callWorker = (async (tabId: number, msg: SwToWorker) => {
      if (msg.type === 'worker/ping') throw new Error('No tab with id: 42');
      return original(tabId, msg);
    }) as RunnerDeps['callWorker'];
    const job = makeJob([ref('1')]);
    await runJob(job, h.deps);
    expect(job.status).toBe('error');
    expect(job.message).toMatch(/helper tab was closed/);
  });
});

describe('runJob: separate files', () => {
  it('prints each page on its own (one debugger session) and zips them', async () => {
    const h = harness();
    const job = makeJob([ref('1'), ref('2', 1), ref('f', 1, { type: 'folder', title: 'Folder' })], { separateFiles: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const asm = assembles(h);
    expect(asm.map((a) => a.pageIds)).toEqual([['1'], ['2']]);
    expect(asm.every((a) => a.cover === null && a.toc === false && a.allPages.length === 1)).toBe(true);
    expect(h.sessions).toBe(1);
    expect(h.prints).toHaveLength(2);
    expect(h.zipped).toEqual([['1_Page 1.pdf', '2_Page 2.pdf']]);
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

  it('closes a worker tab that finishes opening after the cancel', async () => {
    const h = harness();
    let resolveOpen!: (id: number) => void;
    h.deps.openWorkerTab = vi.fn(() => new Promise<number>((r) => (resolveOpen = r)));
    const job = makeJob([ref('1')]);
    const run = runJob(job, h.deps);
    await Promise.resolve();
    h.controller.abort();
    await run;
    expect(job.status).toBe('cancelled');
    expect((h.deps.openWorkerTab as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(h.controller.signal);
    expect(h.closed).toEqual([]);
    resolveOpen(99);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.closed).toEqual([99]);
  });

  it('cancelling while saving cancels the download', async () => {
    const h = harness();
    let saveSignal: AbortSignal | undefined;
    h.deps.saveBytes = (_bytes, _name, _mime, signal) =>
      new Promise<number>((_resolve, reject) => {
        saveSignal = signal;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        queueMicrotask(() => h.controller.abort());
      });
    const job = makeJob([ref('1')]);
    await runJob(job, h.deps);
    expect(job.status).toBe('cancelled');
    expect(saveSignal?.aborted).toBe(true);
    expect(job.result).toBeUndefined();
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

describe('runJob: Markdown and text', () => {
  const decode = (b: Uint8Array) => new TextDecoder().decode(b);
  const converts = (h: Harness) => h.calls.filter((c): c is Extract<SwToWorker, { type: 'worker/convert' }> => c.type === 'worker/convert');

  it('Markdown, combined, no images: converts in the worker and saves one UTF-8 .md file without printing', async () => {
    const h = harness();
    const statusMessages: string[] = [];
    const onUpdate = h.deps.onUpdate;
    h.deps.onUpdate = (j) => {
      onUpdate(j);
      if (j.message && statusMessages.at(-1) !== j.message) statusMessages.push(j.message);
    };
    const job = makeJob([ref('1'), ref('2', 1), ref('3', 1)], { format: 'markdown', downloadImages: false, liveRender: true });
    await runJob(job, h.deps);

    expect(job.status).toBe('done');
    expect(h.statuses).toEqual(['collecting', 'fetching', 'rendering', 'merging', 'done']);
    expect(statusMessages).toContain('Converting to Markdown…');
    // No printing: no debugger session, no assemble, no live render, no PDF post-processing.
    expect(h.sessions).toBe(0);
    expect(h.deps.printSession).not.toHaveBeenCalled();
    expect(assembles(h)).toHaveLength(0);
    expect(h.deps.liveRenderPages).not.toHaveBeenCalled();
    expect(h.deps.finalizeExport).not.toHaveBeenCalled();
    expect(fetchCall(h)).toMatchObject({ liveRenderMacros: [], needStorage: false });

    const [conv] = converts(h);
    expect(conv).toMatchObject({
      pageIds: ['1', '2', '3'],
      separate: false,
      toc: true,
      baseName: 'ENG_Root Title_2026-10-06',
      concurrency: DEFAULT_SETTINGS.apiConcurrency,
      excludeIds: [],
    });
    expect(conv.cover).toMatchObject({ title: 'Root Title', pageCount: 3, exportedBy: 'Jane Doe' });
    expect(conv.allPages.map((p) => p.id)).toEqual(['1', '2', '3']);

    expect(h.zipped).toEqual([]);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].filename).toBe('ENG_Root Title_2026-10-06.md');
    expect(h.saved[0].mime).toBe('text/markdown;charset=utf-8');
    expect(decode(h.saved[0].bytes)).toBe('# Ünïcode ✓ 1,2,3\n');
    expect(job.result).toMatchObject({ filename: 'ENG_Root Title_2026-10-06.md', downloadId: 77, pageCount: 3 });
    expect(job.result?.sheetCount).toBeUndefined();
    expect(job.errors).toEqual([]);
    expect(h.closed).toEqual([WORKER_TAB]);
  });

  it('plain text: .txt with a text/plain mime type', async () => {
    const h = harness();
    const job = makeJob([ref('1')], { format: 'text' });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(h.saved[0].filename).toBe('ENG_Root Title_2026-10-06.txt');
    expect(h.saved[0].mime).toBe('text/plain;charset=utf-8');
    expect(h.sessions).toBe(0);
  });

  it('Markdown with images: reads the output in chunks and zips documents (deflated) with assets (stored)', async () => {
    const png = new Uint8Array(300).map((_, i) => i % 251);
    const h = harness({
      readMaxBytes: 64,
      convert: (msg) => ({
        files: [{ path: `${msg.baseName}.md`, text: '![d](assets/1/d.png)\n' + 'x'.repeat(200) }],
        assets: [
          { path: 'assets/1/d.png', bytes: png },
          { path: 'assets/2/e.svg', bytes: new TextEncoder().encode('<svg/>') },
        ],
      }),
    });
    const job = makeJob([ref('1'), ref('2', 1)], { format: 'markdown', downloadImages: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const reads = h.calls.filter((c) => c.type === 'worker/readOutput');
    expect(reads.length).toBeGreaterThan(4);
    const [entries] = h.zipEntries;
    expect(entries.map((e) => [e.name, e.compress])).toEqual([
      ['ENG_Root Title_2026-10-06.md', true],
      ['assets/1/d.png', false],
      ['assets/2/e.svg', true],
    ]);
    expect(entries[1].data).toEqual(png);
    expect(decode(entries[0].data)).toBe('![d](assets/1/d.png)\n' + 'x'.repeat(200));
    expect(h.saved[0]).toMatchObject({ filename: 'ENG_Root Title_2026-10-06.zip', mime: 'application/zip' });
  });

  it('reports images that could not be downloaded as degraded, not fatal', async () => {
    const h = harness({
      convert: (msg) => ({
        files: [{ path: `${msg.baseName}.md`, text: '![a](https://acme.atlassian.net/wiki/download/attachments/1/a.png)' }],
        failedAssets: [
          { url: 'https://acme.atlassian.net/wiki/download/attachments/1/a.png', path: 'assets/1/a.png', reason: 'HTTP 404' },
          { url: 'https://acme.atlassian.net/wiki/download/attachments/1/b.png', path: 'assets/1/b.png', reason: 'timed out' },
        ],
      }),
    });
    const job = makeJob([ref('1')], { format: 'markdown' });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(job.errors).toEqual([
      expect.objectContaining({
        title: 'Images',
        severity: 'degraded',
        message: expect.stringMatching(/^2 images could not be downloaded \(HTTP 404, …\); the Markdown keeps their original links\.$/),
      }),
    ]);
    // Only the document is left: saved as a plain .md file.
    expect(h.saved[0].filename).toBe('ENG_Root Title_2026-10-06.md');
  });

  it('separate files: one file per content page, NN- names in the ZIP, cover for the index file', async () => {
    const folder = ref('f', 1, { type: 'folder', title: 'Folder' });
    const h = harness({
      convert: (msg) => ({
        files: [
          { path: '00-Contents.md', text: 'toc' },
          ...msg.pageIds.map((id, i) => ({ path: `${String(i + 1).padStart(2, '0')}-Page ${id}.md`, text: id })),
        ],
      }),
    });
    const job = makeJob([ref('1'), folder, ref('2', 2), ref('3', 1)], { format: 'markdown', separateFiles: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    const [conv] = converts(h);
    expect(conv).toMatchObject({ pageIds: ['1', '2', '3'], separate: true, cover: expect.objectContaining({ pageCount: 3 }), toc: true });
    expect(conv.allPages.map((p) => p.id)).toEqual(['1', 'f', '2', '3']);
    expect(h.zipped[0]).toEqual(['00-Contents.md', '01-Page 1.md', '02-Page 2.md', '03-Page 3.md']);
    expect(h.saved[0].filename).toBe('ENG_Root Title_2026-10-06.zip');
    expect(h.sessions).toBe(0);
  });

  it('separate files with a single page: saved as that page’s .txt', async () => {
    const h = harness({ convert: () => ({ files: [{ path: '01-Page 1.txt', text: 'Page 1\n======\n' }] }) });
    const job = makeJob([ref('1')], { format: 'text', separateFiles: true, includeToc: false });
    await runJob(job, h.deps);
    expect(h.saved[0]).toMatchObject({ filename: 'ENG_Page 1_2026-10-06.txt', mime: 'text/plain;charset=utf-8' });
  });

  it('separate files with a single page and cover/TOC on: no contents file, one .md like a separate PDF', async () => {
    const h = harness({
      convert: (msg) => ({
        files: [
          ...(msg.cover || msg.toc ? [{ path: '00-Contents.md', text: 'toc' }] : []),
          { path: '01-Page 1.md', text: '# Page 1\n' },
        ],
      }),
    });
    const job = makeJob([ref('1')], { format: 'markdown', separateFiles: true, includeCover: true, includeToc: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(converts(h)[0]).toMatchObject({ pageIds: ['1'], separate: true, cover: null, toc: false });
    expect(h.zipped).toEqual([]);
    expect(h.saved[0]).toMatchObject({ filename: 'ENG_Page 1_2026-10-06.md', mime: 'text/markdown;charset=utf-8' });
  });

  it('separate files without any regular page (only whiteboards): one combined file of links', async () => {
    const h = harness();
    const pages = [
      ref('1', 0, { type: 'folder', title: 'Boards' }),
      ref('w1', 1, { type: 'whiteboard', title: 'Board A', parentId: '1' }),
      ref('w2', 1, { type: 'whiteboard', title: 'Board B', parentId: '1' }),
    ];
    const job = makeJob(pages, { format: 'text', separateFiles: true, includeCover: true, includeToc: true });
    await runJob(job, h.deps);
    expect(job.status).toBe('done');
    expect(converts(h)[0]).toMatchObject({ pageIds: ['1', 'w1', 'w2'], separate: false, toc: true, cover: expect.objectContaining({ title: 'Root Title' }) });
    expect(h.saved[0]).toMatchObject({ filename: 'ENG_Root Title_2026-10-06.txt', mime: 'text/plain;charset=utf-8' });
  });

  it('shows image download progress while converting', async () => {
    const h = harness();
    const seen: string[] = [];
    const onUpdate = h.deps.onUpdate;
    h.deps.onUpdate = (j) => {
      onUpdate(j);
      if (j.message) seen.push(j.message);
    };
    await runJob(makeJob([ref('1')], { format: 'markdown' }), h.deps);
    expect(seen).toContain('Downloading images 1/2');
  });

  it('passes skipped pages as excluded and fails when the converter fails', async () => {
    const h = harness({
      infos: { '2': { ok: false, httpStatus: 404 } },
      workerOp: (msg) => (msg.type === 'worker/convert' ? { error: 'converter exploded' } : {}),
    });
    const job = makeJob([ref('1'), ref('2', 1)], { format: 'markdown' });
    await runJob(job, h.deps);
    expect(converts(h)[0]).toMatchObject({ pageIds: ['1'], excludeIds: ['2'] });
    expect(job.status).toBe('error');
    expect(job.message).toBe('converter exploded');
    expect(h.closed).toEqual([WORKER_TAB]);
  });

  it('cancels while converting: tells the worker, closes the tab, never attached a debugger', async () => {
    const h = harness({ workerOp: (msg) => (msg.type === 'worker/convert' ? null : {}) });
    const job = makeJob([ref('1')], { format: 'text' });
    const run = runJob(job, h.deps);
    await vi.waitFor(() => expect(converts(h)).toHaveLength(1));
    h.controller.abort();
    await run;
    expect(job.status).toBe('cancelled');
    expect(h.calls.some((c) => c.type === 'worker/cancel')).toBe(true);
    expect(h.sessions).toBe(0);
    expect(h.saved).toEqual([]);
    expect(h.closed).toEqual([WORKER_TAB]);
  });
});

describe('runner helpers', () => {
  it('applyPolicyToPages: same-tree pages inherit the root space; linked pages without a space fail closed', () => {
    const pages = [ref('1', 0, { spaceKey: undefined }), ref('2', 1, { spaceKey: undefined, reason: 'linked' }), ref('3', 1, { spaceKey: 'OPS', reason: 'linked' })];
    const res = applyPolicyToPages(pages, { blockedSpaceKeys: ['ENG'] }, 'eng');
    expect(res.pages.map((p) => p.id)).toEqual(['3']);
    expect(res.errors.map((e) => [e.pageId, e.message])).toEqual([
      ['1', 'Blocked by your administrator'],
      ['2', UNVERIFIED_SPACE_MESSAGE],
    ]);
    // Without a block list nothing is dropped.
    expect(applyPolicyToPages(pages, {}, 'eng').pages).toHaveLength(3);
  });

  it('destinationPageId maps section and heading names to their page', () => {
    expect(destinationPageId('p-123')).toBe('123');
    expect(destinationPageId('p123-Intro')).toBe('123');
    expect(destinationPageId('toc')).toBeUndefined();
  });

  it('currentPageRef builds the page from the request', () => {
    const job = makeJob([], {}, 'current');
    expect(currentPageRef(job.request)).toEqual({
      id: '1',
      type: 'page',
      title: 'Root Title',
      depth: 0,
      reason: 'root',
      spaceKey: 'ENG',
      url: `${SITE.baseUrl}/spaces/ENG/pages/1`,
    });
  });
});
