/**
 * Shared domain types. Every execution context (popup, preview, options, service worker,
 * worker tab content script, live-render content script, offscreen document) imports these.
 * Keep this file free of runtime code other than constants so it can be imported anywhere.
 */

/** Confluence Cloud (*.atlassian.net or a Cloud custom domain) vs Data Center / Server. */
export type Flavour = 'cloud' | 'server';

export interface SiteInfo {
  /** e.g. `https://acme.atlassian.net` or `https://confluence.acme.corp` */
  origin: string;
  /**
   * Absolute Confluence base URL without trailing slash.
   * Cloud: `https://acme.atlassian.net/wiki`. Server/DC: `https://confluence.acme.corp` or
   * `https://intranet.acme.corp/confluence` (from the `ajs-context-path` meta).
   */
  baseUrl: string;
  /** '' or e.g. '/wiki', '/confluence'. baseUrl === origin + contextPath. */
  contextPath: string;
  flavour: Flavour;
  siteTitle?: string;
}

export type ContentType = 'page' | 'blogpost' | 'folder' | 'whiteboard' | 'database' | 'embed';

/** What the active tab is showing. Produced by the popup's probe (lib/confluence/detect.ts). */
export interface PageContext {
  site: SiteInfo;
  kind: ContentType | 'space' | 'unknown';
  /** Content id (page/folder/...). For kind 'space' this is the space homepage id when known. */
  id?: string;
  spaceKey?: string;
  spaceId?: string;
  title?: string;
  /** ISO date */
  lastUpdated?: string;
  /** Display name of the logged-in user (cover page "exported by"). */
  userDisplayName?: string;
  /** The tab URL we probed. */
  url: string;
}

export interface PageRef {
  id: string;
  type: ContentType;
  title: string;
  spaceKey?: string;
  spaceId?: string;
  parentId?: string;
  /** Depth relative to the export root (root = 0), used for TOC indentation and bookmarks. */
  depth: number;
  /** Canonical absolute URL to open the content in Confluence. */
  url: string;
  reason: 'root' | 'descendant' | 'linked' | 'selected';
  /** Ancestor titles (root of space first). Filled during fetch if not known at collect time. */
  breadcrumb?: string[];
  /** Sidebar sort key within the parent (childPosition / position). */
  position?: number;
  status?: string; // 'current' | 'archived' | 'draft' ...
}

/** Per-page result of the fetch phase. The HTML itself never leaves the worker tab. */
export interface FetchedPageInfo {
  id: string;
  ok: boolean;
  error?: string;
  /** HTTP status when the failure came from Confluence (403/404 => skipped for permissions). */
  httpStatus?: number;
  version?: number;
  lastModified?: string;
  authorDisplayName?: string;
  /** True when macro detection found client-rendered content (draw.io, Gliffy, charts...). */
  needsLiveRender: boolean;
  /** Names of detected client-rendered macros, for the UI. */
  liveRenderReasons?: string[];
  /** Content types that are exported as link-only TOC entries (whiteboards, databases, embeds). */
  linkOnly?: boolean;
}

export type PaperSize = 'A4' | 'Letter' | 'Legal' | 'A3';
export type Orientation = 'portrait' | 'landscape';

export interface ExportOptions {
  paperSize: PaperSize;
  orientation: Orientation;
  /** Page margins in millimetres. */
  marginsMm: { top: number; right: number; bottom: number; left: number };
  includeCover: boolean;
  includeToc: boolean;
  /** Per-page header block: breadcrumb, last-updated, link to original. */
  includePageMeta: boolean;
  includeComments: boolean;
  pageNumbers: boolean;
  /** FR-10: print client-rendered pages from the real Confluence UI. */
  liveRender: boolean;
  /** FR-11: one PDF per page bundled in a ZIP instead of one combined PDF. */
  separateFiles: boolean;
  includeArchived: boolean;
  /** Shrink very wide tables to fit the sheet. */
  shrinkWideTables: boolean;
  /** Extra CSS appended after the built-in print stylesheet (branding). */
  customCss: string;
}

export interface Settings {
  defaults: ExportOptions;
  /** Concurrent Confluence API requests. */
  apiConcurrency: number;
  /** Concurrent live-render tabs. */
  liveRenderConcurrency: number;
  /** Macro names / substrings that trigger live render (FR-10, configurable). */
  liveRenderMacros: string[];
  /** Pages per printToPDF batch for very large exports (keeps memory bounded). */
  printBatchSize: number;
  /** Warn above this many pages (FR-16). */
  warnPageCount: number;
  /** Require explicit confirmation above this many pages (FR-16). */
  confirmPageCount: number;
  /** Show a system notification when an export finishes. */
  notifyOnComplete: boolean;
}

/** Enterprise policy (chrome.storage.managed), see public/managed_schema.json. */
export interface ManagedPolicy {
  blockedSpaceKeys?: string[];
  disableLiveRender?: boolean;
  defaultOptions?: Partial<ExportOptions>;
  maxPages?: number;
}

export type ExportMode = 'current' | 'subtree' | 'folder' | 'linked' | 'selection' | 'space';

export interface ExportRequest {
  site: SiteInfo;
  mode: ExportMode;
  /** The content the export starts from (current page / folder / space home). */
  root: { id: string; type: ContentType; title?: string; spaceKey?: string; spaceId?: string };
  /** subtree/folder: max depth below root ('all' = unlimited). */
  depth?: number | 'all';
  /** linked: how many link hops to follow (1 or 2). */
  linkDepth?: 1 | 2;
  /** selection: explicit content ids; output order is page-tree order. */
  selectedIds?: string[];
  options: ExportOptions;
  /** Tab the export was started from (used only to place the worker tab next to it). */
  sourceTabId?: number;
  /** Display name for the cover page and PDF Author metadata. */
  userDisplayName?: string;
}

export type JobStatus =
  | 'collecting'
  | 'fetching'
  | 'rendering'
  | 'merging'
  | 'done'
  | 'cancelled'
  | 'error';

export interface JobError {
  pageId: string;
  title: string;
  message: string;
  /** 'skipped' = permission/not found, page left out; 'degraded' = included with placeholders. */
  severity: 'skipped' | 'degraded' | 'fatal';
}

/** Serializable job state. Persisted in chrome.storage.session under `job:{id}`. */
export interface ExportJobState {
  id: string;
  request: ExportRequest;
  pages: PageRef[];
  status: JobStatus;
  /** Human-readable phase description, e.g. "Fetching pages", "Throttled by Confluence, retrying…" */
  message?: string;
  progress: { done: number; total: number; current?: string };
  errors: JobError[];
  throttled?: boolean;
  createdAt: number;
  finishedAt?: number;
  result?: { filename: string; downloadId?: number; bytes: number; pageCount: number; sheetCount?: number };
}

/** Lazy tree node for the manual selection picker (FR-6). */
export interface TreeNode {
  id: string;
  type: ContentType;
  title: string;
  hasChildren: boolean;
  position?: number;
  url: string;
  spaceKey?: string;
}

export const DEFAULT_OPTIONS: ExportOptions = {
  paperSize: 'A4',
  orientation: 'portrait',
  marginsMm: { top: 18, right: 15, bottom: 18, left: 15 },
  includeCover: true,
  includeToc: true,
  includePageMeta: true,
  includeComments: false,
  pageNumbers: true,
  liveRender: false,
  separateFiles: false,
  includeArchived: false,
  shrinkWideTables: true,
  customCss: '',
};

export const DEFAULT_SETTINGS: Settings = {
  defaults: DEFAULT_OPTIONS,
  apiConcurrency: 5,
  liveRenderConcurrency: 3,
  liveRenderMacros: [
    'drawio',
    'inc-drawio',
    'gliffy',
    'lucidchart',
    'lucid',
    'roadmap',
    'chart',
    'jira-chart',
    'mermaid',
    'plantuml',
    'miro',
    'figma',
  ],
  printBatchSize: 150,
  warnPageCount: 150,
  confirmPageCount: 500,
  notifyOnComplete: true,
};
