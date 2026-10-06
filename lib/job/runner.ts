/**
 * The export state machine (ARCHITECTURE §3, steps 3–10), independent of Chrome APIs: every side
 * effect goes through `RunnerDeps` so the pipeline is unit-testable with fakes. The job object is
 * mutated in place and reported through `deps.onUpdate` after every change.
 *
 *   collecting → fetching → rendering → merging → done | error | cancelled
 */
import type {
  CoverInfo,
  SwToWorker,
  SwToWorkerResponses,
  WorkerToSw,
} from '../messages';
import { effectiveMarginsMm } from '../assemble/geometry';
import type { FinalizeOptions, OutlineItem, PdfMetadata } from '../pdf/merge';
import type { PrintParams } from '../render/cdp';
import type {
  ExportJobState,
  ExportOptions,
  FetchedPageInfo,
  JobError,
  ManagedPolicy,
  PageRef,
  Settings,
  SiteInfo,
} from '../types';
import { buildFilename, sanitizeFilenamePart } from '../util/filename';

export const PRODUCT_NAME = 'Fast PDF Export for Confluence';
export const BLOCKED_MESSAGE = 'Blocked by your administrator';

const LINK_ONLY_TYPES = new Set(['folder', 'whiteboard', 'database', 'embed']);
const WORKER_CLEANUP_TIMEOUT_MS = 800;

export interface LiveRenderOpts {
  options: ExportOptions;
  concurrency: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, current?: string) => void;
  nearTabId?: number;
}

export interface RunnerDeps {
  /** Typed RPC to the worker tab (lib/rpc.ts callWorker). */
  callWorker<M extends SwToWorker>(tabId: number, msg: M): Promise<SwToWorkerResponses[M['type']]>;
  /** Receive `worker/progress` / `worker/throttled` notifications for a job. Returns unsubscribe. */
  subscribeWorker(jobId: string, listener: (msg: WorkerToSw) => void): () => void;
  openWorkerTab(site: SiteInfo, nearTabId?: number): Promise<number>;
  closeTabQuietly(tabId: number | undefined): Promise<void>;
  toPrintParams(options: ExportOptions): PrintParams;
  printTabToPdf(tabId: number, params: PrintParams, signal?: AbortSignal): Promise<Uint8Array>;
  isDebuggerUnavailable(e: unknown): boolean;
  /** Detach stale debugger sessions after a cancel. */
  detachAll(): Promise<void>;
  /** Debugger fallback: show the worker tab and open the system print dialog on it. */
  fallbackPrint(tabId: number): Promise<void>;
  liveRenderPages(pages: PageRef[], o: LiveRenderOpts): Promise<Map<string, Uint8Array | Error>>;
  concatPdfs(parts: Uint8Array[]): Promise<{ bytes: Uint8Array; offsets: number[] }>;
  /** First sheet of every page section, keyed by page id (named destinations `p-{id}`). */
  findSectionStartPages(pdf: Uint8Array, pages: { id: string; title: string }[]): Promise<Map<string, number>>;
  finalizePdf(base: Uint8Array, o: FinalizeOptions): Promise<{ bytes: Uint8Array; pageCount: number }>;
  buildOutline(pages: PageRef[], startPage: Map<string, number>): OutlineItem[];
  /** Outline (bookmarks) already present in a PDF — Chrome's, or the merged one of concatPdfs. */
  readOutline(pdf: Uint8Array): Promise<OutlineItem[]>;
  countPdfPages(pdf: Uint8Array): Promise<number>;
  zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array;
  saveBytes(bytes: Uint8Array, filename: string, mime: string): Promise<number>;
  settings: Settings;
  policy: ManagedPolicy;
  /** Extension version (chrome.runtime.getManifest().version). */
  version: string;
  now(): number;
  signal: AbortSignal;
  onUpdate(job: ExportJobState): void;
}

// ───────────────────────────── pure helpers (exported for the manager and tests) ─────────────

function abortError(): DOMException {
  return new DOMException('The export was cancelled.', 'AbortError');
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError');
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}

/** Rejects as soon as `signal` aborts, even if `p` never settles. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** lib/download.ts DownloadInterruptedError caused by the user cancelling the save dialog. */
function isUserCancelledDownload(e: unknown): boolean {
  const x = e as { code?: unknown; reason?: unknown } | null;
  return typeof x === 'object' && x !== null && x.code === 'DOWNLOAD_INTERRUPTED' && x.reason === 'USER_CANCELED';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(undefined);
      },
    );
  });
}

export function isLinkOnly(ref: Pick<PageRef, 'type'>): boolean {
  return LINK_ONLY_TYPES.has(ref.type);
}

export function isBlockedSpace(spaceKey: string | undefined, policy: ManagedPolicy): boolean {
  if (!spaceKey || !policy.blockedSpaceKeys?.length) return false;
  const key = spaceKey.toLowerCase();
  return policy.blockedSpaceKeys.some((k) => k.toLowerCase() === key);
}

/**
 * Drops pages in spaces blocked by the managed policy. Pages without a space key inherit the
 * export root's space when they come from the same tree (root/descendant/selected).
 */
export function applyPolicyToPages(
  pages: PageRef[],
  policy: ManagedPolicy,
  rootSpaceKey?: string,
): { pages: PageRef[]; errors: JobError[] } {
  if (!policy.blockedSpaceKeys?.length) return { pages, errors: [] };
  const kept: PageRef[] = [];
  const errors: JobError[] = [];
  for (const p of pages) {
    const key = p.spaceKey ?? (p.reason === 'linked' ? undefined : rootSpaceKey);
    if (isBlockedSpace(key, policy)) {
      errors.push({ pageId: p.id, title: p.title, message: BLOCKED_MESSAGE, severity: 'skipped' });
    } else {
      kept.push(p);
    }
  }
  return { pages: kept, errors };
}

/** Error text when the page count exceeds the managed `maxPages`, else null. */
export function maxPagesError(count: number, policy: ManagedPolicy): string | null {
  if (!policy.maxPages || count <= policy.maxPages) return null;
  return `This export has ${count} pages, but your administrator allows at most ${policy.maxPages} pages per export. Remove some pages and try again.`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

function friendlyFetchError(info: FetchedPageInfo): string {
  if (info.error) return info.error;
  switch (info.httpStatus) {
    case 401:
    case 403:
      return 'You do not have permission to view this page.';
    case 404:
      return 'Page not found (it may have been deleted or you lack access).';
    default:
      return 'The page could not be loaded.';
  }
}

/** Page start sheet after inserting `inserts` (each adds `count` sheets after `afterPageIndex`). */
export function shiftStartPage(start: number, inserts: { afterPageIndex: number; count: number }[]): number {
  let shifted = start;
  for (const ins of inserts) if (ins.afterPageIndex < start) shifted += ins.count;
  return shifted;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ───────────────────────────── the runner ─────────────────────────────

export async function runJob(job: ExportJobState, deps: RunnerDeps): Promise<void> {
  const { signal, settings } = deps;
  const request = job.request;
  const options = request.options;
  let tabId: number | undefined;
  let keepTab = false;

  const update = (patch: Partial<ExportJobState> = {}) => {
    Object.assign(job, patch);
    deps.onUpdate(job);
  };
  const check = () => {
    if (signal.aborted) throw abortError();
  };
  const worker = <M extends SwToWorker>(msg: M) => {
    if (tabId === undefined) return Promise.reject(new Error('The export tab is not open.'));
    return abortable(deps.callWorker(tabId, msg), signal);
  };

  const unsubscribe = deps.subscribeWorker(job.id, (msg) => {
    if (msg.type === 'worker/throttled') {
      const secs = Math.max(1, Math.ceil(msg.retryInMs / 1000));
      update({ throttled: true, message: `Throttled by Confluence, retrying in ${secs} s…` });
    } else if (msg.type === 'worker/progress') {
      if (job.status === 'fetching') {
        update({
          throttled: false,
          message: 'Fetching pages',
          progress: { done: msg.done, total: msg.total, current: msg.current },
        });
      } else if (job.status === 'collecting') {
        update({ throttled: false, progress: { ...job.progress, current: msg.current } });
      }
    }
  });

  try {
    check();
    // ── 3. worker tab ──
    update({ status: 'collecting', message: 'Connecting to Confluence', progress: { done: 0, total: 0 } });
    tabId = await abortable(deps.openWorkerTab(request.site, request.sourceTabId), signal);
    check();

    // ── 4. collect (skipped when the preview already supplied the page list) ──
    let pages = job.pages;
    if (!pages.length) {
      update({ message: 'Collecting pages' });
      const res = await worker({ type: 'worker/collect', jobId: job.id, request });
      pages = res.pages;
      if (res.warnings.length) job.warnings = [...(job.warnings ?? []), ...res.warnings];
    }
    const filtered = applyPolicyToPages(pages, deps.policy, request.root.spaceKey);
    pages = filtered.pages;
    job.errors.push(...filtered.errors);
    const tooMany = maxPagesError(pages.length, deps.policy);
    if (tooMany) throw new Error(tooMany);
    if (!pages.length) {
      throw new Error(filtered.errors.length ? 'All pages are in spaces blocked by your administrator.' : 'There is nothing to export.');
    }
    update({ pages });
    check();

    // ── 6. fetch ──
    update({ status: 'fetching', message: 'Fetching pages', progress: { done: 0, total: pages.length } });
    const liveRequested = options.liveRender && !deps.policy.disableLiveRender;
    const { results } = await worker({
      type: 'worker/fetch',
      jobId: job.id,
      site: request.site,
      pages,
      liveRenderMacros: liveRequested ? settings.liveRenderMacros : [],
      concurrency: settings.apiConcurrency,
      needStorage: liveRequested,
    });
    check();
    const infoById = new Map(results.map((r) => [r.id, r]));
    const included: PageRef[] = [];
    for (const ref of pages) {
      const info = infoById.get(ref.id);
      if (!info) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: 'The page could not be loaded.', severity: 'skipped' });
      } else if (!info.ok) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: friendlyFetchError(info), severity: 'skipped' });
      } else if (isBlockedSpace(info.spaceKey, deps.policy)) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: BLOCKED_MESSAGE, severity: 'skipped' });
      } else {
        included.push(ref);
      }
    }
    const contentPages = pages.filter((p) => !isLinkOnly(p));
    const includedContent = included.filter((p) => !isLinkOnly(p));
    if (!included.length || (contentPages.length > 0 && includedContent.length === 0)) {
      const first = job.errors.find((e) => e.severity === 'skipped');
      const n = contentPages.length || pages.length;
      throw new Error(
        n === 1
          ? first?.message ?? 'The page could not be exported.'
          : `None of the ${n} pages could be exported${first ? ` (${first.message})` : ''}.`,
      );
    }
    update({ progress: { done: pages.length, total: pages.length } });

    // ── shared output details ──
    const rootRef = included.find((p) => p.id === request.root.id) ?? pages.find((p) => p.id === request.root.id);
    const spaceKey = request.root.spaceKey ?? rootRef?.spaceKey ?? included[0]?.spaceKey;
    let docTitle = request.root.title || rootRef?.title || included[0].title;
    let spaceName: string | undefined;
    if (request.mode === 'space' && spaceKey) {
      try {
        spaceName = (await worker({ type: 'worker/space', site: request.site, spaceKey }))?.name;
      } catch (e) {
        if (isAbort(e, signal)) throw e;
      }
      if (spaceName) docTitle = spaceName;
    }
    const exportedAt = new Date(deps.now());
    const creator = `${PRODUCT_NAME} v${deps.version}`;
    const pageCount = includedContent.length;
    const subjectSpace = spaceName ?? spaceKey ?? request.site.siteTitle ?? new URL(request.site.origin).hostname;
    const metadataFor = (title: string, n: number): PdfMetadata => ({
      title,
      author: request.userDisplayName,
      subject: `Confluence export: ${subjectSpace} – ${plural(n, 'page')}`,
      keywords: ['Confluence', ...(spaceKey ? [spaceKey] : [])],
      creator,
    });
    const liveCandidates = liveRequested
      ? includedContent.filter((p) => infoById.get(p.id)?.needsLiveRender)
      : [];
    let imageFailures = 0;

    // ── 8. live render first, so pages whose live render fails fall back to the static path ──
    const livePdfs = new Map<string, Uint8Array>();
    if (liveCandidates.length) {
      update({
        status: 'rendering',
        message: `Rendering diagrams 0/${liveCandidates.length}`,
        progress: { done: 0, total: liveCandidates.length },
      });
      let results: Map<string, Uint8Array | Error>;
      try {
        results = await abortable(
          deps.liveRenderPages(liveCandidates, {
            // Combined PDFs with inserted pages get their numbers stamped afterwards: print without
            // Chrome's footer but keep the footer-sized bottom margin so the stamp never overlaps.
            options: options.separateFiles
              ? options
              : { ...options, marginsMm: effectiveMarginsMm(options), pageNumbers: false },
            concurrency: settings.liveRenderConcurrency,
            signal,
            nearTabId: request.sourceTabId,
            onProgress: (done, current) =>
              update({
                message: `Rendering diagrams ${done}/${liveCandidates.length}`,
                progress: { done, total: liveCandidates.length, current },
              }),
          }),
          signal,
        );
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        results = new Map(liveCandidates.map((p) => [p.id, e instanceof Error ? e : new Error(errorMessage(e))]));
      }
      for (const p of liveCandidates) {
        const r = results.get(p.id);
        if (r instanceof Uint8Array && r.length) {
          livePdfs.set(p.id, r);
        } else {
          const why = r instanceof Error ? r.message : 'no output';
          job.errors.push({
            pageId: p.id,
            title: p.title,
            message: `Live render failed (${why}); the static version was used.`,
            severity: 'degraded',
          });
        }
      }
      check();
    }

    const cover: CoverInfo | null = options.includeCover
      ? {
          title: docTitle,
          sourceUrl: rootRef?.url ?? request.site.baseUrl,
          spaceKey,
          exportedAt: exportedAt.toISOString(),
          exportedBy: request.userDisplayName,
          pageCount,
          siteTitle: request.site.siteTitle,
        }
      : null;
    const params = deps.toPrintParams(options);
    const batches = chunk(included, settings.printBatchSize);
    // Chrome numbers each print on its own: with several batches or inserted live pages the
    // footer would be wrong, so print without it and stamp "n / total" on the final document.
    const stampNumbers = options.pageNumbers && !options.separateFiles && (batches.length > 1 || livePdfs.size > 0);
    const batchParams: PrintParams = stampNumbers ? { ...params, displayHeaderFooter: false } : params;

    /** Debugger blocked: assemble everything into the worker tab and open the print dialog. */
    const fallbackToPrintDialog = async () => {
      update({ status: 'rendering', message: 'Opening the print dialog', progress: { done: 0, total: 1 } });
      await worker({
        type: 'worker/assemble',
        jobId: job.id,
        site: request.site,
        pageIds: (options.separateFiles ? includedContent : included).map((p) => p.id),
        liveRenderIds: [],
        allPages: included,
        options,
        cover,
        toc: options.includeToc,
      });
      check();
      await deps.fallbackPrint(tabId!);
      keepTab = true;
      update({
        status: 'done',
        printDialog: true,
        finishedAt: deps.now(),
        progress: { done: 1, total: 1 },
        message:
          "Chrome's debugger is not available (it may be blocked by your administrator or in use by DevTools or another extension), " +
          'so the system print dialog was opened instead. Choose "Save as PDF" as the destination.',
      });
    };

    const print = async (p: PrintParams = params): Promise<Uint8Array | null> => {
      try {
        return await deps.printTabToPdf(tabId!, p, signal);
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        if (deps.isDebuggerUnavailable(e)) return null;
        throw e;
      }
    };

    const pushImageError = () => {
      if (imageFailures > 0) {
        job.errors.push({
          pageId: '',
          title: 'Images',
          message: `${plural(imageFailures, 'image')} could not be loaded and ${imageFailures === 1 ? 'was' : 'were'} replaced by a placeholder.`,
          severity: 'degraded',
        });
      }
    };

    const finish = (filename: string, downloadId: number, bytes: number, sheetCount?: number) => {
      const skipped = job.errors.filter((e) => e.severity === 'skipped').length;
      update({
        status: 'done',
        finishedAt: deps.now(),
        progress: { done: job.progress.total, total: job.progress.total },
        result: { filename, downloadId, bytes, pageCount, sheetCount },
        message: skipped ? `Saved ${filename} (${plural(skipped, 'page')} skipped)` : `Saved ${filename}`,
      });
    };

    // ── FR-11: one PDF per page, zipped ──
    if (options.separateFiles) {
      const files: { name: string; data: Uint8Array }[] = [];
      const width = String(includedContent.length).length;
      for (let i = 0; i < includedContent.length; i++) {
        const ref = includedContent[i];
        check();
        update({
          status: 'rendering',
          message: `Rendering page ${i + 1} of ${includedContent.length}`,
          progress: { done: i, total: includedContent.length, current: ref.title },
        });
        let pdf = livePdfs.get(ref.id);
        if (!pdf) {
          const asm = await worker({
            type: 'worker/assemble',
            jobId: job.id,
            site: request.site,
            pageIds: [ref.id],
            liveRenderIds: [],
            // Only this page: links to other pages stay links to Confluence.
            allPages: [ref],
            options,
            cover: null,
            toc: false,
          });
          imageFailures += asm.imageFailures;
          check();
          const printed = await print();
          if (!printed) {
            await fallbackToPrintDialog();
            return;
          }
          pdf = printed;
        }
        const finalized = await deps.finalizePdf(pdf, { metadata: metadataFor(ref.title, 1) });
        const stem = sanitizeFilenamePart(ref.title, 100) || ref.id;
        files.push({ name: `${String(i + 1).padStart(width, '0')}_${stem}.pdf`, data: finalized.bytes });
      }
      check();
      update({ status: 'merging', message: 'Saving', progress: { done: 0, total: 1 } });
      pushImageError();
      const date = exportedAt;
      if (files.length === 1) {
        const filename = buildFilename({ spaceKey, title: includedContent[0].title, date, ext: 'pdf' });
        const downloadId = await abortable(deps.saveBytes(files[0].data, filename, 'application/pdf'), signal);
        finish(filename, downloadId, files[0].data.length, undefined);
      } else {
        const zip = deps.zipFiles(files);
        const filename = buildFilename({ spaceKey, title: docTitle, date, ext: 'zip' });
        const downloadId = await abortable(deps.saveBytes(zip, filename, 'application/zip'), signal);
        finish(filename, downloadId, zip.length, undefined);
      }
      return;
    }

    // ── 7. assemble + print in batches ──
    const parts: Uint8Array[] = [];
    for (let b = 0; b < batches.length; b++) {
      check();
      update({
        status: 'rendering',
        message: batches.length > 1 ? `Printing part ${b + 1} of ${batches.length}` : 'Printing PDF',
        progress: { done: b, total: batches.length },
      });
      const batch = batches[b];
      const asm = await worker({
        type: 'worker/assemble',
        jobId: job.id,
        site: request.site,
        pageIds: batch.map((p) => p.id),
        liveRenderIds: batch.filter((p) => livePdfs.has(p.id)).map((p) => p.id),
        allPages: included,
        options,
        cover: b === 0 ? cover : null,
        toc: b === 0 && options.includeToc,
      });
      imageFailures += asm.imageFailures;
      check();
      const printed = await print(batchParams);
      if (!printed) {
        await fallbackToPrintDialog();
        return;
      }
      parts.push(printed);
    }
    check();

    // ── 9. post-process ──
    update({ status: 'merging', message: 'Building the PDF', progress: { done: 0, total: 1 } });
    const base = parts.length > 1 ? (await deps.concatPdfs(parts)).bytes : parts[0];
    check();

    const inserts: { afterPageIndex: number; pdf: Uint8Array; count: number }[] = [];
    let outline: OutlineItem[] | undefined;
    if (livePdfs.size > 0 || parts.length > 1) {
      const dests = await deps.findSectionStartPages(
        base,
        included.map((p) => ({ id: p.id, title: p.title })),
      );
      check();
      for (const ref of included) {
        const pdf = livePdfs.get(ref.id);
        if (!pdf) continue;
        const at = dests.get(ref.id);
        if (at === undefined) {
          job.errors.push({
            pageId: ref.id,
            title: ref.title,
            message: 'The live-rendered version could not be placed in the PDF; only the page header is included.',
            severity: 'degraded',
          });
          continue;
        }
        let count = 0;
        try {
          count = await deps.countPdfPages(pdf);
        } catch {
          count = 0;
        }
        if (count > 0) inserts.push({ afterPageIndex: at, pdf, count });
      }
      inserts.sort((a, b) => a.afterPageIndex - b.afterPageIndex);
      // Final start sheet of every page (after inserts), keyed by page id.
      const startPage = new Map<string, number>();
      const outlined: PageRef[] = [];
      for (const ref of included) {
        const at = dests.get(ref.id);
        if (at === undefined) continue;
        const shifted = shiftStartPage(at, inserts);
        startPage.set(ref.id, shifted);
        outlined.push(ref);
      }
      // Chrome's outline (page titles + their headings) survives concatenation and inserts
      // (entries point at page objects, not indexes): only rebuild when there is none.
      let existing: OutlineItem[] = [];
      try {
        existing = await deps.readOutline(base);
      } catch {
        existing = [];
      }
      if (!existing.length && outlined.length) outline = deps.buildOutline(outlined, startPage);
    }

    pushImageError();
    const finalized = await deps.finalizePdf(base, {
      metadata: metadataFor(docTitle, pageCount),
      inserts: inserts.length ? inserts.map(({ afterPageIndex, pdf }) => ({ afterPageIndex, pdf })) : undefined,
      outline,
      stampPageNumbers: stampNumbers ? {} : undefined,
    });
    check();

    // ── 10. download ──
    const filename = buildFilename({ spaceKey, title: docTitle, date: exportedAt, ext: 'pdf' });
    const downloadId = await abortable(deps.saveBytes(finalized.bytes, filename, 'application/pdf'), signal);
    finish(filename, downloadId, finalized.bytes.length, finalized.pageCount);
  } catch (e) {
    if (isAbort(e, signal)) {
      if (tabId !== undefined) {
        await withTimeout(deps.callWorker(tabId, { type: 'worker/cancel', jobId: job.id }), WORKER_CLEANUP_TIMEOUT_MS);
      }
      await withTimeout(deps.detachAll(), WORKER_CLEANUP_TIMEOUT_MS);
      update({ status: 'cancelled', message: 'Export cancelled', throttled: false, finishedAt: deps.now() });
    } else if (isUserCancelledDownload(e)) {
      // The user dismissed the "Save as" dialog: not a failure.
      update({ status: 'cancelled', message: 'Saving was cancelled', throttled: false, finishedAt: deps.now() });
    } else {
      const message = errorMessage(e);
      job.errors.push({ pageId: '', title: '', message, severity: 'fatal' });
      update({ status: 'error', message, throttled: false, finishedAt: deps.now() });
    }
  } finally {
    unsubscribe();
    if (tabId !== undefined && !keepTab) {
      // After a cancel the worker already dropped its state; just close the tab quickly.
      if (!signal.aborted) {
        await withTimeout(deps.callWorker(tabId, { type: 'worker/dispose', jobId: job.id }), WORKER_CLEANUP_TIMEOUT_MS);
      }
      await deps.closeTabQuietly(tabId);
    }
  }
}
