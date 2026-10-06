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
import { HttpError } from '../lib/confluence/http';
import { decodeTinyCode, isSameSite, parseConfluenceUrl } from '../lib/confluence/url';
import type { ResolvedContent, SwToWorker, SwToWorkerResponses, WorkerToSw } from '../lib/messages';
import { respond } from '../lib/rpc';
import type { ContentType, FetchedPageInfo, PageRef, SiteInfo, TreeNode } from '../lib/types';
import { isAbortError } from '../lib/util/abort';
import { mapPool } from '../lib/util/pool';

const INSTALLED_FLAG = '__cfpWorkerInstalled';
const PRODUCT_NAME = 'Fast PDF Export for Confluence';
const CONTENT_TYPES = new Set<ContentType>(['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed']);
const LINK_ONLY_TYPES = new Set<ContentType>(['folder', 'whiteboard', 'database', 'embed']);

interface JobState {
  site: SiteInfo;
  controller: AbortController;
  client: ConfluenceClient;
  refs: Map<string, PageRef>;
  bodies: Map<string, PageBody>;
  infos: Map<string, FetchedPageInfo>;
}

export default defineUnlistedScript(() => {
  const w = window as unknown as Record<string, unknown>;
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;

  const jobs = new Map<string, JobState>();
  /** Clients for requests that do not belong to a job (preview collect, tree, resolve). */
  const sharedClients = new Map<string, ConfluenceClient>();

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
      const client = createClient(sameOriginSite(site), {
        signal: controller.signal,
        onThrottle: (retryInMs) => notify({ type: 'worker/throttled', jobId, retryInMs }),
      });
      job = { site, controller, client, refs: new Map(), bodies: new Map(), infos: new Map() };
      jobs.set(jobId, job);
    }
    return job;
  };

  const disposeJob = (jobId: string) => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.controller.abort();
    jobs.delete(jobId);
  };

  const describeFetchError = (e: unknown): { error: string; httpStatus?: number } => {
    const status =
      e instanceof HttpError ? e.status : typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
    if (status === 401 || status === 403) return { error: 'You do not have permission to view this page.', httpStatus: status };
    if (status === 404) return { error: 'Page not found (it may have been deleted or you lack access).', httpStatus: status };
    const message = e instanceof Error ? e.message : String(e);
    return status ? { error: message, httpStatus: status } : { error: message };
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

  async function handleFetch(msg: Extract<SwToWorker, { type: 'worker/fetch' }>): Promise<SwToWorkerResponses['worker/fetch']> {
    const job = getJob(msg.jobId, msg.site);
    const { signal } = job.controller;
    const total = msg.pages.length;
    let done = 0;
    const detect = msg.liveRenderMacros.length > 0;

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
            const body = await job.client.getPageBody(ref.id, ref.type);
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
              version: body.version,
              lastModified: body.lastModified,
              authorDisplayName: body.authorDisplayName,
              needsLiveRender: reasons.length > 0,
              liveRenderReasons: reasons.length ? reasons : undefined,
              spaceKey: body.spaceKey ?? ref.spaceKey,
            };
          }
        } catch (e) {
          if (isAbortError(e) || signal.aborted) throw e;
          info = { id: ref.id, ok: false, needsLiveRender: false, ...describeFetchError(e) };
        }
        job.infos.set(ref.id, info);
        done++;
        notify({ type: 'worker/progress', jobId: msg.jobId, done, total, current: ref.title });
        return info;
      },
      signal,
    );
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
      const found = await client.findPageByTitle(parsed.spaceKey, parsed.title);
      return found ? summarize(found) : null;
    }
    if (parsed.kind === 'space' && parsed.spaceKey) {
      const space = await client.getSpace(parsed.spaceKey);
      if (space.homepageId) return summarize(await client.getContent(space.homepageId, 'page'));
    }
    return null;
  }

  async function handle(msg: SwToWorker): Promise<unknown> {
    switch (msg.type) {
      case 'worker/ping':
        return { ready: true };
      case 'worker/collect': {
        const site = sameOriginSite(msg.request.site);
        const job = msg.jobId ? getJob(msg.jobId, site) : undefined;
        const client = job?.client ?? sharedClient(site);
        const jobId = msg.jobId;
        return collect(client, msg.request, {
          signal: job?.controller.signal,
          includeArchived: msg.request.options?.includeArchived,
          onProgress: jobId
            ? (current) => notify({ type: 'worker/progress', jobId, done: 0, total: 0, current })
            : undefined,
        });
      }
      case 'worker/children': {
        const client = sharedClient(msg.site);
        const items = msg.parent
          ? await client.getChildren(msg.parent)
          : await client.getSpaceRoots({ key: msg.spaceKey, id: msg.spaceId });
        return items.map(toTreeNode);
      }
      case 'worker/fetch':
        return handleFetch(msg);
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
