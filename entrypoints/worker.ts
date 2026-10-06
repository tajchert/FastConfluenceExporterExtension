/**
 * Worker tab script (/worker.js), injected by the service worker into a background tab opened on
 * a same-origin Confluence JSON endpoint. It performs every Confluence API call (session cookies,
 * no CORS), keeps fetched page HTML in memory (it never leaves this tab) and assembles the print
 * document into this tab's DOM, which the service worker then prints.
 *
 * RPC server for `SwToWorker` (lib/messages.ts); reports progress with `WorkerToSw` messages.
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { waitForAssets } from '../lib/assemble/assets';
import { buildPrintDocument } from '../lib/assemble/document';
import { detectLiveRenderMacros } from '../lib/assemble/macros';
import { createClient, type ConfluenceClient, type ContentSummary, type PageBody } from '../lib/confluence/client';
import { collect } from '../lib/confluence/collect';
import { HttpError, getJson } from '../lib/confluence/http';
import { decodeTinyCode, isSameSite, parseConfluenceUrl } from '../lib/confluence/url';
import { LOGIN_REQUIRED_MESSAGE, SESSION_EXPIRED_MESSAGE } from '../lib/errors';
import type { ResolvedContent, SwToWorker, SwToWorkerResponses, WorkerOp, WorkerToSw } from '../lib/messages';
import { respond } from '../lib/rpc';
import type { ContentType, FetchedPageInfo, PageRef, SiteInfo, TreeNode } from '../lib/types';
import { isAbortError } from '../lib/util/abort';
import { mapPool } from '../lib/util/pool';

const INSTALLED_FLAG = '__cfpWorkerInstalled';
const PRODUCT_NAME = 'Fast PDF Export for Confluence';
const CONTENT_TYPES = new Set<ContentType>(['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed']);
const LINK_ONLY_TYPES = new Set<ContentType>(['folder', 'whiteboard', 'database', 'embed']);

/** Page bodies read while collecting (linked mode) are reused by the export's fetch. */
const BODY_CACHE_MAX_ENTRIES = 300;
const BODY_CACHE_MAX_CHARS = 40_000_000;
const BODY_CACHE_TTL_MS = 10 * 60_000;

interface JobState {
  site: SiteInfo;
  controller: AbortController;
  client: ConfluenceClient;
  refs: Map<string, PageRef>;
  bodies: Map<string, PageBody>;
  infos: Map<string, FetchedPageInfo>;
}

class LoginRequiredError extends Error {
  readonly code = 'LOGIN_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'LoginRequiredError';
  }
}

export default defineUnlistedScript(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;

  const jobs = new Map<string, JobState>();
  /** Clients for small requests that do not belong to a job (tree, resolve, space name). */
  const sharedClients = new Map<string, ConfluenceClient>();

  // ── bounded LRU of page bodies, shared by the preview's collection and the job's fetch ──
  const bodyCache = new Map<string, { body: PageBody; at: number; size: number }>();
  let bodyCacheChars = 0;
  const cacheGet = (key: string): PageBody | undefined => {
    const hit = bodyCache.get(key);
    if (!hit) return undefined;
    bodyCache.delete(key);
    if (Date.now() - hit.at > BODY_CACHE_TTL_MS) {
      bodyCacheChars -= hit.size;
      return undefined;
    }
    bodyCache.set(key, hit); // most recently used last
    return hit.body;
  };
  const cachePut = (key: string, body: PageBody) => {
    const size = body.html.length;
    if (size > BODY_CACHE_MAX_CHARS / 4) return;
    const old = bodyCache.get(key);
    if (old) {
      bodyCacheChars -= old.size;
      bodyCache.delete(key);
    }
    bodyCache.set(key, { body, at: Date.now(), size });
    bodyCacheChars += size;
    for (const [k, v] of bodyCache) {
      if (bodyCache.size <= BODY_CACHE_MAX_ENTRIES && bodyCacheChars <= BODY_CACHE_MAX_CHARS) break;
      bodyCache.delete(k);
      bodyCacheChars -= v.size;
    }
  };
  /** The client, with page bodies served from / stored in the tab's body cache. */
  const withBodyCache = (client: ConfluenceClient): ConfluenceClient => ({
    site: client.site,
    getContent: (id, type) => client.getContent(id, type),
    getChildren: (parent) => client.getChildren(parent),
    getDescendants: (parent, maxDepth, opts) => client.getDescendants(parent, maxDepth, opts),
    getSpace: (key) => client.getSpace(key),
    getSpaceRoots: (space) => client.getSpaceRoots(space),
    getPageBody: async (id, type, known) => {
      const key = `${client.site.baseUrl}|${id}`;
      const hit = cacheGet(key);
      if (hit) return hit;
      const body = await client.getPageBody(id, type, known);
      cachePut(key, body);
      return body;
    },
    getStorageBody: (id, type) => client.getStorageBody(id, type),
    findPageByTitle: (spaceKey, title, lookup) => client.findPageByTitle(spaceKey, title, lookup),
    getCurrentUser: () => client.getCurrentUser(),
  });

  const notify = (msg: WorkerToSw) => {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  };

  const sameOriginSite = (site: SiteInfo): SiteInfo => {
    // All calls must be same-origin: the tab sits on the Confluence origin.
    if (!site || site.origin !== location.origin) {
      throw new Error('This export tab belongs to a different Confluence site.');
    }
    return site;
  };

  const sharedClient = (site: SiteInfo): ConfluenceClient => {
    const key = `${site.baseUrl}|${site.flavour}`;
    let c = sharedClients.get(key);
    if (!c) {
      c = createClient(sameOriginSite(site));
      sharedClients.set(key, c);
    }
    return c;
  };

  const getJob = (jobId: string, site?: SiteInfo): JobState => {
    let job = jobs.get(jobId);
    if (!job) {
      if (!site) throw new Error('The export was reset. Please start it again.');
      const controller = new AbortController();
      const client = withBodyCache(
        createClient(sameOriginSite(site), {
          signal: controller.signal,
          onThrottle: (retryInMs) => notify({ type: 'worker/throttled', jobId, retryInMs }),
        }),
      );
      job = { site, controller, client, refs: new Map(), bodies: new Map(), infos: new Map() };
      jobs.set(jobId, job);
    }
    return job;
  };

  /** `keepBodies`: a finished preview collection, whose bodies the export will reuse. */
  const disposeJob = (jobId: string, keepBodies = false) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.controller.abort();
    jobs.delete(jobId);
    // The export is over (the tab closes next): cached bodies are not needed any more.
    if (!keepBodies && jobs.size === 0) {
      bodyCache.clear();
      bodyCacheChars = 0;
    }
  };

  const statusOf = (e: unknown): number | undefined =>
    e instanceof HttpError ? e.status : typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;

  const describeFetchError = (e: unknown): { error: string; httpStatus?: number } => {
    const status = statusOf(e);
    if (status === 401) return { error: SESSION_EXPIRED_MESSAGE, httpStatus: status };
    if (status === 403) return { error: 'You do not have permission to view this page.', httpStatus: status };
    if (status === 404) return { error: 'Page not found (it may have been deleted or you lack access).', httpStatus: status };
    const message = e instanceof Error ? e.message : String(e);
    return status ? { error: message, httpStatus: status } : { error: message };
  };

  /**
   * Is the Confluence session still valid? Asked once when a page answers 401 or the network
   * fails (an expired SSO session often shows up as a failed cross-origin redirect).
   */
  const sessionIsValid = async (site: SiteInfo, signal: AbortSignal): Promise<boolean> => {
    try {
      const u = await getJson<{ type?: string }>(`${site.baseUrl.replace(/\/+$/, '')}/rest/api/user/current`, {
        signal,
        maxRetries: 1,
      });
      return !!u && u.type !== 'anonymous';
    } catch (e) {
      if (isAbortError(e)) throw e;
      return false;
    }
  };

  const toTreeNode = (s: ContentSummary): TreeNode => ({
    id: s.id,
    type: s.type,
    title: s.title,
    hasChildren: s.hasChildren ?? (s.type === 'page' || s.type === 'folder'),
    position: s.position,
    url: s.url,
    spaceKey: s.spaceKey,
  });

  async function handleFetch(msg: Extract<SwToWorker, { type: 'worker/fetch' }>): Promise<{ results: FetchedPageInfo[] }> {
    const job = getJob(msg.jobId, msg.site);
    const { signal } = job.controller;
    const total = msg.pages.length;
    let done = 0;
    const detect = msg.liveRenderMacros.length > 0;
    /** One session check per fetch, shared by every page that fails with 401 / a network error. */
    let sessionCheck: Promise<boolean> | null = null;
    let loginError: LoginRequiredError | null = null;

    const results = await mapPool(
      msg.pages,
      Math.max(1, msg.concurrency || 1),
      async (ref): Promise<FetchedPageInfo> => {
        let info: FetchedPageInfo;
        try {
          if (LINK_ONLY_TYPES.has(ref.type)) {
            job.refs.set(ref.id, ref);
            info = { id: ref.id, ok: true, needsLiveRender: false, linkOnly: true, spaceKey: ref.spaceKey };
          } else {
            const body = await job.client.getPageBody(ref.id, ref.type, {
              breadcrumb: ref.breadcrumb?.length ? ref.breadcrumb : undefined,
            });
            let reasons: string[] = [];
            if (detect) {
              let storage: string | null = null;
              if (msg.needStorage) {
                try {
                  storage = await job.client.getStorageBody(ref.id, ref.type);
                } catch (e) {
                  if (isAbortError(e)) throw e;
                  storage = null; // detection falls back to export_view markers
                }
              }
              reasons = detectLiveRenderMacros(body.html, storage, msg.liveRenderMacros);
            }
            job.bodies.set(ref.id, body);
            job.refs.set(ref.id, {
              ...ref,
              title: ref.title || body.title,
              spaceKey: ref.spaceKey ?? body.spaceKey,
              breadcrumb: ref.breadcrumb?.length ? ref.breadcrumb : body.breadcrumb,
            });
            info = {
              id: ref.id,
              ok: true,
              title: body.title,
              version: body.version,
              lastModified: body.lastModified,
              authorDisplayName: body.authorDisplayName,
              needsLiveRender: reasons.length > 0,
              liveRenderReasons: reasons.length ? reasons : undefined,
              spaceKey: body.spaceKey ?? ref.spaceKey,
            };
          }
        } catch (e) {
          if (isAbortError(e) || signal.aborted) throw loginError ?? e;
          const status = statusOf(e);
          if (status === 401 || status === 0) {
            sessionCheck ??= sessionIsValid(job.site, signal);
            if (!(await sessionCheck)) {
              // Every remaining page would fail the same way: stop and ask the user to sign in.
              loginError ??= new LoginRequiredError(status === 401 ? SESSION_EXPIRED_MESSAGE : LOGIN_REQUIRED_MESSAGE);
              job.controller.abort();
              throw loginError;
            }
          }
          info = { id: ref.id, ok: false, needsLiveRender: false, ...describeFetchError(e) };
        }
        job.infos.set(ref.id, info);
        done++;
        notify({ type: 'worker/progress', jobId: msg.jobId, done, total, current: ref.title });
        return info;
      },
      signal,
    ).catch((e: unknown) => {
      throw loginError ?? e;
    });
    return { results };
  }

  async function handleAssemble(
    msg: Extract<SwToWorker, { type: 'worker/assemble' }>,
  ): Promise<SwToWorkerResponses['worker/assemble']> {
    const job = getJob(msg.jobId);
    const live = new Set(msg.liveRenderIds);
    const allById = new Map(msg.allPages.map((p) => [p.id, p]));
    const pages: { ref: PageRef; body?: PageBody; info?: FetchedPageInfo; live?: boolean }[] = [];
    for (const id of msg.pageIds) {
      const ref = job.refs.get(id) ?? allById.get(id);
      if (!ref) continue;
      const info = job.infos.get(id);
      if (info && !info.ok) continue;
      const body = job.bodies.get(id);
      const linkOnly = LINK_ONLY_TYPES.has(ref.type);
      if (!body && !linkOnly) continue; // not fetched: never emit an empty section
      pages.push({ ref, body, info, live: live.has(id) || undefined });
    }
    // Prefer refs enriched during fetch (breadcrumbs) for the TOC as well.
    const allPages = msg.allPages.map((p) => job.refs.get(p.id) ?? p);
    buildPrintDocument(document, {
      pages,
      allPages,
      excludeIds: msg.excludeIds,
      site: job.site,
      options: msg.options,
      cover: msg.cover,
      toc: msg.toc,
      generatedBy: `${PRODUCT_NAME} v${chrome.runtime.getManifest().version}`,
    });
    const { imageFailures } = await waitForAssets(document);
    return { imageFailures, pageIds: pages.map((p) => p.ref.id) };
  }

  async function handleResolve(msg: Extract<SwToWorker, { type: 'worker/resolve' }>): Promise<ResolvedContent | null> {
    const site = sameOriginSite(msg.site);
    if (!isSameSite(msg.url, site)) return null;
    const client = sharedClient(site);
    const parsed = parseConfluenceUrl(msg.url, site.contextPath);
    const summarize = (s: ContentSummary): ResolvedContent => ({
      id: s.id,
      type: s.type,
      title: s.title,
      spaceKey: s.spaceKey,
      spaceId: s.spaceId,
      url: s.url,
    });

    let id = parsed.id;
    let type: ContentType | undefined = CONTENT_TYPES.has(parsed.kind as ContentType) ? (parsed.kind as ContentType) : undefined;
    if (parsed.kind === 'tiny' && parsed.tinyCode) {
      id = decodeTinyCode(parsed.tinyCode) ?? undefined;
      type = undefined;
      if (!id) {
        // Same-origin GET; the redirect target carries the content id.
        const res = await fetch(msg.url, { credentials: 'include', redirect: 'follow' });
        const target = parseConfluenceUrl(res.url, site.contextPath);
        id = target.id;
        if (CONTENT_TYPES.has(target.kind as ContentType)) type = target.kind as ContentType;
      }
    }
    if (id) return summarize(await client.getContent(id, type));
    if (parsed.title && parsed.spaceKey) {
      const found = await client.findPageByTitle(
        parsed.spaceKey,
        parsed.title,
        parsed.kind === 'blogpost' ? { type: 'blogpost', postingDay: parsed.postingDay } : undefined,
      );
      return found ? summarize(found) : null;
    }
    if (parsed.kind === 'space' && parsed.spaceKey) {
      const space = await client.getSpace(parsed.spaceKey);
      if (space.homepageId) return summarize(await client.getContent(space.homepageId, 'page'));
    }
    return null;
  }

  /**
   * Runs a long operation in the background and reports its outcome with `worker/done`, so the
   * service worker never waits minutes on one message (Chrome stops a service worker whose single
   * event or API call takes longer than 5 minutes).
   */
  const runInBackground = <T>(jobId: string, op: WorkerOp, run: () => Promise<T>, after?: () => void): { started: true } => {
    void run().then(
      (result) => notify({ type: 'worker/done', jobId, op, result }),
      (e: unknown) => {
        const err = e as { message?: unknown; code?: unknown; name?: unknown } | null;
        notify({
          type: 'worker/done',
          jobId,
          op,
          error: typeof err?.message === 'string' ? err.message : String(e),
          code: typeof err?.code === 'string' ? err.code : err?.name === 'AbortError' ? 'ABORTED' : undefined,
        });
      },
    ).finally(after);
    return { started: true };
  };

  async function handle(msg: SwToWorker): Promise<unknown> {
    switch (msg.type) {
      case 'worker/ping':
        return { ready: true };
      case 'worker/collect': {
        const site = sameOriginSite(msg.request.site);
        const job = getJob(msg.jobId, site);
        const jobId = msg.jobId;
        return runInBackground(
          jobId,
          'collect',
          () =>
            collect(job.client, msg.request, {
              signal: job.controller.signal,
              includeArchived: msg.request.options?.includeArchived,
              maxItems: msg.maxItems,
              onProgress: (current) => notify({ type: 'worker/progress', jobId, done: 0, total: 0, current }),
            }),
          msg.transient ? () => disposeJob(jobId, true) : undefined,
        );
      }
      case 'worker/children': {
        const client = sharedClient(msg.site);
        const items = msg.parent
          ? await client.getChildren(msg.parent)
          : await client.getSpaceRoots({ key: msg.spaceKey, id: msg.spaceId });
        return items.map(toTreeNode);
      }
      case 'worker/fetch':
        getJob(msg.jobId, msg.site);
        return runInBackground(msg.jobId, 'fetch', () => handleFetch(msg));
      case 'worker/assemble':
        return handleAssemble(msg);
      case 'worker/space': {
        try {
          const s = await sharedClient(msg.site).getSpace(msg.spaceKey);
          return { key: s.key, name: s.name, homepageId: s.homepageId };
        } catch {
          return null;
        }
      }
      case 'worker/resolve':
        return handleResolve(msg);
      case 'worker/cancel':
        jobs.get(msg.jobId)?.controller.abort();
        return undefined;
      case 'worker/dispose':
        disposeJob(msg.jobId);
        return undefined;
      default:
        throw new Error(`Unknown request: ${(msg as { type?: string }).type}`);
    }
  }

  const REQUEST_TYPES = new Set<string>([
    'worker/ping',
    'worker/collect',
    'worker/children',
    'worker/fetch',
    'worker/assemble',
    'worker/space',
    'worker/resolve',
    'worker/cancel',
    'worker/dispose',
  ]);

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    // Only the extension's own service worker talks to this script.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    const type = (msg as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !REQUEST_TYPES.has(type)) return false;
    return respond(sendResponse, () => handle(msg as SwToWorker));
  });

  notify({ type: 'worker/ready' });
});
