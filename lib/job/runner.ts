/**
 * The export state machine (ARCHITECTURE §3, steps 3–10), independent of Chrome APIs: every side
 * effect goes through `RunnerDeps` so the pipeline is unit-testable with fakes. The job object is
 * mutated in place and reported through `deps.onUpdate` after every change.
 *
 *   collecting → fetching → rendering → merging → done | error | cancelled
 *
 * Markdown / text (`options.format`): the same collect and fetch, then `worker/convert` in the
 * worker tab ('rendering': "Converting to Markdown…", then image downloads), the files are read
 * back with `worker/readOutput` and saved as one document or a ZIP. No printing, so no debugger
 * session (no "started debugging this browser" bar) and no live render.
 */
import type { CoverInfo, SwToWorker, SwToWorkerResponses, WorkerOp, WorkerOpResults, WorkerToSw } from '../messages';
import { effectiveMarginsMm } from '../assemble/geometry';
import { contentUrl } from '../confluence/url';
import { FORMATS, convertingMessage, formatOf, isCompressible } from '../format';
import { collectOutput } from '../output/chunks';
import type { ZipEntry } from '../pdf/zip';
import type { ExportFinalizeOptions, ExportFinalizeResult, FinalizeOptions, PdfMetadata } from '../pdf/merge';
import type { PrintParams } from '../render/cdp';
import type {
  ExportJobState,
  ExportOptions,
  ExportRequest,
  FetchedPageInfo,
  JobError,
  ManagedPolicy,
  PageRef,
  Settings,
  SiteInfo,
} from '../types';
import { buildFilename, sanitizeFilenamePart } from '../util/filename';
import { runWorkerOp } from './workerOp';

export const PRODUCT_NAME = 'Fast PDF Export for Confluence';
export const BLOCKED_MESSAGE = 'Blocked by your administrator';
/** A linked page whose space is unknown cannot be checked against blocked spaces: fail closed. */
export const UNVERIFIED_SPACE_MESSAGE = "This page's space could not be checked against your administrator's policy.";
export const SAVING_MESSAGE = 'Saving… (choose a location if Chrome asks)';

const LINK_ONLY_TYPES = new Set(['folder', 'whiteboard', 'database', 'embed', 'slides']);
const WORKER_CLEANUP_TIMEOUT_MS = 800;

export interface LiveRenderOpts {
  options: ExportOptions;
  concurrency: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, current?: string) => void;
  nearTabId?: number;
}

/** A debugger session on the worker tab (lib/render/cdp.ts createPrintSession). */
export interface RunnerPrintSession {
  print(params: PrintParams): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface RunnerDeps {
  /** Typed RPC to the worker tab (lib/rpc.ts callWorker). */
  callWorker<M extends SwToWorker>(tabId: number, msg: M): Promise<SwToWorkerResponses[M['type']]>;
  /** Receive `worker/progress` / `worker/throttled` / `worker/done` notifications for a job. Returns unsubscribe. */
  subscribeWorker(jobId: string, listener: (msg: WorkerToSw) => void): () => void;
  /** Opens (or takes over) a worker tab; closes it itself when `signal` aborts while opening. */
  openWorkerTab(site: SiteInfo, nearTabId?: number, signal?: AbortSignal): Promise<number>;
  closeTabQuietly(tabId: number | undefined): Promise<void>;
  toPrintParams(options: ExportOptions): PrintParams;
  /** Attaches the debugger once for all prints of the job (one infobar), detached on close(). */
  printSession(tabId: number, signal: AbortSignal): RunnerPrintSession;
  isDebuggerUnavailable(e: unknown): boolean;
  /** Detach stale debugger sessions after a cancel. */
  detachAll(): Promise<void>;
  /** Debugger fallback: show the worker tab and open the system print dialog on it. */
  fallbackPrint(tabId: number): Promise<void>;
  liveRenderPages(pages: PageRef[], o: LiveRenderOpts): Promise<Map<string, Uint8Array | Error>>;
  /** Merges print batches; `owner(name)` = the batch holding the real target of a named destination. */
  concatPdfs(parts: Uint8Array[], owner?: (name: string) => number | undefined): Promise<{ bytes: Uint8Array; offsets: number[] }>;
  /** The combined PDF: live inserts, page-tree bookmarks, page numbers, metadata (one parse). */
  finalizeExport(base: Uint8Array, o: ExportFinalizeOptions): Promise<ExportFinalizeResult>;
  /** Metadata for one-page documents (separate files). */
  finalizePdf(base: Uint8Array, o: FinalizeOptions): Promise<{ bytes: Uint8Array; pageCount: number }>;
  /** `compress`: deflate the entry (text); others are stored. Names may contain directories. */
  zipFiles(files: ZipEntry[], signal?: AbortSignal): Promise<Uint8Array>;
  /** Saves the file; aborting `signal` cancels the download too. */
  saveBytes(bytes: Uint8Array, filename: string, mime: string, signal?: AbortSignal): Promise<number>;
  /** Stores the request and page list once, so an interrupted export can be started again. */
  saveCheckpoint?(job: ExportJobState): void;
  settings: Settings;
  policy: ManagedPolicy;
  /** Extension version (chrome.runtime.getManifest().version). */
  version: string;
  now(): number;
  signal: AbortSignal;
  onUpdate(job: ExportJobState): void;
  /** Liveness ping interval while a background worker operation runs (tests shorten it). */
  workerPingMs?: number;
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
 * With a block list, a linked page (it may come from any space) whose space key is unknown
 * cannot be checked: it is left out instead of being exported (fail closed). Pages of the same
 * tree (root/descendant/selected) inherit the root's space, which was checked already.
 */
export function isUnverifiableSpace(ref: Pick<PageRef, 'reason'>, spaceKey: string | undefined, policy: ManagedPolicy): boolean {
  return !!policy.blockedSpaceKeys?.length && ref.reason === 'linked' && !spaceKey;
}

/**
 * Drops pages in spaces blocked by the managed policy. Pages without a space key inherit the
 * export root's space when they come from the same tree (root/descendant/selected); linked pages
 * without one are dropped (see isUnverifiableSpace).
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
    } else if (isUnverifiableSpace(p, key, policy)) {
      errors.push({ pageId: p.id, title: p.title, message: UNVERIFIED_SPACE_MESSAGE, severity: 'skipped' });
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
      return 'Your Confluence session has expired or you are not signed in. Sign in to Confluence and try again.';
    case 403:
      return 'You do not have permission to view this page.';
    case 404:
      return 'Page not found (it may have been deleted or you lack access).';
    default:
      return 'The page could not be loaded.';
  }
}

/**
 * "This page" exports need no collection: the request already names the page (the fetch then
 * checks it exists and fills in its title and space).
 */
export function currentPageRef(request: ExportRequest): PageRef {
  const r = request.root;
  const ref: PageRef = {
    id: r.id,
    type: r.type,
    title: r.title ?? '',
    depth: 0,
    reason: 'root',
    url: contentUrl(request.site, { id: r.id, type: r.type, spaceKey: r.spaceKey }),
  };
  if (r.spaceKey) ref.spaceKey = r.spaceKey;
  if (r.spaceId) ref.spaceId = r.spaceId;
  return ref;
}

/** Page id behind a named destination: `p-{id}` (section) or `p{id}-…` (heading in that page). */
export function destinationPageId(name: string): string | undefined {
  return /^p-(.+)$/.exec(name)?.[1] ?? /^p([^-]+)-/.exec(name)?.[1];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ───────────────────────────── the runner ─────────────────────────────

export async function runJob(job: ExportJobState, deps: RunnerDeps): Promise<void> {
  const { signal, settings } = deps;
  const request = job.request;
  const options = request.options;
  const format = formatOf(options);
  let tabId: number | undefined;
  let keepTab = false;
  let session: RunnerPrintSession | undefined;

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
  /** Long worker operations run in the background (no message stays pending for minutes). */
  const workerOp = <O extends WorkerOp>(
    op: O,
    msg: Extract<SwToWorker, { type: 'worker/collect' | 'worker/fetch' | 'worker/convert' }>,
  ): Promise<WorkerOpResults[O]> => {
    if (tabId === undefined) return Promise.reject(new Error('The export tab is not open.'));
    return runWorkerOp(deps, { tabId, id: job.id, op, msg, signal, pingMs: deps.workerPingMs });
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
          progress: { done: msg.done, total: msg.total, current: msg.current, unit: 'page' },
        });
      } else if (job.status === 'collecting') {
        update({ throttled: false, progress: { ...job.progress, current: msg.current } });
      } else if (job.status === 'rendering' && format !== 'pdf' && msg.total > 0) {
        // Markdown: images being downloaded by the worker tab.
        update({
          throttled: false,
          message: `Downloading images ${msg.done}/${msg.total}`,
          progress: { done: msg.done, total: msg.total, current: msg.current, unit: 'step' },
        });
      }
    }
  });

  try {
    check();
    // ── 3. worker tab ──
    update({ status: 'collecting', message: 'Connecting to Confluence', progress: { done: 0, total: 0 } });
    const opening = deps.openWorkerTab(request.site, request.sourceTabId, signal);
    try {
      tabId = await abortable(opening, signal);
    } catch (e) {
      // Cancelled while the tab was still opening: whoever finishes opening it, it gets closed.
      if (isAbort(e, signal)) opening.then((id) => deps.closeTabQuietly(id), () => undefined);
      throw e;
    }
    check();

    // ── 4. collect (skipped when the preview supplied the page list, or for a single page) ──
    let pages = job.pages;
    if (!pages.length) {
      if (request.mode === 'current') {
        pages = [currentPageRef(request)];
      } else {
        update({ message: 'Collecting pages' });
        const res = await workerOp('collect', {
          type: 'worker/collect',
          jobId: job.id,
          request,
          // Enough to report the administrator's limit without collecting far beyond it.
          maxItems: deps.policy.maxPages ? deps.policy.maxPages + 1 : undefined,
        });
        pages = res.pages;
        if (res.warnings.length) job.warnings = [...(job.warnings ?? []), ...res.warnings];
      }
    }
    const filtered = applyPolicyToPages(pages, deps.policy, request.root.spaceKey);
    pages = filtered.pages;
    job.errors.push(...filtered.errors);
    const tooMany = maxPagesError(pages.length, deps.policy);
    if (tooMany) throw new Error(tooMany);
    if (!pages.length) {
      throw new Error(filtered.errors.length ? 'All pages are in spaces blocked by your administrator.' : 'There is nothing to export.');
    }
    update({ pages, pageCount: pages.length });
    deps.saveCheckpoint?.(job);
    check();

    // ── 6. fetch ──
    update({ status: 'fetching', message: 'Fetching pages', progress: { done: 0, total: pages.length, unit: 'page' } });
    // Live render prints real pages: PDF only.
    const liveRequested = format === 'pdf' && options.liveRender && !deps.policy.disableLiveRender;
    const { results } = await workerOp('fetch', {
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
      if (info?.ok) {
        // Refs built without a title or space (single-page exports) get them from Confluence.
        if (!ref.title && info.title) ref.title = info.title;
        if (!ref.spaceKey && info.spaceKey) ref.spaceKey = info.spaceKey;
      }
      const spaceKey = info?.spaceKey ?? ref.spaceKey;
      if (!info) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: 'The page could not be loaded.', severity: 'skipped' });
      } else if (!info.ok) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: friendlyFetchError(info), severity: 'skipped' });
      } else if (isBlockedSpace(spaceKey, deps.policy)) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: BLOCKED_MESSAGE, severity: 'skipped' });
      } else if (isUnverifiableSpace(ref, spaceKey, deps.policy)) {
        job.errors.push({ pageId: ref.id, title: ref.title, message: UNVERIFIED_SPACE_MESSAGE, severity: 'skipped' });
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
    // Only folders (no page, blog post, whiteboard, database or embed): nothing worth a PDF.
    if (included.every((p) => p.type === 'folder')) {
      throw new Error(
        request.mode === 'folder' ? 'This folder has no pages you can export.' : 'The selection has no pages you can export.',
      );
    }
    const includedIds = new Set(included.map((p) => p.id));
    const excludeIds = pages.filter((p) => !includedIds.has(p.id)).map((p) => p.id);
    update({ pages, progress: { done: pages.length, total: pages.length, unit: 'page' } });

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
        progress: { done: 0, total: liveCandidates.length, unit: 'page' },
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
                progress: { done, total: liveCandidates.length, current, unit: 'page' },
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

    const finish = (filename: string, downloadId: number, bytes: number, sheetCount?: number) => {
      const skipped = job.errors.filter((e) => e.severity === 'skipped').length;
      update({
        status: 'done',
        finishedAt: deps.now(),
        progress: { done: 1, total: 1, unit: 'step' },
        result: { filename, downloadId, bytes, pageCount, sheetCount },
        message: skipped ? `Saved ${filename} (${plural(skipped, 'page')} skipped)` : `Saved ${filename}`,
      });
    };

    // ── Markdown / plain text: convert in the worker tab, no printing ──
    if (format !== 'pdf') {
      const info = FORMATS[format];
      // One file per page needs pages: a selection of only whiteboards / databases / embeds (no
      // page of their own) is written as one combined file of links instead.
      const separate = options.separateFiles && includedContent.length > 0;
      // A single page in separate mode is one file, like a separate PDF: no cover, no contents file.
      const onePage = separate && includedContent.length === 1;
      const combinedName = buildFilename({ spaceKey, title: docTitle, date: exportedAt, ext: info.ext });
      update({ status: 'rendering', message: convertingMessage(format), progress: { done: 0, total: 1, unit: 'step' } });
      const converted = await workerOp('convert', {
        type: 'worker/convert',
        jobId: job.id,
        // Separate files: one per page (folders and other link-only items have no file of their own).
        pageIds: (separate ? includedContent : included).map((p) => p.id),
        allPages: pages,
        excludeIds,
        options,
        // Separate files: the cover and the TOC go into a `00-Contents` index file.
        cover: onePage ? null : cover,
        toc: onePage ? false : options.includeToc,
        separate,
        baseName: combinedName.replace(/\.[^.]+$/, ''),
        concurrency: settings.apiConcurrency,
      });
      check();
      const failed = converted.failedAssets;
      if (failed.length) {
        const n = failed.length;
        job.errors.push({
          pageId: '',
          title: 'Images',
          message:
            `${plural(n, 'image')} could not be downloaded (${failed[0].reason}${n > 1 ? ', …' : ''}); ` +
            `the Markdown keeps ${n === 1 ? 'its original link' : 'their original links'}.`,
          severity: 'degraded',
        });
      }
      const entries = converted.entries;
      if (!entries.length) throw new Error('Nothing could be converted.');
      const single = entries.length === 1 && entries[0].kind === 'document';
      update({
        status: 'merging',
        message: single ? 'Preparing the file' : 'Building the ZIP',
        progress: { done: 0, total: 1, unit: 'step' },
      });
      let data: Uint8Array[] = await collectOutput(
        entries,
        (index, offset) => worker({ type: 'worker/readOutput', jobId: job.id, index, offset }),
        signal,
      );
      check();
      let bytes: Uint8Array;
      let filename: string;
      let mime: string;
      if (single) {
        bytes = data[0];
        filename = separate
          ? buildFilename({ spaceKey, title: includedContent[0]?.title || docTitle, date: exportedAt, ext: info.ext })
          : combinedName;
        mime = info.mime;
      } else {
        bytes = await abortable(
          deps.zipFiles(
            entries.map((e, i) => ({ name: e.path, data: data[i], compress: isCompressible(e.path) })),
            signal,
          ),
          signal,
        );
        filename = buildFilename({ spaceKey, title: docTitle, date: exportedAt, ext: 'zip' });
        mime = 'application/zip';
      }
      data = [];
      update({ message: SAVING_MESSAGE });
      const downloadId = await abortable(deps.saveBytes(bytes, filename, mime, signal), signal);
      finish(filename, downloadId, bytes.length, undefined);
      return;
    }

    const params = deps.toPrintParams(options);
    const batches = chunk(included, settings.printBatchSize);
    // Chrome's footer numbers each print on its own and cannot skip the cover: with several
    // batches, inserted live pages or a cover, print without it and stamp "n / total" on the
    // final document instead (the cover unnumbered, numbering starting on the next sheet).
    const stampNumbers =
      options.pageNumbers && !options.separateFiles && (batches.length > 1 || livePdfs.size > 0 || !!cover);
    const batchParams: PrintParams = stampNumbers ? { ...params, displayHeaderFooter: false } : params;

    /** Debugger blocked: assemble everything into the worker tab and open the print dialog. */
    const fallbackToPrintDialog = async () => {
      await session?.close();
      session = undefined;
      update({ status: 'rendering', message: 'Opening the print dialog', progress: { done: 0, total: 1, unit: 'step' } });
      await worker({
        type: 'worker/assemble',
        jobId: job.id,
        site: request.site,
        pageIds: (options.separateFiles ? includedContent : included).map((p) => p.id),
        liveRenderIds: [],
        allPages: pages,
        excludeIds,
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
        progress: { done: 1, total: 1, unit: 'step' },
        message:
          "Chrome's debugger is not available (it may be blocked by your administrator or in use by DevTools or another extension), " +
          'so the system print dialog was opened instead. Choose "Save as PDF" as the destination.',
      });
    };

    const print = async (p: PrintParams = params): Promise<Uint8Array | null> => {
      session ??= deps.printSession(tabId!, signal);
      try {
        return await session.print(p);
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
          progress: { done: i, total: includedContent.length, current: ref.title, unit: 'page' },
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
        const finalized = await abortable(deps.finalizePdf(pdf, { metadata: metadataFor(ref.title, 1) }), signal);
        const stem = sanitizeFilenamePart(ref.title, 100) || ref.id;
        files.push({ name: `${String(i + 1).padStart(width, '0')}_${stem}.pdf`, data: finalized.bytes });
      }
      await session?.close();
      check();
      update({ status: 'merging', message: 'Building the ZIP', progress: { done: 0, total: 1, unit: 'step' } });
      pushImageError();
      livePdfs.clear();
      const date = exportedAt;
      if (files.length === 1) {
        const filename = buildFilename({ spaceKey, title: includedContent[0].title, date, ext: 'pdf' });
        update({ message: SAVING_MESSAGE });
        const downloadId = await abortable(deps.saveBytes(files[0].data, filename, 'application/pdf', signal), signal);
        finish(filename, downloadId, files[0].data.length, undefined);
      } else {
        const zip = await abortable(deps.zipFiles(files, signal), signal);
        files.length = 0;
        const filename = buildFilename({ spaceKey, title: docTitle, date, ext: 'zip' });
        update({ message: SAVING_MESSAGE });
        const downloadId = await abortable(deps.saveBytes(zip, filename, 'application/zip', signal), signal);
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
        progress: { done: b, total: batches.length, unit: 'step' },
      });
      const batch = batches[b];
      const asm = await worker({
        type: 'worker/assemble',
        jobId: job.id,
        site: request.site,
        pageIds: batch.map((p) => p.id),
        liveRenderIds: batch.filter((p) => livePdfs.has(p.id)).map((p) => p.id),
        allPages: pages,
        excludeIds,
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
    await session?.close();
    session = undefined;
    check();

    // ── 9. post-process (every step is cancellable; references are dropped as soon as possible) ──
    update({ status: 'merging', message: 'Building the PDF', progress: { done: 0, total: 1, unit: 'step' } });
    const batchOf = new Map<string, number>();
    batches.forEach((batch, i) => batch.forEach((p) => batchOf.set(p.id, i)));
    const owner = (name: string) => {
      const id = destinationPageId(name);
      return id === undefined ? undefined : batchOf.get(id);
    };
    let base: Uint8Array | undefined = parts.length > 1 ? (await abortable(deps.concatPdfs(parts, owner), signal)).bytes : parts[0];
    parts.length = 0;
    check();

    pushImageError();
    const finalized = await abortable(
      deps.finalizeExport(base!, {
        metadata: metadataFor(docTitle, pageCount),
        pages,
        excludeIds,
        live: livePdfs.size ? livePdfs : undefined,
        stampPageNumbers: stampNumbers ? { skipFirst: cover ? 1 : 0 } : undefined,
      }),
      signal,
    );
    base = undefined;
    livePdfs.clear();
    for (const id of finalized.unplacedLive) {
      const ref = included.find((p) => p.id === id);
      job.errors.push({
        pageId: id,
        title: ref?.title ?? id,
        message: 'The live-rendered version could not be placed in the PDF; only the page header is included.',
        severity: 'degraded',
      });
    }
    check();

    // ── 10. download ──
    const filename = buildFilename({ spaceKey, title: docTitle, date: exportedAt, ext: 'pdf' });
    update({ message: SAVING_MESSAGE });
    const downloadId = await abortable(deps.saveBytes(finalized.bytes, filename, 'application/pdf', signal), signal);
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
    if (session) await withTimeout(session.close(), WORKER_CLEANUP_TIMEOUT_MS);
    if (tabId !== undefined && !keepTab) {
      // After a cancel the worker already dropped its state; just close the tab quickly.
      if (!signal.aborted) {
        await withTimeout(deps.callWorker(tabId, { type: 'worker/dispose', jobId: job.id }), WORKER_CLEANUP_TIMEOUT_MS);
      }
      await deps.closeTabQuietly(tabId);
    }
  }
}
