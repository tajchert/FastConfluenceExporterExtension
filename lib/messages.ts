/**
 * Message protocol between execution contexts.
 *
 *  ┌──────────┐  UiToSw   ┌────────────────┐  SwToWorker (tabs.sendMessage)  ┌──────────────────┐
 *  │ popup /  │ ───────▶ │ service worker │ ──────────────────────────────▶ │ worker tab       │
 *  │ preview /│ ◀─────── │ (orchestrator) │ ◀────────────────────────────── │ (Confluence      │
 *  │ options  │ SwBroad- │                │  WorkerToSw (runtime.sendMsg)   │  origin, JSON    │
 *  └──────────┘ cast     └────────────────┘                                 │  URL, isolated)  │
 *                              │  ▲                                          └──────────────────┘
 *                  Offscreen*  ▼  │                 LiveToSw / SwToLive
 *                        ┌───────────┐            ┌──────────────────────┐
 *                        │ offscreen │            │ live-render tabs     │
 *                        │ (blob URL)│            │ (real page URLs)     │
 *                        └───────────┘            └──────────────────────┘
 *
 * All request messages are answered through the `sendResponse` callback with
 * `RpcResult<T>` ({ ok: true, value } | { ok: false, error }). Listeners that answer
 * asynchronously must `return true`. Use `lib/rpc.ts` helpers rather than raw APIs.
 */
import type {
  ContentType,
  ExportJobState,
  ExportOptions,
  ExportRequest,
  FetchedPageInfo,
  PageContext,
  PageRef,
  SiteInfo,
  TreeNode,
} from './types';

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

// ───────────────────────────── UI (popup / preview / options) → service worker ─────────────

export type UiToSw =
  /** Resolve the page list for a request without exporting (preview, FR-7). */
  | { type: 'collect'; request: ExportRequest }
  /** Lazy tree for the manual picker (FR-6). parentId omitted = space roots. */
  | {
      type: 'tree/children';
      site: SiteInfo;
      spaceKey: string;
      spaceId?: string;
      parent?: { id: string; type: TreeNode['type'] };
    }
  /**
   * Start an export. `pages` = the (possibly pruned) list from the preview. When omitted
   * (popup "This page" / shortcut / context menu) the SW collects itself and skips the preview.
   */
  | { type: 'job/start'; request: ExportRequest; pages?: PageRef[] }
  | { type: 'job/cancel'; jobId: string }
  | { type: 'job/get'; jobId: string }
  /** Most recent jobs (newest first), for the popup "last export" line. */
  | { type: 'job/list' }
  /** Open the preview tab for a multi-page request (the popup closes on blur). */
  | { type: 'preview/open'; request: ExportRequest };

export interface UiToSwResponses {
  collect: { pages: PageRef[]; warnings: string[] };
  'tree/children': TreeNode[];
  'job/start': { jobId: string };
  'job/cancel': void;
  'job/get': ExportJobState | null;
  'job/list': ExportJobState[];
  'preview/open': { tabId: number };
}

/** Broadcast from the SW to every extension page (runtime.sendMessage, no response). */
export type SwBroadcast = { type: 'job/update'; job: ExportJobState };

// ───────────────────────────── service worker → worker tab (tabs.sendMessage) ─────────────

export type SwToWorker =
  | { type: 'worker/ping' }
  /** Resolve the page set for a request. Runs the collector (lib/confluence/collect.ts). */
  | { type: 'worker/collect'; jobId?: string; request: ExportRequest }
  | {
      type: 'worker/children';
      site: SiteInfo;
      spaceKey: string;
      spaceId?: string;
      parent?: { id: string; type: TreeNode['type'] };
    }
  /**
   * Fetch export_view bodies + metadata for the given pages (pool, retry, 429 back-off) and keep
   * them in worker memory keyed by page id. Progress is reported with `worker/progress`.
   */
  | {
      type: 'worker/fetch';
      jobId: string;
      site: SiteInfo;
      pages: PageRef[];
      liveRenderMacros: string[];
      concurrency: number;
      /** Also fetch storage format for live-render detection (only when live render is on). */
      needStorage?: boolean;
    }
  /**
   * Replace the worker tab's document with the assembled print document for `pageIds`
   * (in that order), then wait for images and fonts. `liveRenderIds` are emitted as a header-only
   * section whose content is a single `.cf-live-slot` marker (pages printed by live render later).
   */
  | {
      type: 'worker/assemble';
      jobId: string;
      site: SiteInfo;
      pageIds: string[];
      liveRenderIds: string[];
      allPages: PageRef[]; // the full export, for link rewriting (#p-{id}) and TOC
      options: ExportOptions;
      cover: CoverInfo | null; // null = no cover in this batch
      toc: boolean;
    }
  /** Space name for the cover / filename of 'space' exports. */
  | { type: 'worker/space'; site: SiteInfo; spaceKey: string }
  /**
   * Resolve any Confluence content URL (incl. tiny links and DC `/display/KEY/Title`) to its
   * content id. Used by the context menu. Null when the URL is not a resolvable content URL.
   */
  | { type: 'worker/resolve'; site: SiteInfo; url: string }
  | { type: 'worker/cancel'; jobId: string }
  /** Drop cached bodies for a job. */
  | { type: 'worker/dispose'; jobId: string };

export interface CoverInfo {
  title: string;
  sourceUrl: string;
  spaceKey?: string;
  exportedAt: string; // ISO
  exportedBy?: string;
  pageCount: number;
  siteTitle?: string;
}

export interface SwToWorkerResponses {
  'worker/ping': { ready: true };
  'worker/collect': { pages: PageRef[]; warnings: string[] };
  'worker/children': TreeNode[];
  'worker/fetch': { results: FetchedPageInfo[] };
  'worker/assemble': {
    /** Number of images that failed to load and were replaced by placeholders. */
    imageFailures: number;
    /** Ids of pages that ended up in the document, in order. */
    pageIds: string[];
  };
  'worker/space': { key: string; name: string; homepageId?: string } | null;
  'worker/resolve': ResolvedContent | null;
  'worker/cancel': void;
  'worker/dispose': void;
}

export interface ResolvedContent {
  id: string;
  type: ContentType;
  title: string;
  spaceKey?: string;
  spaceId?: string;
  url: string;
}

/** Worker tab → service worker progress notifications (runtime.sendMessage, no response). */
export type WorkerToSw =
  | { type: 'worker/progress'; jobId: string; done: number; total: number; current?: string }
  | { type: 'worker/throttled'; jobId: string; retryInMs: number }
  | { type: 'worker/ready' };

// ───────────────────────────── live render (FR-10) ─────────────────────────────────────────

/** SW → live-render content script (lib/render/liveContent.ts injected into the real page). */
export type SwToLive = { type: 'live/prepare'; timeoutMs: number; customCss: string };
export interface SwToLiveResponses {
  'live/prepare': { rendered: boolean; waitedMs: number; missing: string[] };
}

// ───────────────────────────── offscreen document ──────────────────────────────────────────

/**
 * The service worker cannot create blob: URLs, so the offscreen document turns PDF/ZIP bytes into
 * a blob URL for chrome.downloads. Bytes are transferred in base64 chunks (<= 8 MiB each).
 */
export type SwToOffscreen =
  | { target: 'offscreen'; type: 'blob/begin'; id: string; mime: string }
  | { target: 'offscreen'; type: 'blob/chunk'; id: string; base64: string }
  | { target: 'offscreen'; type: 'blob/end'; id: string }
  | { target: 'offscreen'; type: 'blob/revoke'; url: string };

export interface SwToOffscreenResponses {
  'blob/begin': void;
  'blob/chunk': void;
  'blob/end': { url: string };
  'blob/revoke': void;
}

/** Probe result injected into the active tab by the popup (no host permission needed: activeTab). */
export type ProbeResult = { isConfluence: false; url: string } | ({ isConfluence: true } & PageContext);
