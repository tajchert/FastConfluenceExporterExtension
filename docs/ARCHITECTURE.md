# Architecture & module contracts

Source of truth for how the extension is put together. The implementation
is **generic** (any Confluence Cloud site incl. custom domains, plus Data Center / Server via the
v1 REST API) and **publishable** on the Chrome Web Store (no hard-coded hosts, runtime
per-origin permission grants, privacy policy, no remote code).

Stack: TypeScript, WXT 0.21 (MV3), Preact, pdf-lib, DOMPurify, fflate, Turndown (+ GFM plugin), Vitest (+happy-dom),
Playwright (E2E against a mock Confluence). Use the `chrome.*` API (typed by `@types/chrome`),
not `browser.*`.

## 0. Requirements index

Code comments reference these requirement ids.

| ID | Requirement |
|---|---|
| FR-1 | Detect Confluence pages, folders and spaces in the active tab; enable the action there. |
| FR-2 | Export the current page in one click (popup, keyboard shortcut). |
| FR-3 | Export a page with all descendants in page-tree order, optional depth limit. |
| FR-4 | Export a folder recursively in tree order. |
| FR-5 | Export pages linked from the current page (1 or 2 hops), de-duplicated, cycle-safe. |
| FR-6 | Manual selection from a lazy page tree with tri-state checkboxes; output in tree order. |
| FR-7 | Preview the page list before multi-page exports and drop individual pages. |
| FR-8 | One combined PDF: cover, clickable TOC, each page on a new sheet with a header block. |
| FR-9 | Content that can't be rendered statically becomes a visible placeholder with a link, never silently dropped. |
| FR-10 | Live render: print pages with client-rendered macros (diagrams, charts) from the real page. |
| FR-11 | Optionally one PDF per page, bundled in a ZIP. |
| FR-12 | Progress (page X of N, current title), cancel, error summary. |
| FR-13 | PDF options: paper size, orientation, margins, cover, TOC, metadata, comments, page numbers. |
| FR-14 | Filename `{space-key}_{root-title}_{YYYY-MM-DD}.pdf`, saved via chrome.downloads. |
| FR-15 | Context menu on Confluence links: export page / page + children. |
| FR-16 | Large-export guard: warn above 150 pages, require confirmation above 500. |
| FR-17 | Output formats: PDF (default), Markdown (`.md`, optionally with its images in a ZIP) or plain text (`.txt`); one file per page (ZIP) for every format. |

Non-functional targets: current page ≤ 5 s; 25-page subtree ≤ 30 s; 100 pages ≤ 2 min without a
tab crash; one failing page never fails the whole export; only GET requests to the Confluence site.

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
    (some Cloud sites omit `version=`, and the attachment redirects to `api.media.atlassian.com`)
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
    with links to `/browse/KEY-1`. Keep it (it is static). DC starts that table with an empty
    `<tr></tr>` before the header row. Cloud's newer Jira work-items datasource renders
    `table.jiraWorkItemMacroListViewTable` whose `<tbody>` is filled in the browser: an empty one
    becomes a placeholder (FR-9).
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
- E2E (Playwright Chromium + mock Confluence, `tests/e2e/`) confirmed: injecting `/worker.js` into the
  JSON endpoint tab works with Chrome's JSON viewer, cookies reach API and image requests from the
  worker tab, `printToPDF` via `chrome.debugger` emits `p-{id}` destinations and a heading outline that
  survive batch merging and live-page inserts.
- No draw.io / Gliffy on the spike site; their export_view output is unverified → live render
  detection is based on storage/export markers (configurable list) and must degrade gracefully.
  (Verified later on Data Center, see §1b.)

## 1b. Public sites, anonymous access (verified 2026-10-06)

Checked against `uconn.atlassian.net` (Cloud) and `cwiki.apache.org/confluence` (Data Center
9.2.21) without signing in. The opt-in live suite (`tests/live`, [TESTING.md](TESTING.md#live-tests))
keeps checking these.

- **Anonymous is a valid session.** `GET /rest/api/user/current` answers
  `{"type":"anonymous","displayName":"Anonymous"}`; `ajs-remote-user`,
  `ajs-current-user-fullname` (and on Cloud `ajs-atlassian-account-id`) are present but empty.
  Content, tree listings, CQL and attachments all work. The worker records the session at the
  start of a fetch (`lib/confluence/session.ts`) and treats a failure as "signed out" only when
  that changed (signed in → anonymous / login page), so a network hiccup on a public site skips
  one page instead of aborting with "please log in". DC answers **404** (not 401) for content an
  anonymous visitor can't see, so for a job that started signed in, 403/404 also trigger the
  one-time session check; for an anonymous job they are reported as "This page isn't public".
- **User profiles are hidden**: `/rest/api/user?accountId=` answers 403 for anonymous visitors
  → the Cloud client stops author lookups after the first 403 (no author in the page header).
- **Worker tab**: `{base}/rest/api/space?limit=1` and (Cloud) `{base}/api/v2/spaces?limit=1` both
  answer 200 JSON without CSP, also anonymously. Cloud v1 responses carry `Deprecation` and
  `Warning: 299 … will be removed` headers but still work; the Cloud worker tab and the popup
  probe for Cloud pages use v2 first.
- **Tiny links**: Cloud redirects `/x/{code}` to `/pages/tinyurl.action?urlIdentifier={code}`
  (then the SPA rewrites the URL), so both URL parsers read `urlIdentifier`.
- **Tree listings**: `direct-children` items have no `parentId`; `childPosition` values range
  widely (128 … 952556969) and sort numerically. There is no space-level `direct-children`
  (400: hierarchical types are `DATABASES, EMBEDS, FOLDERS, PAGES, SLIDES, WHITEBOARDS`), and
  `spaces/{id}/pages?depth=root` lists pages only → non-page items at a space root come from CQL
  `space = "KEY" and type in (folder, whiteboard, database, embed)` with
  `expand=content.ancestors` (empty ancestors = root). `slides` is a link-only content type.
  DC 9 ignores `expand=childTypes.page` (so `hasChildren` stays unknown) and `extensions.position`
  is `"none"` for siblings never reordered; `expand=space` on every child doubled the payload →
  children inherit the parent's space instead.
- **export_view has no `data-macro-name`** on either site. Live-render detection therefore also
  looks at class names (only the outermost element of a class match, ignoring image maps and
  hidden settings: DC Gliffy is `span.gliffy-container > img.gliffy-image + map.gliffy-dynamic`,
  DC draw.io is a plain `img.drawio-diagram-image`), and on Cloud it relies on the storage format.
- **DC markup**: page tree = `div.plugin_pagetree` (empty list + `fieldset.hidden` settings) →
  placeholder; AUI's `.hidden` rows (attachments macro details, macro settings) are dropped;
  a single Jira issue (`span.jira-issue`) prints "Getting issue details… STATUS" until the browser
  fills it → only the issue key link is kept (for anonymous viewers the summary is empty and the
  status only `( <icon> )`: both are dropped with their dash). View-file macro links point at the
  page itself (`…/pages/{id}/Title?preview=/{id}/{attachmentId}/{file}`) with a truncated
  "Name…" label → rewritten to `/download/attachments/{id}/{file}` labelled with the file name, a
  `<br>` between adjacent ones. Links between pages also come as
  `/display/KEY/Title` and `viewpage.action?spaceKey=&title=`: they become internal links through
  a title index of the exported pages (`SanitizeContext.pageIndex`).
- **Cloud markup**: links to another page's heading use editor-style fragments
  (`#Included-Models`) while export_view ids are `PageTitle-IncludedModels` → matched loosely
  (case, hyphens and spaces ignored). Space links (`/spaces/KEY/overview`) carry no resource id:
  linked mode follows them to the space homepage, and they become internal links when the
  homepage is exported. Legacy text colours come as `legacy-color-text-*` classes (print.css
  maps them). The "recently updated" macro's spinner and "Show More" are dropped.
- No `X-RateLimit-*`/`Retry-After` headers and no 429s were seen at ≤ 2 requests per second.

## 2. Execution contexts

| Context | File | Role |
|---|---|---|
| Service worker | `entrypoints/background.ts` → `lib/job/*`, `lib/render/*`, `lib/pdf/*`, `lib/download.ts` | Orchestrator: job state machine, worker/live tabs, `chrome.debugger` printing, pdf-lib post-processing, downloads, notifications, context menus, keyboard command, permission-grant follow-up. **No DOM** (no DOMParser, no URL.createObjectURL). |
| Worker tab content script | `entrypoints/worker.ts` (unlisted script → `/worker.js`) | Injected with `chrome.scripting.executeScript({files:['/worker.js']})` into a background tab opened on `workerTabUrl(site)#cfp-worker` (Cloud `{base}/api/v2/spaces?limit=1`, DC `{base}/rest/api/space?limit=1`). RPC server for `SwToWorker`. Does **all Confluence API calls** (same-origin, cookies) via `lib/confluence/*`, keeps fetched HTML in memory (plus a bounded LRU of page bodies shared by the preview's collection and the export's fetch), and **assembles the print document into its own DOM** via `lib/assemble/*`. The SW then prints this tab. For Markdown / text it **converts** the pages instead (`lib/convert`, Turndown needs a DOM) and downloads Markdown images (`lib/output/assets.ts`), keeping the files until the SW reads them (`worker/readOutput`). Long operations (`worker/collect`, `worker/fetch`, `worker/convert`) run in the background and report their outcome with a `worker/done` notification (see §5 Service-worker lifetime). |
| Live render script | `entrypoints/live.ts` (unlisted → `/live.js`) | Injected into real Confluence page tabs for FR-10: expand macros, hide app chrome, wait for macro render, answer `live/prepare`. |
| Popup | `entrypoints/popup/` | Probe active tab (activeTab + `executeScript({func: probePage})`), mode picker, request site permission, start "This page" export, open preview for multi-page modes. |
| Preview tab | `entrypoints/preview/` (`/preview.html?req=<base64url JSON ExportRequest>`) | FR-6 tree picker, FR-7 preview & pruning (with breadcrumbs), FR-12 progress / cancel / error summary, FR-16 large-export guard. Collects pages over a UI port (`UI_PORT_NAME`, `components/collectClient.ts`): progress, "Throttled by Confluence, retrying…" and Cancel; closing the page cancels its collection and closes the idle helper tab. |
| Options | `entrypoints/options/` | Settings (lib/settings.ts), site access management (lib/permissions.ts). |
| Offscreen document | `entrypoints/offscreen/` (`/offscreen.html`) | Turns bytes into `blob:` URLs for `chrome.downloads` (`SwToOffscreen`). |

Shared code lives in `lib/`; shared Preact components in `components/`; UI CSS in `assets/`.

## 3. Pipeline

1. **Detect** (popup): `probePage()` → `ProbeResult` (site, kind, id, spaceKey, title, lastUpdated, user).
2. **Permission**: `requestSiteAccess(origin)` inside the click handler (user gesture). The popup
   may close while Chrome shows the prompt; therefore the popup first stores the intended action
   in `chrome.storage.session` under `pendingStart` (TTL 90 s). The export is started exactly once
   through `manager.claimPendingStart(pending)`: both `chrome.permissions.onAdded` (SW) and the
   popup (`job/claimPending`, when it is still open after the grant) go through it, and the claim,
   keyed by `pending.createdAt`, is registered synchronously before any await. Every other
   permission request (preview "Allow & export", options "Add site") first clears `pendingStart`
   (fire-and-forget, keeps the user gesture), so an old, denied popup request never starts on an
   unrelated grant. The context menu never prompts (see §5 Permissions).
3. **Worker tab**: SW `openWorkerTab(site, nearTabId, signal)` → inactive tab at the end of the
   source window, URL `workerTabUrl(site)` + `#cfp-worker`, waits for `complete`, injects
   `/worker.js`, pings until ready. `waitForTabComplete` also polls `tabs.get`: a lazily added
   `onUpdated` listener can miss a fast page's `complete` while `tabs.get` still answers `loading`
   (seen in real Chrome on the first export after the service worker started). One worker tab per
   job; the preview's cached helper tab (per site and profile: incognito tabs get their own) is
   handed over to the job when idle. A cancel while the tab is still opening closes it: the
   signal is passed down, and the runner also closes whatever tab the pending open resolves to.
4. **Collect** (worker, background op): `collect(client, request)` → ordered, de-duplicated
   `PageRef[]`, each with its breadcrumb. "This page" needs no collection (`currentPageRef()`).
5. **Preview** (multi-page): collection over the UI port (cancellable, progress and throttling
   shown; a result collected moments ago for the same request — the popup's page count — is
   reused for 90 s); user prunes; FR-16 thresholds (`warnPageCount`, `confirmPageCount`, managed
   `maxPages`) count pages, not folder rows.
6. **Fetch** (worker, background op): pool (settings.apiConcurrency), 429 back-off, per-attempt
   timeouts, per-page `FetchedPageInfo` (permission errors → skipped, never fatal). One request per
   page on Cloud (v2 export_view; space key, author and breadcrumb from cached lookups). The
   session at the start (signed in / anonymous, `lib/confluence/session.ts`) is read in parallel
   with the first bodies. A 401 or a network failure (and, for a job that started signed in, a
   403/404) triggers one session check; a session that went from signed in to anonymous or a
   login page aborts the fetch with one sign-in error instead of N "no permission" skips. An
   anonymous job on a public site keeps going (failed pages are skipped). Detect
   `needsLiveRender`.
7. **Assemble + print**, in batches of `settings.printBatchSize` pages (normally one batch, max
   400): worker builds cover (first batch only) + TOC (first batch, lists *all* pages, levels from
   the full page list so children of a skipped page take its place) + page sections + zero-size
   `p-{id}` targets for pages printed in other batches → waits for images/fonts → SW prints with
   one debugger session for the whole job (`createPrintSession`).
   Live-render pages appear as header-only sections containing a `.cf-live-slot` marker.
8. **Live render** (if enabled and any page flagged): `liveRenderPages()` prints each flagged
   page from its real URL (`#cfp-live`, pool of `liveRenderConcurrency` tabs). The page's own
   title and byline are hidden (the header sheet already has them).
9. **Post-process** (SW, pdf-lib): `concatPdfs(parts, owner)` (a destination defined by several
   batches resolves to the batch holding the real section); `finalizeExport()` parses the result
   once: locates sections (`p-{id}`, §5), inserts live pages right after their header sheet,
   writes the bookmarks as the page tree with each page's heading bookmarks from Chrome's outline,
   stamps "n / N" when needed (§5 Page numbers), sets metadata (Title, Author, Subject, Creator,
   Producer, Keywords). Every step is wrapped in `abortable()`; buffers are released before saving.
   `separateFiles` (FR-11): print each page as its own document (no cover/TOC), zip with fflate's
   streaming `Zip` (one file at a time, yielding in between — fflate's async API needs Workers).
10. **Download**: `saveBytes(bytes, filename, mime, signal)` via offscreen blob URL +
    `chrome.downloads.download` (no `saveAs` → respects the user's Chrome "Ask where to save"
    setting). It waits for a final download state without a timeout; a cancel cancels (and erases)
    the download. Close worker/live tabs, detach debugger (always in `finally`), notification,
    badge cleared.

**Markdown / text branch** (`options.format` `'markdown' | 'text'`, FR-17): steps 1–6 are the same
(live render is never requested: `liveRenderMacros: []`, no storage). Then, instead of 7–9:

- 7'. **Convert** (worker, background op `worker/convert` → `worker/done` op `convert`): status
  `rendering`, "Converting to Markdown…" / "Converting to text…". The worker calls
  `convertPages(inert, …)` on an inert `document.implementation.createHTMLDocument('cfp-convert')`
  (no browsing context: nothing it builds loads or runs) with the fetched bodies (combined: every
  included ref incl. link-only ones; separate: content pages only, the cover and TOC going into a
  `00-Contents` index file; a single content page gets neither, like a separate PDF; with no
  content page at all — only whiteboards / databases / embeds — the combined path is used) and
  `baseName` = the download filename stem.
  For Markdown with `downloadImages`, it downloads `result.assets` — only images on the Confluence
  origin (`collectAssets` skips others, `downloadAssets` refuses them via `allowedOrigin`; a CORS
  fetch from this tab would send `Origin: <confluence>` to the other host) — (`downloadAssets`: same-origin
  credentials, redirects followed, no referrer, `settings.apiConcurrency` at a time, 60 s and
  25 MB per image, 300 MB in total; progress "Downloading images x/N"); failures are relinked to
  their absolute URLs (`relinkFailedAssets`) and reported as one `degraded` "Images" error. The
  files stay in the worker (`OutputEntry[]`: documents first, then assets).
- 8'. **Read back** (status `merging`): the SW pulls the bytes with `worker/readOutput` (base64,
  ≤ 8 MiB raw per answer, big entries split; `lib/output/chunks.ts`), so no message carries the
  whole export.
- 9'. **Save**: exactly one document and no asset → saved as is (`{key}_{title}_{date}.md|.txt`,
  `text/markdown;charset=utf-8` / `text/plain;charset=utf-8`; with separate files and one page,
  named after that page). Otherwise a ZIP (`.zip`): documents deflated, images stored, paths kept
  (`assets/{pageId}/…`).

No debugger session is created on this branch (no "started debugging" bar), and the PDF-only
options (paper, orientation, margins, page numbers, live render, wide tables, custom CSS) are
ignored. Cancel, progress, errors and notifications work as for PDF.

Cancel: SW aborts its AbortController, sends `worker/cancel`, detaches debugger, cancels a pending
download, closes tabs, status `cancelled` within 2 s.

## 4. Module contracts (exact exports — implement these signatures)

### lib/util
```ts
// lib/util/pool.ts
export function createPool(concurrency: number): <T>(task: () => Promise<T>) => Promise<T>;
export async function mapPool<T, R>(items: T[], concurrency: number,
  fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]>;
// lib/util/filename.ts
export function sanitizeFilenamePart(s: string, maxLen?: number): string;
export function buildFilename(p: { spaceKey?: string; title: string; date?: Date; ext: 'pdf' | 'zip' | 'md' | 'txt' }): string;
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
export interface HttpOptions { signal?: AbortSignal; onThrottle?: (retryInMs: number) => void; maxRetries?: number /*3*/;
  timeoutMs?: number /*60 s until headers*/; bodyTimeoutMs?: number /*180 s for the body*/; }
export function getJson<T>(url: string, opts?: HttpOptions): Promise<T>;   // retries 429/502/503/504 with Retry-After + exp backoff + jitter;
//   a timed-out attempt is retried once like a network error, then HttpError(0, 'request timed out')
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
  getChildren(parent: { id: string; type: ContentType }): Promise<ContentSummary[]>;             // sidebar order, one level
  getDescendants(parent: { id: string; type: ContentType; title?: string }, maxDepth?: number,
    opts?: { onWarning?(msg: string): void }): Promise<ContentSummary[]>; // DFS pre-order (tree order), depth >= 1;
    // a sub-listing below the root that fails (429 after retries, 5xx, network) skips that branch + warning
  getSpace(spaceKey: string): Promise<SpaceSummary>;
  getSpaceRoots(space: { key: string; id?: string }): Promise<ContentSummary[]>;                 // top-level content of a space, sidebar order
  getPageBody(id: string, type: ContentType, known?: { breadcrumb?: string[] }): Promise<PageBody>;
  getStorageBody(id: string, type: ContentType): Promise<string>;
  findPageByTitle(spaceKey: string, title: string, lookup?: { type?: 'page' | 'blogpost'; postingDay?: string }): Promise<ContentSummary | null>;
  getCurrentUser(): Promise<{ displayName: string } | null>;
}
// ContentType = 'page' | 'blogpost' | 'folder' | 'whiteboard' | 'database' | 'embed' | 'slides'
//   (folder = section header; whiteboard/database/embed/slides = link-only)
// Caching rule (both clients): lookups are cached per client, but only successful or definitive
// (403/404) answers; a transient failure is evicted and retried by the next call. Cloud v2
// listings and DC v1 ancestors seed the content cache, so walking up a tree costs no requests.
export function createClient(site: SiteInfo, http?: HttpOptions): ConfluenceClient; // picks cloud.ts or server.ts by site.flavour
// cloud.ts: export class CloudClient implements ConfluenceClient (v2, v1/CQL fallbacks). getPageBody = one v2
//            export_view request; getChildren = `direct-children` (hasChildren unknown); blog posts by title via v1
//            (`postingDay`); type discovery: v2 pages → v1 content (also blog posts) → folders/whiteboards/databases/embeds
//            getSpaceRoots = v2 `spaces/{id}/pages?depth=root` + CQL for non-page roots (§1b); user lookups stop after a 403
// server.ts: export class ServerClient implements ConfluenceClient (DC/Server v1: /rest/api/content/{id}?expand=…,
//            /rest/api/content/{id}/child/page?expand=extensions.position,childTypes.page; children inherit the parent's space)
// session.ts
export type SessionState = 'user' | 'anonymous' | 'signed-out' | 'unreachable';
export function readSession(baseUrl: string, signal?: AbortSignal): Promise<SessionState>; // GET /rest/api/user/current
export function needsSessionCheck(status: number | undefined, start: SessionState | undefined): boolean;
export function sessionStillValid(start: SessionState | undefined, now: SessionState): boolean;

// links.ts
export interface LinkTargets {
  ids: string[];
  types: Record<string, ContentType>;   // type of an id when the link tells it (no type discovery needed)
  titles: { spaceKey?: string; title: string; type?: 'blogpost'; postingDay?: string }[];
  tinyCodes: string[];
  spaceKeys: string[];                   // links to a space itself (overview / `/display/KEY`) → its homepage
}
export function extractLinksFromExportView(html: string, site: SiteInfo, selfId: string): LinkTargets; // uses DOMParser
export function extractLinksFromStorage(storage: string, site: SiteInfo, selfId: string): LinkTargets;
// Ignore: same page, attachments (/download/), Jira (/browse/), people (/people/, /display/~user with no page
// title), external, mailto. `/display/~user/Title` is a page in a personal space and is followed.

// collect.ts
export interface CollectOptions { signal?: AbortSignal; onProgress?: (msg: string) => void; includeArchived?: boolean;
  maxItems?: number; /* linked mode: stop at this many items (managed maxPages + 1, else 2,000) and warn */ }
export function collect(client: ConfluenceClient, request: ExportRequest, opts?: CollectOptions):
  Promise<{ pages: PageRef[]; warnings: string[] }>;
// current → [root]; subtree → root + descendants (depth limit); folder → descendants of folder
// (the folder itself is included as a depth-0 'folder' PageRef = a TOC section header, no body);
// space → all space roots + their descendants; linked → root + linked pages (BFS by hop, depth 1|2,
// visited set, title→id resolution, same-site only); selection → selectedIds ordered by tree order
// (resolve positions via ancestors when ids come from different branches; fall back to given order).
// Archived excluded unless includeArchived; drafts always excluded. Whiteboards/databases/embeds kept as
// link-only refs. De-duplicate by id, first occurrence wins. Every PageRef carries its breadcrumb (tree modes:
// from the parent chain; selection: from the ancestor chains; linked: cached ancestor lookups). Linked mode
// reads storage only when export_view is empty or failed.

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
  pageIndex?: PageIndex; // exported pages by `spaceKey + title` and by URL path (links without an id)
}
export function buildPageIndex(pages: { id: string; title?: string; spaceKey?: string; url?: string }[], site: SiteInfo): PageIndex;
export function sanitizePageHtml(html: string, ctx: SanitizeContext): DocumentFragment;
// DOMPurify (no scripts/handlers/forms/object/embed; iframes removed by macros first), strip UI chrome,
// prefix ids + same-page anchors with `p{pageId}-`, rewrite links to exported pages to `#p-{id}`,
// absolutize relative URLs against site.origin, demote headings (h1→h2 … h5→h6, h6 stays),
// remove `loading="lazy"`, force expands open, drop inline-comment highlights unless includeComments.
// document.ts
export interface AssembleInput {
  pages: { ref: PageRef; body?: PageBody; info?: FetchedPageInfo; live?: boolean }[]; // in order
  allPages: PageRef[]; site: SiteInfo; options: ExportOptions;
  cover: CoverInfo | null; toc: boolean; generatedBy: string; // "Fast Confluence Exporter v1.0.0"
  excludeIds?: string[]; // ids of allPages not in the final PDF (left out of TOC, links stay external;
                         // their children take their place in the TOC hierarchy)
}
export function buildPrintDocument(doc: Document, input: AssembleInput): void; // replaces doc's <head>/<body>
// Structure: section.cf-cover, nav.cf-toc (TOC entries use divs/links, NOT headings),
// article.cf-page#p-{id} > header.cf-page-meta > h1 + meta line, then content. <head> has
// <meta name="referrer" content="no-referrer"> before anything loads (embedded images on other hosts).
// Link-only types (folder section header / whiteboard / database / embed): article with h1 + "Open in Confluence" link.
// Live pages: header + <div class="cf-live-slot" data-page-id> (content arrives via live render).
// Failed pages are not passed in (they are listed in the error summary instead).
// Every document ends with a hidden `div.cf-dests` (display:none) holding `<a href="#p-{id}">` for
// each article, so Chrome emits named destinations for every section in every print batch (§5),
// and with a zero-size `span.cf-xbatch#p-{id}` for each exported page printed in another batch.
// Wide tables: `cf-wide` / `cf-wide-xl`, plus `cf-fixed` (fixed layout) only when the author's
// column widths were kept as percentages.
// geometry.ts (pure, shared with the SW): paperSizeMm(), effectiveMarginsMm() (bottom margin
// raised to FOOTER_MIN_MARGIN_MM when page numbers are on) — used by buildPrintCss, toPrintParams
// and the live-render @page rule so all printed sheets share one geometry.
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
export function printTabToPdf(tabId: number, params: PrintParams, signal?: AbortSignal,
  hooks?: { beforePrint?(send: (method: string, params?: object) => Promise<unknown>): Promise<void> }): Promise<Uint8Array>;
export function createPrintSession(tabId: number, signal?: AbortSignal): { print(params, hooks?): Promise<Uint8Array>; close(): Promise<void> };
// one attach for several prints (the runner uses one session per job: one debugger infobar, no flicker per page)
// attach debugger 1.3 → Page.printToPDF (preferCSSPageSize, printBackground, transferMode ReturnAsStream,
// generateDocumentOutline/generateTaggedPDF when params say so; retry once without them if Chrome rejects)
// → IO.read until eof → IO.close → ALWAYS detach in finally. Throws DebuggerUnavailableError when attach
// is blocked (another debugger, enterprise policy).
export class DebuggerUnavailableError extends Error {}
export function detachAll(): Promise<void>; // used on cancel / SW startup cleanup
// lib/render/tabs.ts
export function openWorkerTab(site: SiteInfo, nearTabId?: number, signal?: AbortSignal): Promise<number>; // injects /worker.js, pings;
//   closes its tab and rejects with AbortError when `signal` aborts while opening
export function closeOrphanTabs(): Promise<number>; // recorded ids + any tab whose URL ends with #cfp-worker / #cfp-live
export function ensureWorker(tabId: number): Promise<void>;
export function closeTabQuietly(tabId: number | undefined): Promise<void>;
// lib/render/liveRender.ts
export function liveRenderPages(pages: PageRef[], o: { options: ExportOptions; concurrency: number;
  timeoutMs?: number; signal?: AbortSignal; onProgress?: (done: number, current?: string) => void;
  nearTabId?: number }): Promise<Map<string, Uint8Array | Error>>;
// lib/pdf/merge.ts
export interface OutlineItem { title: string; pageIndex: number; children: OutlineItem[] }
export interface PdfMetadata { title: string; author?: string; subject?: string; keywords?: string[]; creator: string; producer?: string }
export function concatPdfs(parts: Uint8Array[], owner?: (name: string) => number | undefined): Promise<{ bytes: Uint8Array; offsets: number[] }>;
// copied pages lose /StructParents (no dangling tagged-PDF references); /Lang of the first part is kept
export function findDestinationPages(pdf: Uint8Array, names: string[]): Promise<Map<string, number>>; // named dest → 0-based page index
/** page id → first sheet of its section: `p-{id}` destinations, falling back to top-level outline titles. Used by the runner. */
export function findSectionStartPages(pdf: Uint8Array, pages: { id: string; title: string }[]): Promise<Map<string, number>>;
export function readOutline(pdf: Uint8Array): Promise<OutlineItem[]>;
export function finalizePdf(base: Uint8Array, o: {
  metadata: PdfMetadata;
  inserts?: { afterPageIndex: number; pdf: Uint8Array }[]; // applied from last to first; -1 = at the start
  outline?: OutlineItem[];         // replaces any existing outline when given
  stampPageNumbers?: { bottomPt?: number; fontSizePt?: number; skipFirst?: number }; // "n / N" when Chrome's footer was off
}): Promise<{ bytes: Uint8Array; pageCount: number }>;
export function buildOutline(pages: PageRef[], startPage: Map<string, number>, headingsOf?: (id: string) => OutlineItem[]): OutlineItem[]; // nested by depth
export function finalizeExport(base: Uint8Array, o: { metadata: PdfMetadata; pages: PageRef[]; excludeIds?: Iterable<string>;
  live?: Map<string, Uint8Array>; stampPageNumbers?: { skipFirst?: number } }): Promise<{ bytes: Uint8Array; pageCount: number; unplacedLive: string[] }>;
// the combined export in one parse: sections, live inserts (untagged), page-tree bookmarks + Chrome's heading bookmarks, numbers, metadata
export function shiftPageIndex(index: number, inserts: { afterPageIndex: number; count: number }[]): number;
// lib/pdf/zip.ts
export function zipFiles(files: { name: string; data: Uint8Array; compress?: boolean }[], signal?: AbortSignal): Promise<Uint8Array>;
// fflate streaming Zip; stored entries unless `compress` (deflate level 6, text); names are relative POSIX paths
// (directories kept, `.`/`..`/empty segments dropped), unique per full path (case-insensitive, `a (2).md`)
// lib/download.ts
export function saveBytes(bytes: Uint8Array, filename: string, mime: string, signal?: AbortSignal): Promise<number>; // downloadId
// Resolves once the download completed (no timeout: a "Save as" dialog may stay open); rejects with
// DownloadInterruptedError (code DOWNLOAD_INTERRUPTED, reason e.g. USER_CANCELED) — the runner reports a
// dismissed "Save as" dialog as `cancelled` — or with an AbortError after cancelling + erasing the download.
// The blob URL is revoked and the offscreen document closed only after a final state; creating/closing the
// offscreen document is serialized, and it is never closed while another save runs.
export function showDownloadItem(downloadId: number | undefined): Promise<boolean>; // checks downloads.search first
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
// lib/job/store.ts — chrome.storage.session persistence: saveJob, loadJob, listJobs, deleteJob, pendingStart get/set/clear,
//   saveCheckpoint/loadCheckpoint (request + compact page list, written once per job, for "Try again" after an interruption)
// lib/job/runner.ts — export function runJob(job: ExportJobState, deps): Promise<void>; the state machine
//   (live render runs BEFORE printing so a failed live page falls back to its static content)
// lib/job/workerOp.ts — runWorkerOp(): starts a background worker operation and awaits its `worker/done`,
//   pinging the tab (a closed tab fails the operation instead of hanging it)
// lib/job/progress.ts — jobPercent(): phase-weighted overall progress (badge, bar, tab title)
// lib/job/manager.ts — start/cancel/get/list/retry, claimPendingStart, preview collections over the UI port (cache,
//   cancel on disconnect), broadcast `job/update` (slim: no page list, no custom CSS), badge text, notifications
// entrypoints/background.ts — wires onMessage (UiToSw), commands, contextMenus (FR-15), permissions.onAdded,
//   startup cleanup (detach stale debuggers, close orphan worker tabs recorded in session storage)
// entrypoints/worker.ts — RPC server (SwToWorker) on top of lib/confluence + lib/assemble
// entrypoints/live.ts — answers SwToLive
// entrypoints/offscreen/ — answers SwToOffscreen
```

### lib/convert (owned by the "converter" agent; runs in the worker tab — real DOM, no network)
```ts
import type { CoverInfo } from '../messages'; import type { PageBody } from '../confluence/client';
export interface ConvertInput {
  pages: { ref: PageRef; body?: PageBody }[];   // export order; link-only refs (folder/whiteboard/database/embed/slides) have no body
  allPages: PageRef[]; excludeIds?: string[];   // same meaning as AssembleInput
  site: SiteInfo; options: ExportOptions;        // options.format is 'markdown' | 'text'
  cover: CoverInfo | null; toc: boolean; generatedBy: string;
  separate: boolean;                             // one file per page
  baseName: string;                              // stem of the combined file, e.g. 'COC_Community Over Code Home_2026-10-06'
}
export interface ConvertedFile { path: string; text: string }   // POSIX relative path, no leading slash
export interface AssetRef { url: string; path: string }         // absolute image URL → relative path in the bundle
export interface ConvertResult { files: ConvertedFile[]; assets: AssetRef[]; placeholders: number }
export function convertPages(doc: Document, input: ConvertInput): ConvertResult;
export function relinkFailedAssets(files: ConvertedFile[], failed: AssetRef[]): ConvertedFile[];
// Combined: '{baseName}.md|.txt'. Separate: '{NN}-{sanitized title}.{ext}' in export order (+ '00-Contents.{ext}'
// with the cover and / or toc). Assets only for markdown + downloadImages: 'assets/{pageId}/{file}', referenced relatively.
// Reuses sanitizePageHtml + replaceUnsupportedContent (FR-9 placeholders become a quote / text line with the link).
// Internal links: combined '#p-{id}' (explicit <a id>), separate: relative file links. Deterministic output.
```

### lib/output, lib/format (owned by the "orchestrator" agent)
```ts
// lib/format.ts (shared, no runtime deps)
export const FORMATS: Record<ExportFormat, { label: string; ext: 'pdf' | 'md' | 'txt'; mime: string }>;
export const PDF_ONLY_OPTIONS: (keyof ExportOptions)[]; // paperSize, orientation, marginsMm, pageNumbers, liveRender, shrinkWideTables, customCss
export function formatOf(o?: Partial<Pick<ExportOptions, 'format'>>): ExportFormat; // unknown → 'pdf'
export function exportButtonLabel(o: Pick<ExportOptions, 'format' | 'separateFiles'>): string;
export function isCompressible(path: string): boolean;   // text entries are deflated in the ZIP
// lib/output/assets.ts (worker tab)
export function downloadAssets(assets: { url: string; path: string }[], o: { concurrency: number; signal?: AbortSignal;
  limits?: Partial<{ timeoutMs: number; maxBytes: number; maxTotalBytes: number }>; onProgress?(done, total, current?): void;
  fetchImpl?: typeof fetch }): Promise<{ ok: { url; path; bytes: Uint8Array }[]; failed: { url; path; reason: string }[] }>;
// credentials 'same-origin' (cookie only to Confluence: Cloud attachments 302 → api.media.atlassian.com, which answers
// `Access-Control-Allow-Origin: *` and would reject a credentialed request), redirect 'follow', referrerPolicy 'no-referrer';
// an HTML answer (login page) or a size cap is a failure; one failure never fails the others; cancel → AbortError.
// lib/output/chunks.ts (pure)
export function readOutputChunks(data: Uint8Array[], index: number, offset: number, maxBytes?: number): ReadOutputResponse; // worker
export function collectOutput(entries: OutputEntry[], read: (index, offset) => Promise<ReadOutputResponse>, signal?): Promise<Uint8Array[]>; // SW
```
Worker RPC (lib/messages.ts): `worker/convert` {jobId, pageIds, allPages, excludeIds, options, cover, toc, separate,
baseName, concurrency} → `{ started: true }`, outcome `worker/done` op `convert`:
`ConvertOpResult { entries: OutputEntry[]; placeholders; failedAssets }` (`OutputEntry { path, size, kind: 'document' | 'asset' }`).
`worker/readOutput` {jobId, index, offset, maxBytes?} → `{ chunks: { index, offset, base64 }[]; next: { index, offset } | null }`.

### UI (owned by the "ui" agent)
`entrypoints/popup/`, `entrypoints/preview/`, `entrypoints/options/`, `components/*`, `assets/ui.css`.
Format (FR-17): a "Format" segmented control (PDF · Markdown · Text) at the top of `OptionsForm` and in the popup
(the popup's choice applies to that export only; defaults come from the settings). In the preview, PDF-only controls
are hidden for Markdown / text (with a hint); on the options page they stay editable under "PDF layout" (they are
the PDF defaults). Markdown adds "Include images (ZIP)"; "One PDF per page (ZIP)" reads "One file per page (ZIP)";
buttons read "Export PDF" / "Export Markdown" / "Export text" ("Export ZIP" with separate files).
Talks to the SW only through `callSw()` from `lib/rpc.ts` and listens for `SwBroadcast`.

## 5. Notes & decisions

- **Why a JSON URL for the worker tab**: same-origin (cookies for API + images), no app JS, no CSP.
  It also works for anonymous visitors of public sites (verified on Cloud and DC, §1b).
- **Section start pages**: every `article.cf-page` has `id="p-{id}"`. Chrome only emits a named
  destination for an id that some `<a href="#id">` in the same printed document targets, so each
  print batch ends with a hidden `div.cf-dests` linking every article (works without a TOC and in
  batches 2+). Sections are located through `p-{id}`, falling back to matching top-level outline
  titles (h1 = page title; cover/TOC use no headings). There is no hidden marker text (Chrome
  embeds ToUnicode maps, so such text leaked into copy/paste, search and text extraction).
- **Outline**: always written by `finalizeExport()` as the page tree (nested by depth; a page that
  is not in the PDF is skipped and its children take its place — the TOC uses the same rule).
  Each page's own bookmarks are the children of its h1 in Chrome's `generateDocumentOutline`
  (demoted content headings), matched by section start sheet and title and shifted past live
  inserts. h6 uses small caps rather than `text-transform: uppercase`, which leaked into titles.
- **Page numbers**: one batch, no live pages and no cover → Chrome's footer template. Otherwise
  (several batches, inserted live pages, or a cover — Chrome's footer cannot skip it) print
  without the footer and stamp "n / N" with `skipFirst: 1` when there is a cover (the cover is
  unnumbered, numbering starts on the TOC). Live pages are then printed with the same
  (footer-sized) margins and `pageNumbers: false`. Geometry is the same either way
  (`effectiveMarginsMm` keeps the footer margin).
- **Cross-batch links** (exports > `printBatchSize` pages): Chrome drops links to ids that are not
  in the printed document, so every batch gets a zero-size `span#p-{id}` for each exported page
  printed elsewhere (not `display:none`: Chrome needs a box). That placeholder also creates a
  `/p-{id}` destination in the wrong batch: `concatPdfs(parts, owner)` resolves every name of the
  form `p-{id}` / `p{id}-…` to the batch that holds page `{id}`. Heading links into another batch
  fall back to the page (`data-cf-fallback`).
- **Live pages** keep their header-only sheet (it carries the `p-{id}` destination, the TOC
  target and the bookmark); the live print hides Confluence's own title and byline so they are not
  repeated. Inserted live pages lose their tagged-PDF back-references.
- **Service-worker lifetime**: Chrome stops an idle SW after ~30 s, and stops it regardless when a
  single event or API call takes longer than 5 minutes. So (1) while a job or a preview collection
  runs, or a cached helper tab waits for its idle close, the manager pings
  `chrome.runtime.getPlatformInfo()` every 20 s; (2) long worker operations never keep one message
  pending: `worker/collect`, `worker/fetch` and `worker/convert` answer `{ started: true }` and report the outcome
  with `worker/done` (`lib/job/workerOp.ts`), and the preview's collection runs over a port, not as
  one pending `runtime.onMessage` request; (3) one `Page.printToPDF` covers at most
  `printBatchSize` ≤ 400 pages.
- **Interrupted jobs**: if Chrome stops the SW anyway, `init()` marks running jobs as failed with
  `interrupted: true`. Their stored checkpoint (request + compact page list) lets "Try again"
  (`job/retry`) start the same export without collecting again. There is no resume of a
  half-finished job (worker tab state and fetched bodies are gone).
- **Job snapshots**: `job/update` broadcasts and `storage.session` hold a slim job (no page list —
  `pageCount` instead — and no custom CSS), so big exports do not fill session storage; `job/get`
  returns the full job while this SW instance knows it.
- **Helper tabs** (worker, live render) are ordinary inactive tabs next to the source tab, not a
  minimized window (Chrome throttles rendering there). Closing one stops the export with "An export
  helper tab was closed, so the export stopped." Their URLs end with `#cfp-worker` / `#cfp-live`, so
  tabs restored after a browser restart are recognized and closed. The preview's cached helper tab
  closes 2 minutes after its last use, or 5 s after the last extension page (UI port) went away.
- **Debugger fallback**: if `DebuggerUnavailableError`, activate the worker tab and call
  `window.print()` there (vector, but needs the print dialog).
- **Permissions**: required `activeTab, scripting, storage, downloads, debugger, notifications,
  contextMenus, offscreen`; `optional_host_permissions: https://*/*, http://*/*` granted per origin.
  No `tabs` permission (not needed: we only read URLs of tabs on granted origins).
  Context menu (`lib/linkPatterns.ts`): Confluence-specific link shapes on any host (`/wiki/…`,
  `*.atlassian.net/wiki/*`, `viewpage.action`) plus the generic shapes (`/display/`, `/x/`,
  `/spaces/`) only on granted origins; rebuilt on install/startup and when grants change. The
  menu never asks for access: on a site without access it opens the preview, whose
  "Allow & export" asks only after showing the site.
- **Privacy**: the extension's own requests are GETs to the Confluence origin being exported; no
  analytics. The worker tab loads the resources the exported pages embed (images, emoji, avatars)
  from wherever they are referenced, which can be other hosts — disclosed in PRIVACY.md; the print
  document sends no referrer.
- **Managed policy** (`public/managed_schema.json`): `blockedSpaceKeys`, `disableLiveRender`,
  `defaultOptions` (incl. `format` and `downloadImages`), `maxPages`. With a block list, a linked page whose space key is unknown
  (pre-fetch and after the fetch) is skipped ("could not be checked against your administrator's
  policy"); same-tree pages inherit the root's (already checked) space. `maxPages + 1` is also the
  linked-mode collection budget, so the limit is reported without collecting far beyond it.
- **Third-party notices**: `public/THIRD_PARTY_LICENSES.txt` (generated by
  `scripts/generate-licenses.mjs`, checked in CI) ships with the extension and is linked from the
  options page.
