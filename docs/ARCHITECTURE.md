# Architecture & module contracts

Source of truth for how the extension is put together. The product spec is
`confluence-pdf-exporter-spec.md` (written for one company's instance); this implementation
is **generic** (any Confluence Cloud site incl. custom domains, plus Data Center / Server via the
v1 REST API) and **publishable** on the Chrome Web Store (no hard-coded hosts, runtime
per-origin permission grants, privacy policy, no remote code).

Stack: TypeScript, WXT 0.21 (MV3), Preact, pdf-lib, DOMPurify, fflate, Vitest (+happy-dom),
Playwright (E2E against a mock Confluence). Use the `chrome.*` API (typed by `@types/chrome`),
not `browser.*`.

## 1. Spike findings (verified on a real Confluence Cloud site, 2026-10-06)

- `GET {base}/api/v2/pages/{id}?body-format=export_view` works same-origin with session cookies.
  Response keys: `id, title, status, spaceId, parentId, parentType, position, authorId, ownerId,
  createdAt, version{number, createdAt, authorId, message}, body.export_view{value, representation},
  _links{base, webui, tinyui, editui, edituiv2}`. **No space key, no author display name** in v2 →
  map `spaceId → key` via `GET /api/v2/spaces/{id}` (cache it) and author names via
  `GET {base}/rest/api/user?accountId=…` (cache, optional; failures ignored).
- v1 also works on Cloud: `GET {base}/rest/api/content/{id}?expand=body.export_view,version,space,ancestors`
  (keys: `id,type,status,title,space,version,ancestors,body,_links`). DC/Server only has v1.
- `export_view` HTML characteristics:
  - Images are **absolute same-origin** URLs: `https://site/wiki/download/attachments/{pageId}/{file}?version=…&api=v2`
    plus icons like `/wiki/images/icons/grey_arrow_down.png`. They load with cookies in a
    same-origin tab. (Atlassian Media URLs may still appear on some sites → handle generically:
    any `<img>` that fails gets a placeholder.)
  - Links to other pages: `<a href="https://site/wiki/spaces/KEY/pages/{id}/Slug" data-linked-resource-id="{id}" data-linked-resource-type="page">`.
    → **Linked-pages detection can use export_view directly** (`data-linked-resource-id` +
    URL parsing). Storage format `<ri:page ri:content-title="…">` often has **no space key**
    (same space) — only needed as fallback.
  - Same-page anchors: `href="#PageTitle-Heading"` with matching `id` on headings → ids collide
    across pages in a combined doc → **prefix ids and same-page hrefs per page** (`p{pageId}-…`).
  - User mentions: `a.confluence-userlink.user-mention` → keep as text with link.
  - Jira macro renders as a static table (`table.aui` with `td.jira-macro-table-underline-pdfexport`)
    with links to `/browse/KEY-1`. Keep it (it is static).
  - `iframe` macro renders a real `<iframe src=…>` → replace with placeholder + link (FR-9).
  - Expand macro: `.expand-container > .expand-control + .expand-content` → force open, hide control.
  - Classes seen: `confluence-information-macro(-information|-note|-warning|-tip)`, `-icon`, `-body`,
    `panel`, `panelContent`, `table-wrap`, `confluenceTable`, `confluenceTh`, `confluenceTd`,
    `contentLayout2`, `columnLayout`, `cell`, `innerCell`, `two-equal`, `fixed-width`,
    `toc-macro`, `toc-indentation`, `external-link`, `confluence-embedded-file-wrapper`,
    `confluence-embedded-image`, `image-center(-wrapper)`, `confluence-embedded-manual-size`,
    `emoticon`, `emoticon-*`, `inline-task-list`, `inline-comment-marker`, `aui-icon`,
    `aui-iconfont-*`, `status-macro aui-lozenge*` (status), `syntaxhighlighter-pre` (code).
  - `ac:link` cards: `a[data-card-appearance="inline|block|embed"]`.
- `GET /api/v2/pages/{id}/direct-children` → items `{id, status, title, type, childPosition}`
  (type may be page/folder/whiteboard/database/embed). Cursor in `_links.next` (relative URL
  starting with `/wiki/api/v2/...` — resolve against `origin`).
- `GET /api/v2/pages/{id}/descendants?depth=N` → items `{id, status, title, type, parentId, depth, childPosition, lastModified}`.
  Max `depth` is 5 (API limit) → recurse from depth-5 nodes for deeper trees. Order is not
  guaranteed to be tree order → **rebuild tree from parentId and sort siblings by childPosition**
  (then DFS pre-order).
- Folders: `GET /api/v2/folders/{id}` (`id,type,parentId,title,parentType,position,spaceId,…`),
  `/folders/{id}/direct-children`, `/folders/{id}/descendants` — same item shape as pages.
- Similarly `/api/v2/whiteboards/{id}`, `/databases/{id}`, `/embeds/{id}` exist (link-only).
- `GET /api/v2/spaces?keys=KEY` → `{id,key,name,type,homepageId,…}`; `/api/v2/spaces/{id}/pages?depth=root`.
- CQL search works: `GET {base}/rest/api/search?cql=…` (`results[].content{id,type,title,…}`).
- Tiny links `/x/{code}` decode offline: base64url-decode the code (pad with `=`, `-`→`+`,
  `_`→`/`), read bytes **little-endian** as an integer → content id (`phDOEg` → 315494566, verified).
  Fallback: `fetch(url, {redirect:'follow'})` and parse `response.url`.
- Page DOM has `<meta name="ajs-…">`: `ajs-base-url`, `ajs-context-path` (`/wiki` on Cloud),
  `ajs-site-title`, `ajs-cloud-id` (Cloud only), `ajs-current-user-fullname`, `ajs-remote-user`,
  `ajs-version-number`, `ajs-confluence-flavour`. DC pages additionally expose `ajs-page-id`,
  `ajs-space-key`, `ajs-page-title`, `ajs-content-type` (Cloud SPA may not — parse the URL first).
- Page HTML has a strict script CSP but **no `img-src`/`style-src`** restrictions. JSON API
  responses have **no CSP at all** → the worker/render tab is opened on a JSON endpoint
  (`{base}/rest/api/space?limit=1`, works on Cloud and DC): same-origin, no Confluence app JS,
  cookies flow to images. The worker content script then replaces the document.
- `GET {base}/rest/api/user/current` → `{displayName, publicName, accountId, …}` (Cloud);
  DC returns `{displayName, username, …}`.
- No draw.io / Gliffy on the spike site; their export_view output is unverified → live render
  detection is based on storage/export markers (configurable list) and must degrade gracefully.

## 2. Execution contexts

| Context | File | Role |
|---|---|---|
| Service worker | `entrypoints/background.ts` → `lib/job/*`, `lib/render/*`, `lib/pdf/*`, `lib/download.ts` | Orchestrator: job state machine, worker/live tabs, `chrome.debugger` printing, pdf-lib post-processing, downloads, notifications, context menus, keyboard command, permission-grant follow-up. **No DOM** (no DOMParser, no URL.createObjectURL). |
| Worker tab content script | `entrypoints/worker.ts` (unlisted script → `/worker.js`) | Injected with `chrome.scripting.executeScript({files:['/worker.js']})` into a background tab opened on `{base}/rest/api/space?limit=1`. RPC server for `SwToWorker`. Does **all Confluence API calls** (same-origin, cookies) via `lib/confluence/*`, keeps fetched HTML in memory, and **assembles the print document into its own DOM** via `lib/assemble/*`. The SW then prints this tab. |
| Live render script | `entrypoints/live.ts` (unlisted → `/live.js`) | Injected into real Confluence page tabs for FR-10: expand macros, hide app chrome, wait for macro render, answer `live/prepare`. |
| Popup | `entrypoints/popup/` | Probe active tab (activeTab + `executeScript({func: probePage})`), mode picker, request site permission, start "This page" export, open preview for multi-page modes. |
| Preview tab | `entrypoints/preview/` (`/preview.html?req=<base64url JSON ExportRequest>`) | FR-6 tree picker, FR-7 preview & pruning, FR-12 progress / cancel / error summary, FR-16 large-export guard. Keeps the SW alive while open. |
| Options | `entrypoints/options/` | Settings (lib/settings.ts), site access management (lib/permissions.ts). |
| Offscreen document | `entrypoints/offscreen/` (`/offscreen.html`) | Turns bytes into `blob:` URLs for `chrome.downloads` (`SwToOffscreen`). |

Shared code lives in `lib/`; shared Preact components in `components/`; UI CSS in `assets/`.

## 3. Pipeline

1. **Detect** (popup): `probePage()` → `ProbeResult` (site, kind, id, spaceKey, title, lastUpdated, user).
2. **Permission**: `requestSiteAccess(origin)` inside the click handler (user gesture). The popup
   may close while Chrome shows the prompt; therefore the popup first stores the intended action
   in `chrome.storage.session` under `pendingStart` and the SW starts it on
   `chrome.permissions.onAdded` if the origin matches (and clears it).
3. **Worker tab**: SW `openWorkerTab(site, nearTabId)` → inactive tab at the end of the source
   window, URL `{base}/rest/api/space?limit=1`, waits for `complete`, injects `/worker.js`,
   pings until ready. One worker tab per job; also used by the preview for collect/tree.
4. **Collect** (worker): `collect(client, request)` → ordered, de-duplicated `PageRef[]`.
5. **Preview** (multi-page): user prunes; FR-16 thresholds (`warnPageCount`, `confirmPageCount`, managed `maxPages`).
6. **Fetch** (worker): `fetchPages` pool (settings.apiConcurrency), 429 back-off, per-page
   `FetchedPageInfo` (permission errors → skipped, never fatal). Detect `needsLiveRender`.
7. **Assemble + print**, in batches of `settings.printBatchSize` pages (normally one batch):
   worker builds cover (first batch only) + TOC (first batch, lists *all* pages) + page sections →
   waits for images/fonts → SW `printTabToPdf(workerTabId, printParams)`.
   Live-render pages appear as header-only sections containing a `.cf-live-slot` marker.
8. **Live render** (if enabled and any page flagged): `liveRenderPages()` prints each flagged
   page from its real URL (pool of `liveRenderConcurrency` tabs).
9. **Post-process** (SW, pdf-lib): concatenate batch PDFs; for each live page, insert its pages
   right after that page's header sheet (located via named destination `p-{id}`, see §5);
   build outline (bookmarks) when Chrome's outline is unavailable or pages were inserted;
   set metadata (Title, Author, Subject, Creator, Producer, Keywords).
   `separateFiles` (FR-11): print each page as its own document (no cover/TOC), zip with fflate.
10. **Download**: `saveBytes(bytes, filename, mime)` via offscreen blob URL + `chrome.downloads.download`
    (no `saveAs` → respects the user's Chrome "Ask where to save" setting). Close worker/live tabs,
    detach debugger (always in `finally`), notification, badge cleared.

Cancel: SW aborts its AbortController, sends `worker/cancel`, detaches debugger, closes tabs,
status `cancelled` within 2 s.

## 4. Module contracts (exact exports — implement these signatures)

### lib/util
```ts
// lib/util/pool.ts
export function createPool(concurrency: number): <T>(task: () => Promise<T>) => Promise<T>;
export async function mapPool<T, R>(items: T[], concurrency: number,
  fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]>;
// lib/util/filename.ts
export function sanitizeFilenamePart(s: string, maxLen?: number): string;
export function buildFilename(p: { spaceKey?: string; title: string; date?: Date; ext: 'pdf' | 'zip' }): string;
//   => `{spaceKey}_{title}_{YYYY-MM-DD}.{ext}` (FR-14), safe on Windows/macOS, no leading dots, <= 150 chars
// lib/util/base64.ts
export function bytesToBase64(bytes: Uint8Array): string;   // chunked, no stack overflow on 100 MB
export function base64ToBytes(b64: string): Uint8Array;
export function encodeRequestParam(req: unknown): string;   // base64url(JSON) for preview.html?req=
export function decodeRequestParam<T>(s: string): T;
// lib/util/abort.ts
export function throwIfAborted(signal?: AbortSignal): void; // throws DOMException('AbortError')
export function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export function isAbortError(e: unknown): boolean;
```

### lib/confluence (owned by the "confluence" agent; runs in the worker tab and popup probe)
```ts
// url.ts
export interface ParsedConfluenceUrl {
  kind: 'page' | 'blogpost' | 'folder' | 'whiteboard' | 'database' | 'embed' | 'space' | 'tiny' | 'unknown';
  id?: string; spaceKey?: string; tinyCode?: string;
  /** DC `/display/KEY/Page+Title` URLs carry a title instead of an id. */
  title?: string;
  editor?: boolean;
}
export function parseConfluenceUrl(url: string, contextPath?: string): ParsedConfluenceUrl;
export function decodeTinyCode(code: string): string | null;
export function contentUrl(site: SiteInfo, c: { id: string; type: ContentType; spaceKey?: string }): string;
export function isSameSite(url: string, site: SiteInfo): boolean;

// http.ts — same-origin GET only. credentials:'include', Accept: application/json.
export class HttpError extends Error { status: number; url: string; }
export interface HttpOptions { signal?: AbortSignal; onThrottle?: (retryInMs: number) => void; maxRetries?: number /*3*/; }
export function getJson<T>(url: string, opts?: HttpOptions): Promise<T>;   // retries 429/502/503/504 with Retry-After + exp backoff + jitter
export function getText(url: string, opts?: HttpOptions): Promise<string>;
/** Follows v2 `_links.next` and v1 `_links.next`/`start`+`limit`; yields `results[]` items. */
export function paginate<T>(firstUrl: string, site: SiteInfo, opts?: HttpOptions): AsyncGenerator<T>;

// client.ts
export interface ContentSummary {
  id: string; type: ContentType; title: string; status?: string;
  spaceKey?: string; spaceId?: string; parentId?: string; position?: number;
  /** depth relative to the queried parent (1 = direct child); set by getDescendants */
  depth?: number; hasChildren?: boolean; url: string;
}
export interface PageBody {
  id: string; type: ContentType; title: string; spaceKey?: string; spaceId?: string;
  html: string;                // export_view
  version?: number; lastModified?: string; authorDisplayName?: string;
  breadcrumb: string[];        // ancestor titles, space root first, excluding the page itself
  url: string; status?: string;
}
export interface SpaceSummary { id?: string; key: string; name: string; homepageId?: string; }
export interface ConfluenceClient {
  readonly site: SiteInfo;
  getContent(id: string, type?: ContentType): Promise<ContentSummary>;
  getChildren(parent: { id: string; type: ContentType }): Promise<ContentSummary[]>;             // sidebar order
  getDescendants(parent: { id: string; type: ContentType }, maxDepth?: number): Promise<ContentSummary[]>; // DFS pre-order (tree order), depth >= 1
  getSpace(spaceKey: string): Promise<SpaceSummary>;
  getSpaceRoots(space: { key: string; id?: string }): Promise<ContentSummary[]>;                 // top-level content of a space, sidebar order
  getPageBody(id: string, type: ContentType): Promise<PageBody>;
  getStorageBody(id: string, type: ContentType): Promise<string>;
  findPageByTitle(spaceKey: string, title: string): Promise<ContentSummary | null>;
  getCurrentUser(): Promise<{ displayName: string } | null>;
}
export function createClient(site: SiteInfo, http?: HttpOptions): ConfluenceClient; // picks cloud.ts or server.ts by site.flavour
// cloud.ts: export class CloudClient implements ConfluenceClient (v2, v1/CQL fallbacks)
// server.ts: export class ServerClient implements ConfluenceClient (DC/Server v1: /rest/api/content/{id}?expand=…,
//            /rest/api/content/{id}/child/page?expand=extensions.position, CQL ancestor=… for descendants)

// links.ts
export interface LinkTargets { ids: string[]; titles: { spaceKey?: string; title: string }[]; tinyCodes: string[] }
export function extractLinksFromExportView(html: string, site: SiteInfo, selfId: string): LinkTargets; // uses DOMParser
export function extractLinksFromStorage(storage: string, site: SiteInfo, selfId: string): LinkTargets;
// Ignore: same page, attachments (/download/), Jira (/browse/), people (/people/, /display/~), external, mailto.

// collect.ts
export interface CollectOptions { signal?: AbortSignal; onProgress?: (msg: string) => void; includeArchived?: boolean; }
export function collect(client: ConfluenceClient, request: ExportRequest, opts?: CollectOptions):
  Promise<{ pages: PageRef[]; warnings: string[] }>;
// current → [root]; subtree → root + descendants (depth limit); folder → descendants of folder
// (the folder itself is included as a depth-0 'folder' PageRef = a TOC section header, no body);
// space → all space roots + their descendants; linked → root + linked pages (BFS by hop, depth 1|2,
// visited set, title→id resolution, same-site only); selection → selectedIds ordered by tree order
// (resolve positions via ancestors when ids come from different branches; fall back to given order).
// Archived/draft excluded unless includeArchived. Whiteboards/databases/embeds kept as link-only refs.
// De-duplicate by id, first occurrence wins.

// detect.ts — runs IN THE PAGE via chrome.scripting.executeScript({ func: probePage }).
// MUST be fully self-contained (no imports, no module-scope helpers — they are not serialized).
export async function probePage(): Promise<ProbeResult>;
// Detects Confluence by ajs metas (ajs-base-url / ajs-context-path / ajs-confluence-flavour /
// ajs-cloud-id) or URL shape; determines flavour (cloud if ajs-cloud-id or *.atlassian.net or
// v2 API answers), parses the URL (page/folder/space/blogpost/tiny/viewpage.action/display), resolves
// space home & tiny links with same-origin fetch, fetches title/space/lastUpdated (one request), and
// the current user's display name (ajs-current-user-fullname meta or /rest/api/user/current).
```

### lib/assemble (owned by the "assemble" agent; runs in the worker tab — real DOM)
```ts
// macros.ts
export function detectLiveRenderMacros(exportHtml: string, storageHtml: string | null, macroNames: string[]): string[]; // [] = static
export function replaceUnsupportedContent(root: Element, ctx: { pageUrl: string }): number; // returns # placeholders (FR-9)
// sanitize.ts
export interface SanitizeContext {
  pageId: string; site: SiteInfo; pageUrl: string;
  /** id → in-document anchor for every page in the export (`#p-{id}`) */
  exportedIds: Set<string>;
  includeComments: boolean;
}
export function sanitizePageHtml(html: string, ctx: SanitizeContext): DocumentFragment;
// DOMPurify (no scripts/handlers/forms/object/embed; iframes removed by macros first), strip UI chrome,
// prefix ids + same-page anchors with `p{pageId}-`, rewrite links to exported pages to `#p-{id}`,
// absolutize relative URLs against site.origin, demote headings (h1→h2 … h5→h6, h6 stays),
// remove `loading="lazy"`, force expands open, drop inline-comment highlights unless includeComments.
// document.ts
export interface AssembleInput {
  pages: { ref: PageRef; body?: PageBody; info?: FetchedPageInfo; live?: boolean }[]; // in order
  allPages: PageRef[]; site: SiteInfo; options: ExportOptions;
  cover: CoverInfo | null; toc: boolean; generatedBy: string; // "Fast PDF Export for Confluence v1.0.0"
}
export function buildPrintDocument(doc: Document, input: AssembleInput): void; // replaces doc's <head>/<body>
// Structure: section.cf-cover, nav.cf-toc (TOC entries use divs/links, NOT headings),
// article.cf-page#p-{id} > header.cf-page-meta > h1 + meta line, then content.
// Link-only types (folder section header / whiteboard / database / embed): article with h1 + "Open in Confluence" link.
// Live pages: header + <div class="cf-live-slot" data-page-id> (content arrives via live render).
// Failed pages are not passed in (they are listed in the error summary instead).
// assets.ts
export function waitForAssets(doc: Document, timeoutMs?: number /*15000*/): Promise<{ imageFailures: number }>;
// every <img> complete && naturalWidth>0 or replaced by a placeholder box with the filename; document.fonts.ready.
// print.css — imported with `import printCss from './print.css?inline'`; builtPrintCss(options) in document.ts
export function buildPrintCss(options: ExportOptions): string; // @page size/orientation/margins + print.css + customCss
```

### lib/render, lib/pdf, lib/download.ts (owned by the "render-pdf" agent; run in the SW)
```ts
// lib/render/cdp.ts
export interface PrintParams { paperWidthIn: number; paperHeightIn: number; marginTopIn: number; marginBottomIn: number;
  marginLeftIn: number; marginRightIn: number; landscape: boolean; displayHeaderFooter: boolean;
  headerTemplate: string; footerTemplate: string; outline: boolean; tagged: boolean; }
export function toPrintParams(options: ExportOptions): PrintParams;
export function printTabToPdf(tabId: number, params: PrintParams, signal?: AbortSignal): Promise<Uint8Array>;
// attach debugger 1.3 → Page.printToPDF (preferCSSPageSize, printBackground, transferMode ReturnAsStream,
// generateDocumentOutline/generateTaggedPDF when params say so; retry once without them if Chrome rejects)
// → IO.read until eof → IO.close → ALWAYS detach in finally. Throws DebuggerUnavailableError when attach
// is blocked (another debugger, enterprise policy).
export class DebuggerUnavailableError extends Error {}
export function detachAll(): Promise<void>; // used on cancel / SW startup cleanup
// lib/render/tabs.ts
export function openWorkerTab(site: SiteInfo, nearTabId?: number): Promise<number>; // injects /worker.js, pings
export function ensureWorker(tabId: number): Promise<void>;
export function closeTabQuietly(tabId: number | undefined): Promise<void>;
// lib/render/liveRender.ts
export function liveRenderPages(pages: PageRef[], o: { options: ExportOptions; concurrency: number;
  timeoutMs?: number; signal?: AbortSignal; onProgress?: (done: number, current?: string) => void;
  nearTabId?: number }): Promise<Map<string, Uint8Array | Error>>;
// lib/pdf/merge.ts
export interface OutlineItem { title: string; pageIndex: number; children: OutlineItem[] }
export interface PdfMetadata { title: string; author?: string; subject?: string; keywords?: string[]; creator: string; producer?: string }
export function concatPdfs(parts: Uint8Array[]): Promise<{ bytes: Uint8Array; offsets: number[] }>;
export function findDestinationPages(pdf: Uint8Array, names: string[]): Promise<Map<string, number>>; // named dest → 0-based page index
export function finalizePdf(base: Uint8Array, o: {
  metadata: PdfMetadata;
  inserts?: { afterPageIndex: number; pdf: Uint8Array }[]; // applied from last to first
  outline?: OutlineItem[];         // replaces any existing outline when given
}): Promise<{ bytes: Uint8Array; pageCount: number }>;
export function buildOutline(pages: PageRef[], startPage: Map<string, number>): OutlineItem[]; // nested by depth
// lib/pdf/zip.ts
export function zipFiles(files: { name: string; data: Uint8Array }[]): Uint8Array; // fflate zipSync, unique names
// lib/download.ts
export function saveBytes(bytes: Uint8Array, filename: string, mime: string): Promise<number>; // downloadId
```

### lib (owned by the "orchestrator" agent; SW + shared)
```ts
// lib/settings.ts
export function loadSettings(): Promise<Settings>;         // DEFAULT_SETTINGS ⊕ storage.sync ⊕ managed policy
export function saveSettings(s: Settings): Promise<void>;
export function loadPolicy(): Promise<ManagedPolicy>;
export function onSettingsChanged(cb: (s: Settings) => void): () => void;
// lib/permissions.ts
export function originPattern(origin: string): string;     // 'https://x.atlassian.net/*'
export function hasSiteAccess(origin: string): Promise<boolean>;
export function requestSiteAccess(origin: string): Promise<boolean>; // must be called from a user gesture
export function listGrantedOrigins(): Promise<string[]>;
export function removeSiteAccess(origin: string): Promise<boolean>;
// lib/job/store.ts — chrome.storage.session persistence: saveJob, loadJob, listJobs, deleteJob, pendingStart get/set/clear
// lib/job/runner.ts — export function runJob(job: ExportJobState, deps): Promise<void>; the state machine
// lib/job/manager.ts — start/cancel/get/list, broadcast `job/update`, badge text, notifications
// entrypoints/background.ts — wires onMessage (UiToSw), commands, contextMenus (FR-15), permissions.onAdded,
//   startup cleanup (detach stale debuggers, close orphan worker tabs recorded in session storage)
// entrypoints/worker.ts — RPC server (SwToWorker) on top of lib/confluence + lib/assemble
// entrypoints/live.ts — answers SwToLive
// entrypoints/offscreen/ — answers SwToOffscreen
```

### UI (owned by the "ui" agent)
`entrypoints/popup/`, `entrypoints/preview/`, `entrypoints/options/`, `components/*`, `assets/ui.css`.
Talks to the SW only through `callSw()` from `lib/rpc.ts` and listens for `SwBroadcast`.

## 5. Notes & decisions

- **Why a JSON URL for the worker tab**: same-origin (cookies for API + images), no app JS, no CSP.
- **Section start pages**: every `article.cf-page` has `id="p-{id}"` and the TOC links to it, so
  Chrome emits named destinations `p-{id}`; `findDestinationPages()` maps them to sheet indexes.
  As a fallback (destinations missing), the worker also emits a tiny white marker text
  `⟦cfp:{id}⟧` in each page header (font-size 1px, color white) which `merge.ts` can search for.
- **Outline**: prefer Chrome's `generateDocumentOutline` (h1 = page titles, demoted content
  headings nest under them). Rebuild with pdf-lib when pages were inserted/merged or Chrome
  produced none.
- **Debugger fallback**: if `DebuggerUnavailableError`, activate the worker tab and call
  `window.print()` there (vector, but needs the print dialog) — spec §17.
- **Permissions**: required `activeTab, scripting, storage, downloads, debugger, notifications,
  contextMenus, offscreen`; `optional_host_permissions: https://*/*, http://*/*` granted per origin.
  No `tabs` permission (not needed: we only read URLs of tabs on granted origins).
- **Privacy**: only GET requests, only to the Confluence origin being exported; no analytics.
- **Managed policy** (`public/managed_schema.json`): `blockedSpaceKeys`, `disableLiveRender`,
  `defaultOptions`, `maxPages`.
