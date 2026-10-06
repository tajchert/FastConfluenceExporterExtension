# AGENTS.md — working guide for coding agents

Read this file before changing code. It is the entry point: what the project is, how the code
is laid out, how data flows, how to test cheaply, and the rules that must not be broken.
Deeper references (read only when you need them):

- `docs/ARCHITECTURE.md` — module contracts (exact signatures), Confluence API findings (§1, §1b),
  pipeline steps (§3), design decisions (§5). **Update it when you change a contract.**
- `docs/TESTING.md` — test layers, what each E2E/live test covers, manual QA checklist.
- `docs/ENTERPRISE.md` — managed policy (Chrome/Edge enterprise install).
- `README.md` — short project overview (benefits, speed charts, how it works, tech stack).
- `docs/USER_GUIDE.md` — user-facing features, formats, permissions table, limitations, troubleshooting.
- `store/listing.md`, `store/edge-listing.md`, `PRIVACY.md` — store/legal text (must stay truthful).
- `CHANGELOG.md` — Keep a Changelog format; add an entry for user-visible changes.

---

## 1. What this is (60-second version)

**Fast PDF Export for Confluence** — a Chrome/Edge/Brave **Manifest V3 extension** that exports
Confluence pages to **PDF** (default), **Markdown** or **plain text**, entirely in the browser,
using the user's existing Confluence session (or anonymously on public sites).

- Works with **any** Confluence **Cloud** site (`*.atlassian.net` or custom domain) and
  **Data Center / Server** (REST v1, any context path such as `/confluence`, http intranets).
  Nothing is hard-coded to a particular site.
- Export modes: this page · page + children (depth limit) · folder · pages linked from this page
  (1–2 hops) · manual selection from a page tree · entire space.
- PDF: one combined document with cover, clickable TOC, nested bookmarks, page numbers, links
  between exported pages that jump inside the PDF; or one PDF per page in a ZIP.
  Printing uses `chrome.debugger` → CDP `Page.printToPDF` (vector, selectable text).
- Markdown (GFM via Turndown) / text: converted in a helper tab; Markdown can bundle images in a ZIP.
- No backend, no analytics, read-only (`GET` only). Host access is requested **per origin at
  runtime**; the production manifest has **no** `host_permissions`.

Version: see `package.json` (`1.1.0` at the time of writing). License MIT.

### Tech stack

| Thing | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict), **TS 7** (`typescript@7`, Go-based `tsc`) | `npm run compile` = `tsc --noEmit` |
| Extension framework | **WXT 0.21** (Vite 8 / rolldown) | entrypoints in `entrypoints/`, config `wxt.config.ts` |
| UI | **Preact 11** + hooks, plain CSS (`assets/ui.css`) | JSX via `jsxImportSource: preact` |
| PDF post-processing | `pdf-lib` 1.17 | runs in the service worker |
| HTML sanitizing | `dompurify` 3 | runs in the worker tab |
| ZIP | `fflate` (streaming `Zip`) | runs in the service worker |
| Markdown | `turndown` 7 + `@joplin/turndown-plugin-gfm` | runs in the worker tab (needs DOM) |
| Unit tests | Vitest 5 + happy-dom + `WxtVitest()` fake browser | `tests/unit/` |
| E2E | Playwright 1.63 (bundled Chromium) + local mock Confluence | `tests/e2e/` |
| Live tests | Playwright against two **public** Confluence sites | `tests/live/` (opt-in) |
| APIs | `chrome.*` typed by `@types/chrome` | **Do not use** `browser.*` |

Dependencies are exact-pinned (`npm i -E`). Do not add runtime dependencies casually: every one
ships in the store package, must be MIT/BSD/Apache-compatible and appear in
`public/THIRD_PARTY_LICENSES.txt` (`npm run licenses`; CI checks freshness).

---

## 2. Golden rules (do not break these)

1. **Generic, no company data.** Never hard-code a Confluence host, and never commit content,
   ids, names, screenshots or URLs from a private/company Confluence. The git history was
   rewritten once to remove such data. Test data is synthetic (`acme.atlassian.net`,
   `example.com`, mock fixtures) or comes from the two **public** sites used by the live suite:
   `https://cwiki.apache.org/confluence` (Data Center) and `https://uconn.atlassian.net/wiki`
   (Cloud, space `AI`). Before committing, grep the diff for hosts/emails/paths:
   `git diff --cached | grep -n -i -E 'atlassian\.net|@[a-z0-9-]+\.[a-z]|/Users/'` and check
   anything that is not `acme`/`example`/`uconn`/`cwiki.apache.org`.
2. **Read-only and same-origin.** The extension only issues `GET` requests, only to the Confluence
   origin being exported (plus whatever images the pages embed). No analytics, no remote code, no
   `eval`/`new Function`, no CDN fonts. `PRIVACY.md` and the store listing describe this exactly —
   if behaviour changes, update them.
3. **Production manifest has no `host_permissions`.** Only `optional_host_permissions`
   (`https://*/*`, `http://*/*`) granted per origin at runtime. The `e2e` and `live` build modes
   add test hosts (`wxt.config.ts`); CI verifies the production manifest.
4. **The worker tab runs on the Confluence origin.** Everything inserted into it must go through
   the sanitizer (`lib/assemble/sanitize.ts`, DOMPurify) or be built with DOM APIs /
   `escapeHtml`/`escapeAttr` (`lib/util/escape.ts`). A sanitizer hole = script execution with the
   user's Confluence session. E2E test `(o)` and `tests/e2e/mock-confluence/hostile.mjs` guard this;
   extend them when you touch sanitizing.
5. **One failing page never fails the export.** Per-page problems become `JobError`s
   (`severity: 'skipped' | 'degraded'`); only "nothing exportable", sign-in loss, cancel, or a
   broken pipeline end a job with `error`.
6. **Cancel must be fast and clean**: within ~2 s, no orphan tabs, no attached debugger, pending
   download cancelled. Every long await in the runner is wrapped in `abortable()`.
7. **Service-worker code has no DOM.** No `DOMParser`, `document`, `URL.createObjectURL` in
   `entrypoints/background.ts`, `lib/job/*`, `lib/render/*`, `lib/pdf/*`, `lib/download.ts`.
   DOM work happens in the worker tab (`entrypoints/worker.ts`) or extension pages.
8. **No long-pending messages.** Chrome kills the SW when one event/API call exceeds 5 minutes.
   Long worker operations answer `{started:true}` and report via `worker/done` (`lib/job/workerOp.ts`).
9. **Keep contracts in sync**: `lib/types.ts`, `lib/messages.ts` and `docs/ARCHITECTURE.md` §4.
10. **Politeness to public servers**: live tests stay small (≤ 15 pages per export, API
    concurrency 2, whole suite < 2 minutes), never crawl, never run on every push.

---

## 3. Commands cheat sheet

```bash
npm ci                         # install (postinstall runs `wxt prepare` → .wxt/ types)
npm run dev                    # WXT dev mode: opens a fresh Chrome profile with HMR (you must log in to Confluence there)
npm run build                  # production build → .output/chrome-mv3/
npm run zip                    # store package → .output/confluence-fast-pdf-export-<version>-chrome.zip
npm run zip:edge               # Edge package
npm run compile                # type check (Vitest does NOT type-check — always run this too)
npm test                       # all unit tests (~1–2 s)
npm run test:e2e               # build:e2e + Playwright E2E against the mock (~55 s)
npm run test:live              # build:live + live suite against public sites (~30 s, network)
npm run screenshots            # regenerate store/screenshots/*.png (needs `pdftoppm` from poppler)
npm run icons                  # regenerate public/icons/*.png and store promo images
node scripts/readme-charts.mjs # regenerate README speed charts (docs/images/*.svg) from docs/benchmarks.json
npm run licenses               # regenerate public/THIRD_PARTY_LICENSES.txt
npm run check:release          # placeholders + license freshness (fails until <your-email>/<owner> are filled)
```

### Running only part of the tests

```bash
# Unit (Vitest)
npx vitest run tests/unit/url.test.ts                 # one file
npx vitest run tests/unit/convert-markdown.test.ts -t "code block"   # tests whose name matches
npx vitest run sanitize macros                        # files whose path contains these words
npx vitest tests/unit/runner.test.ts                  # watch one file
npx vitest run --reporter=verbose tests/unit/collect.test.ts

# E2E (Playwright). IMPORTANT: Playwright runs the BUILT extension in .output/chrome-mv3-e2e.
# After changing source, rebuild first or you test stale code:
npm run build:e2e && npx playwright test -g "\(b\)"          # one test by its id prefix
npm run build:e2e && npx playwright test tests/e2e/formats.spec.ts
npx playwright test -g "md2|txt1"                             # several (build already fresh)
HEADED=1 npx playwright test -g "\(a\)"                       # watch the browser
npx playwright show-trace test-results/<test>/trace.zip       # traces are kept on failure

# Live (public sites)
npm run build:live && npx playwright test -c playwright.live.config.ts -g "COC home"
LIVE_SKIP=uconn.atlassian.net npm run test:live               # leave a site out
HEADED=1 npm run test:live

# Mock Confluence on its own (to poke at it with curl or a browser)
node tests/e2e/mock-confluence/server.mjs 8090 cloud          # or: ... 8091 server
```

Typical inner loop for a logic change: edit → `npx vitest run <file>` → `npm run compile`.
For anything touching the pipeline, worker, tabs, printing or UI flows: also
`npm run test:e2e` (or the relevant `-g` subset after `npm run build:e2e`).
Run the live suite when you change Confluence API handling, detection, sanitizing/conversion of
real markup, or image downloads.

### Shell notes

- `sed` in this environment is GNU sed (`sed -i 's/a/b/' file`, no `''` after `-i`).
- Playwright needs its Chromium once: `npx playwright install chromium`.
- `.output/` holds three builds side by side: `chrome-mv3` (prod), `chrome-mv3-e2e`, `chrome-mv3-live`.
- Load the unpacked extension manually: `chrome://extensions` (or `brave://extensions`) →
  Developer mode → Load unpacked → `.output/chrome-mv3`. After a rebuild click the reload icon.

---

## 4. Repository map

```
.
├─ AGENTS.md                      ← this file
├─ README.md / CHANGELOG.md / LICENSE / PRIVACY.md
├─ wxt.config.ts                  manifest (permissions, commands, build modes e2e/live)
├─ vitest.config.ts               happy-dom, WxtVitest(), network loading disabled
├─ playwright.config.ts           E2E: tests/e2e, 1 worker, 120 s timeout
├─ playwright.live.config.ts      live: tests/live, 1 worker, retries 1
├─ tsconfig.json                  extends .wxt/tsconfig.json (generated by `wxt prepare`)
├─ entrypoints/                   one file/dir per extension context (WXT convention)
│  ├─ background.ts               service worker: message routing, commands, context menus, permissions
│  ├─ worker.ts                   unlisted content script /worker.js — runs in the helper ("worker") tab
│  ├─ live.ts                     unlisted content script /live.js — prepares real pages for live render
│  ├─ popup/                      toolbar popup (App.tsx, modes.ts)
│  ├─ preview/                    preview / progress tab (App.tsx, request.ts)
│  ├─ options/                    settings page (App.tsx)
│  └─ offscreen/                  offscreen document: bytes → blob: URL for chrome.downloads
├─ lib/                           all logic (framework-free TS)
│  ├─ types.ts                    domain types + DEFAULT_OPTIONS / DEFAULT_SETTINGS
│  ├─ messages.ts                 message protocol between contexts (typed unions)
│  ├─ rpc.ts                      callSw / callWorker / callOffscreen / respond helpers
│  ├─ settings.ts                 load/save/normalize settings, managed policy overlay
│  ├─ permissions.ts              per-origin host permission helpers
│  ├─ format.ts                   FORMATS (pdf/markdown/text), PDF_ONLY_OPTIONS, labels
│  ├─ errors.ts                   user-facing sign-in / not-public messages
│  ├─ linkPatterns.ts             context-menu URL patterns
│  ├─ download.ts                 saveBytes(): offscreen blob URL + chrome.downloads
│  ├─ confluence/                 Confluence access (runs in the worker tab; detect.ts in the page)
│  │  ├─ url.ts                   URL parsing (Cloud + DC shapes), tiny-link decoding
│  │  ├─ http.ts                  getJson/getText/paginate, retries, 429 back-off, timeouts
│  │  ├─ client.ts                ConfluenceClient interface + createClient + tree helpers
│  │  ├─ cloud.ts                 CloudClient (REST v2, v1/CQL fallbacks)
│  │  ├─ server.ts                ServerClient (Data Center / Server, REST v1)
│  │  ├─ collect.ts               export modes → ordered PageRef[]
│  │  ├─ links.ts                 linked-page extraction (export_view + storage)
│  │  ├─ session.ts               signed in / anonymous / signed out detection
│  │  └─ detect.ts                probePage(): self-contained, injected into the active tab
│  ├─ assemble/                   PDF print document (worker tab, real DOM)
│  │  ├─ sanitize.ts              DOMPurify + Confluence cleanup + link/anchor rewriting
│  │  ├─ macros.ts                live-render detection, FR-9 placeholders
│  │  ├─ document.ts              cover, TOC, page sections, buildPrintCss
│  │  ├─ geometry.ts              paper sizes and margins (shared with SW)
│  │  ├─ assets.ts                waitForAssets(): images + fonts, failed image placeholders
│  │  └─ print.css                print stylesheet (imported with ?inline)
│  ├─ convert/                    Markdown / text conversion (worker tab, inert document)
│  │  ├─ index.ts                 convertPages(), relinkFailedAssets()
│  │  ├─ prepare.ts               shared normalization, links, anchors, asset list
│  │  ├─ markdown.ts              Turndown rules, tidyMarkdown
│  │  ├─ text.ts                  plain-text writer
│  │  ├─ shared.ts                helpers (display width, TOC entries, YAML)
│  │  └─ types.ts                 ConvertInput / ConvertResult
│  ├─ output/                     non-PDF output plumbing
│  │  ├─ assets.ts                downloadAssets() (worker tab)
│  │  └─ chunks.ts                chunked transfer worker → SW (readOutput)
│  ├─ render/                     printing (service worker)
│  │  ├─ cdp.ts                   chrome.debugger + Page.printToPDF, print sessions
│  │  ├─ tabs.ts                  helper tabs: open/inject/ping/close, orphan cleanup
│  │  └─ liveRender.ts            FR-10: print real page URLs
│  ├─ pdf/                        pdf-lib post-processing (service worker)
│  │  ├─ merge.ts                 concat, destinations, outline, inserts, page numbers, metadata
│  │  └─ zip.ts                   fflate streaming ZIP
│  ├─ job/                        export orchestration (service worker)
│  │  ├─ runner.ts                the state machine runJob(job, deps) — dependency-injected
│  │  ├─ manager.ts               job registry, buildDeps, broadcasts, badge, notifications, preview collections
│  │  ├─ store.ts                 chrome.storage.session persistence, pendingStart, checkpoints
│  │  ├─ workerOp.ts              runWorkerOp(): start background op, await worker/done
│  │  └─ progress.ts              jobPercent()
│  └─ util/                       pool, abort, base64, filename, escape
├─ components/                    shared Preact components + pure UI logic (logic.ts)
├─ assets/ui.css                  UI styles (CSS variables, dark mode)
├─ public/                        copied verbatim into the build
│  ├─ _locales/en/messages.json   manifest strings (name, description, command, context menu)
│  ├─ managed_schema.json         enterprise policy schema
│  ├─ icons/                      16/32/48/128 PNG + icon.svg
│  └─ THIRD_PARTY_LICENSES.txt    generated
├─ tests/
│  ├─ unit/                       Vitest, one file per module; fixtures/ (synthetic + public-site excerpts)
│  ├─ e2e/                        Playwright specs, harness (fixtures.ts, pdf.ts), mock-confluence/
│  └─ live/                       Playwright specs against public sites + fixtures.ts
├─ scripts/                       icons, licenses, release check, store screenshots, experiments/
├─ store/                         Web Store / Edge listing text, promo images, screenshots/
├─ docs/                          ARCHITECTURE.md, TESTING.md, ENTERPRISE.md
└─ .github/workflows/             ci.yml (compile, unit, build, manifest check, zip, audit, e2e), live.yml (weekly/manual)
```

Approximate sizes (lines): runner 820, manager 850, worker 540, cloud client 620, collect 550,
sanitize 600, document 660, print.css 1300, merge 690, markdown 750, prepare 660, text 530,
ui.css 1300. Big files are organized with `// ─── section ───` banner comments; search for them.

---

## 5. Execution contexts and how they talk

```
 ┌──────────────┐  UiToSw (runtime.sendMessage)   ┌────────────────────┐  SwToWorker (tabs.sendMessage)  ┌──────────────────────┐
 │ popup /      │ ─────────────────────────────▶ │ service worker     │ ──────────────────────────────▶ │ worker tab            │
 │ preview /    │ ◀───────────────────────────── │ background.ts      │ ◀────────────────────────────── │ (Confluence origin,   │
 │ options      │  SwBroadcast job/update        │ lib/job/*          │  WorkerToSw progress/done       │  JSON URL, worker.js) │
 │ (ext pages)  │  UI port 'cfp-ui' (collect)    │ lib/render, lib/pdf│                                 │ lib/confluence,       │
 └──────────────┘                                └────────────────────┘                                 │ lib/assemble, convert │
        │ executeScript({func: probePage})          │          │  SwToLive                             └──────────────────────┘
        ▼                                           │          ▼
 ┌──────────────┐                          SwToOffscreen  ┌──────────────────────┐
 │ active tab   │                                   ▼     │ live-render tabs      │
 │ (Confluence) │                        ┌──────────────┐ │ (real page, live.js)  │
 └──────────────┘                        │ offscreen.html│ └──────────────────────┘
                                         │ blob: URLs    │
                                         └──────────────┘
```

| Context | Entry | Has DOM? | Responsibilities |
|---|---|---|---|
| Service worker | `entrypoints/background.ts` | **No** | Routes UI messages to `lib/job/manager.ts`; keyboard command `export-current-page`; context menus; `permissions.onAdded` → pending start; startup cleanup (`detachAll`, `closeOrphanTabs`); notifications. Runs `runJob` (printing via debugger, pdf-lib, zip, downloads). |
| Worker tab | `entrypoints/worker.ts` → `/worker.js` | Yes (real tab) | Inactive tab opened on a JSON API URL of the Confluence site (`workerTabUrl(site)` + `#cfp-worker`): same-origin cookies, no Confluence JS, no CSP. Makes **all** Confluence API calls, keeps page bodies in memory, assembles the print document into its own DOM (the SW then prints this tab), converts to Markdown/text, downloads Markdown images. |
| Live-render tabs | `entrypoints/live.ts` → `/live.js` | Yes | Real page URL + `#cfp-live`; expands macros, hides Confluence chrome, waits for diagrams; SW prints it. |
| Popup | `entrypoints/popup/` | Yes | Probes the active tab with `chrome.scripting.executeScript({ func: probePage })` (works via `activeTab`, before any host permission); mode/format picker; asks for site access; starts "This page" or opens the preview. |
| Preview tab | `entrypoints/preview/` (`preview.html?req=<base64url JSON>` or `?job=<id>`) | Yes | Tree picker, page list with pruning, options, large-export guard, progress/cancel/results. |
| Options | `entrypoints/options/` | Yes | Settings, site access list, policy notice, about. |
| Offscreen | `entrypoints/offscreen/` | Yes | Assembles base64 chunks into a `Blob` and returns a `blob:` URL (the SW cannot create one). |

### Message protocol (`lib/messages.ts`)

All request messages are answered with `RpcResult<T>` = `{ok:true,value}` | `{ok:false,error,code?}`.
Use the helpers in `lib/rpc.ts`:

```ts
// extension page → SW
const { jobId } = await callSw({ type: 'job/start', request, pages });
// SW → worker tab
const res = await callWorker(tabId, { type: 'worker/assemble', ... });
// listener side (returns true = async response)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => respond(sendResponse, () => handle(msg)));
```

| Union | Direction | Members |
|---|---|---|
| `UiToSw` | page → SW | `tree/children`, `job/start`, `job/claimPending`, `job/retry`, `job/cancel`, `job/get`, `job/list`, `preview/open` |
| `UiPortRequest` / `UiPortEvent` | page ↔ SW over port `UI_PORT_NAME = 'cfp-ui'` | `collect/start`, `collect/cancel` / `collect/progress`, `collect/done`, `collect/failed` (client: `components/collectClient.ts`) |
| `SwBroadcast` | SW → pages | `job/update` (slim job: no page list, no custom CSS) |
| `SwToWorker` | SW → worker tab | `worker/ping`, `worker/collect`*, `worker/children`, `worker/fetch`*, `worker/assemble`, `worker/convert`*, `worker/readOutput`, `worker/space`, `worker/resolve`, `worker/cancel`, `worker/dispose` (* = background op, answers `{started:true}`) |
| `WorkerToSw` | worker → SW | `worker/progress`, `worker/throttled`, `worker/done` (op result/error), `worker/ready` |
| `SwToLive` | SW → live tab | `live/prepare` |
| `SwToOffscreen` | SW → offscreen | `blob/begin`, `blob/chunk`, `blob/end`, `blob/revoke` (all carry `target: 'offscreen'`) |
| `ProbeResult` | probe return value | `{isConfluence:false,url}` or `PageContext & {isConfluence:true}` |

Listener rules (bugs were found here before):
- Return `true` **only** when you will call `sendResponse` asynchronously (`respond()` does this).
  Return `false` for messages that are not yours (offscreen ignores everything without
  `target: 'offscreen'`; the worker ignores unknown types and anything from a tab).
- Validate senders: background accepts UI messages only from extension pages
  (`isExtensionPage(sender)`), worker progress only from tabs; the worker accepts only
  `sender.id === chrome.runtime.id && !sender.tab` (`entrypoints/worker.ts`, bottom).
- `chrome.runtime.sendMessage` broadcasts reject with "Receiving end does not exist" when no page
  is open — always `.catch(() => undefined)` for fire-and-forget notifications.
- New message type checklist: add to the union **and** the `…Responses` map in `messages.ts`,
  handle it in the receiver's `switch` (worker also has a `REQUEST_TYPES` set), use
  `callSw`/`callWorker` on the sender side, update `docs/ARCHITECTURE.md`.

---

## 6. Core data model (`lib/types.ts`)

```ts
SiteInfo        { origin, baseUrl, contextPath, flavour: 'cloud'|'server', siteTitle? }
                // Cloud: baseUrl = https://x.atlassian.net/wiki ; DC: https://host[/confluence]
ContentType     'page'|'blogpost'|'folder'|'whiteboard'|'database'|'embed'|'slides'
                // folder = TOC section header; whiteboard/database/embed/slides = link-only
PageContext     what the popup probe found (site, kind, id, spaceKey, title, lastUpdated, user)
PageRef         { id, type, title, spaceKey?, parentId?, depth, url, reason, breadcrumb?, position?, status? }
                // depth relative to export root (root = 0); reason 'root'|'descendant'|'linked'|'selected'
FetchedPageInfo per-page fetch outcome (ok, error, httpStatus, version, lastModified, author, needsLiveRender…)
ExportFormat    'pdf'|'markdown'|'text'
ExportOptions   { format, downloadImages, paperSize, orientation, marginsMm, includeCover, includeToc,
                  includePageMeta, includeComments, pageNumbers, liveRender, separateFiles,
                  includeArchived, shrinkWideTables, customCss }
Settings        { defaults: ExportOptions, apiConcurrency, liveRenderConcurrency, liveRenderMacros,
                  printBatchSize, warnPageCount, confirmPageCount, notifyOnComplete }
ManagedPolicy   { blockedSpaceKeys?, disableLiveRender?, defaultOptions?, maxPages? }
ExportMode      'current'|'subtree'|'folder'|'linked'|'selection'|'space'
ExportRequest   { site, mode, root:{id,type,title?,spaceKey?,spaceId?}, depth?, linkDepth?, selectedIds?,
                  options, sourceTabId?, userDisplayName? }
JobStatus       'collecting'|'fetching'|'rendering'|'merging'|'done'|'cancelled'|'error'
JobError        { pageId, title, message, severity: 'skipped'|'degraded'|'fatal' }
ExportJobState  { id, request, pages, pageCount?, status, message?, progress, errors, throttled?, result?, … }
TreeNode        lazy tree node for the selection picker
```

`DEFAULT_OPTIONS` and `DEFAULT_SETTINGS` live at the bottom of `lib/types.ts`. Settings are
validated by `normalizeOptions()` / `normalizeSettings()` / `normalizePolicy()` in
`lib/settings.ts` — **every** stored or policy value goes through them (unknown values fall back
to defaults, numbers are clamped).

Other important shapes:
- `PageBody` (`lib/confluence/client.ts`): `{ id, type, title, spaceKey, html /* export_view */,
  version, lastModified, authorDisplayName, breadcrumb[], url, status }`.
- `CoverInfo`, `OutputEntry`, `ConvertOpResult`, `ReadOutputResponse` (`lib/messages.ts`).
- `ConvertInput` / `ConvertResult` (`lib/convert/types.ts`).
- `RunnerDeps` (`lib/job/runner.ts`): everything the runner needs, injected (see §9).

---

## 7. The export pipeline end to end

### 7.1 Entry points that start an export

| Trigger | Code path |
|---|---|
| Popup "This page" + Export | `entrypoints/popup/App.tsx` → `requestSiteAccess` if needed (with `pendingStart`) → `callSw({type:'job/start'})` |
| Popup multi-page mode | `callSw({type:'preview/open', request})` → preview tab collects and starts |
| Preview Export | `entrypoints/preview/App.tsx` → `job/start` with the pruned `pages` |
| Keyboard `Alt+Shift+P` | `background.ts` `exportActiveTab()` → `probeTab()` → `startOrPreview()` |
| Context menu on a link | `background.ts` `handleContextClick()` → `exportLink()` (never prompts; opens preview if no access) |
| Permission granted while popup closed | `permissions.onAdded` → `onPermissionsAdded()` → `manager.claimPendingStart()` (exactly once, keyed by `createdAt`) |
| "Try again" after interruption | `job/retry` → `manager.retryJob()` (uses the stored checkpoint) |

All roads lead to `manager.startJob(request, pages?)` (`lib/job/manager.ts`) which creates the
job state, persists it, builds `RunnerDeps` with `buildDeps()` and calls `runJob()`.

### 7.2 `runJob` stages (`lib/job/runner.ts`)

1. **collecting** — open the worker tab (`deps.openWorkerTab`, or reuse the preview's idle helper
   tab), then `worker/collect` (skipped for `current`: `currentPageRef(request)`), or use the
   `pages` passed in from the preview. Apply policy: `applyPolicyToPages()` (blocked spaces →
   `skipped` errors), `maxPagesError()`.
2. **fetching** — `worker/fetch` (background op): the worker fetches every body with a pool of
   `settings.apiConcurrency`, records `FetchedPageInfo` and live-render flags. Progress arrives as
   `worker/progress`; throttling as `worker/throttled` ("Throttled by Confluence, retrying in N s…").
3. Branch on `formatOf(options)`:
   - **PDF**
     1. **Live render** (if requested and pages flagged, *before* printing so failures fall back
        to static content) → `deps.liveRenderPages()`.
     2. **rendering** — batches of `settings.printBatchSize` (≤ 400): `worker/assemble` builds the
        document into the worker tab, then `printSession.print(params)`. One debugger session per
        job (`createPrintSession`). If the debugger is unavailable → `fallbackPrint()` (system print
        dialog) and the job ends `done` with a message.
     3. `separateFiles`: each content page assembled and printed alone → ZIP (or a single PDF when
        only one page).
     4. **merging** — `concatPdfs()` then `finalizeExport()` (sections via `p-{id}` destinations,
        live inserts, bookmarks, page-number stamping, metadata).
   - **Markdown / text**: `worker/convert` (background op) → `collectOutput()` pulls the files with
     `worker/readOutput` (≤ 8 MiB base64 per answer) → single file saved as is, otherwise
     `zipFiles()` (text deflated, images stored). **No debugger is attached.**
4. **Save** — `deps.saveBytes()` (`lib/download.ts`): offscreen blob URL + `chrome.downloads`
   (no `saveAs` → respects Chrome's "Ask where to save"); waits for a final state; a dismissed
   "Save as" ends as `cancelled`.
5. `finally`: close worker/live tabs, `worker/dispose`, detach debugger, update badge, notify.

Filenames: `buildFilename({ spaceKey, title, date, ext })` (`lib/util/filename.ts`) →
`{SPACE}_{Title}_{YYYY-MM-DD}.{pdf|zip|md|txt}` (local date, Windows-safe, ≤ 150 chars).

PDF metadata: Title = root title, Author = user display name (if known), Subject =
`Confluence export: {space} – {n} pages`, Creator = `Fast PDF Export for Confluence v{version}`
(`PRODUCT_NAME` in `runner.ts`).

### 7.3 Job state, progress and the UI

- `manager.ts` keeps an in-memory registry and persists **slim** snapshots to
  `chrome.storage.session` (`lib/job/store.ts`, `job:{id}`, last 10 jobs) and broadcasts
  `job/update` (throttled). `job/get` returns the full job while this SW instance knows it.
- Overall percent: `jobPercent()` (`lib/job/progress.ts`) — phase-weighted; used by the badge,
  progress bar and tab title.
- UI hook: `useJob(jobId)` in `components/hooks.ts` (listens to broadcasts + polls `job/get`).
  Rendering: `components/JobProgress.tsx` (status, bar, errors table, actions).
- Status texts for the UI: `statusLabel()`, `progressCount()` in `components/logic.ts`.

### 7.4 Cancellation

`manager.cancelJob(id)` aborts the job's `AbortController`. The runner checks the signal between
steps and wraps every awaited call in `abortable(p, signal)`; it sends `worker/cancel`, closes
tabs, the print session detaches, `saveBytes` cancels + erases a pending download. E2E `(f)`,
`(f2)` assert < 2.5 s and no leftovers. When adding a step, make it abortable.

### 7.5 Service-worker lifetime

- Chrome stops an idle SW after ~30 s: while jobs/collections run, the manager pings
  `chrome.runtime.getPlatformInfo()` every 20 s (keepalive section in `manager.ts`).
- Long worker operations are background ops (`runWorkerOp()` in `lib/job/workerOp.ts`): the
  request returns immediately, the result comes as `worker/done`; the SW pings the tab every
  `LIVENESS_PING_MS` so a closed tab fails the op instead of hanging.
- If the SW dies anyway, `manager.init()` marks running jobs `interrupted`; "Try again" restarts
  from the checkpoint (request + compact page list).
- Listeners in `background.ts` are registered synchronously inside `defineBackground(() => …)`.
  Never register them after an `await`.

---

### 7.6 Worked trace: "This page" → PDF (follow these calls when debugging)

1. `entrypoints/popup/App.tsx` mounts → `chrome.tabs.query({active:true,currentWindow:true})` →
   `chrome.scripting.executeScript({ target:{tabId}, func: probePage })` →
   `ProbeResult` (`lib/confluence/detect.ts`).
2. User clicks Export → `buildRequest(ctx, {mode:'current', …})` (`popup/modes.ts`) →
   `hasSiteAccess(origin)` (checked on mount); if missing, the click handler writes
   `chrome.storage.session.set({ pendingStart })` (not awaited) and then calls
   `requestSiteAccess(origin)` **synchronously in the click handler**; after the grant it sends
   `job/claimPending` (or the SW's `permissions.onAdded` claims it if the popup closed).
3. `callSw({ type: 'job/start', request })` → `background.ts` `handleUi()` → `manager.startJob()`
   → job state saved (`store.saveJob`) → `runJob(job, buildDeps(...))`.
4. Runner: `deps.openWorkerTab(site, sourceTabId, signal)` (`lib/render/tabs.ts`) → tab on
   `https://<site>/wiki/api/v2/spaces?limit=1#cfp-worker` → inject `/worker.js` → `worker/ping`.
5. `currentPageRef(request)` (no collection) → `worker/fetch` via `runWorkerOp` → worker
   `handleFetch()` → `client.getPageBody(id, 'page')` (Cloud: one v2 export_view request) →
   `worker/done {op:'fetch', result:{results:[FetchedPageInfo]}}`.
6. `worker/assemble` → worker `handleAssemble()` → `buildPrintDocument(document, {...})` →
   `waitForAssets(document)` → answers `{imageFailures, pageIds}`.
7. `deps.printSession(tabId)` → `createPrintSession` → `Page.printToPDF` stream → bytes.
8. `concatPdfs([bytes])` → `finalizeExport(base, {metadata, pages, stampPageNumbers?})`.
9. `buildFilename({spaceKey, title, ext:'pdf'})` → `deps.saveBytes(bytes, filename,
   'application/pdf', signal)` → offscreen `blob/begin|chunk|end` → `chrome.downloads.download`.
10. `finally`: `worker/dispose`, `closeTabQuietly(workerTabId)`, print session `close()`
    (detach) → status `done`, `result { filename, downloadId, bytes, pageCount }` → broadcast
    `job/update` → popup shows "Saved …", notification if enabled.

For Markdown/text, steps 6–8 become `worker/convert` (background op) → `collectOutput()` with
`worker/readOutput` → `zipFiles` or a single file → `saveBytes(…, 'text/markdown;charset=utf-8')`.
For multi-page modes the popup opens `preview.html?req=…`, which collects over the UI port
(`collectPages()` → `manager.handleUiPort` → `collectForPreview` → `worker/collect`) and then
sends `job/start` with the pruned `pages`.

## 8. Module guide

### 8.1 `lib/confluence/` — talking to Confluence (worker tab)

- **`createClient(site, http?)`** (`client.ts`) returns `CloudClient` or `ServerClient` by
  `site.flavour`. Interface `ConfluenceClient`: `getContent`, `getChildren`, `getDescendants`,
  `getSpace`, `getSpaceRoots`, `getPageBody`, `getStorageBody`, `findPageByTitle`,
  `getCurrentUser`.
- **Cloud (`cloud.ts`)** uses REST v2: `/api/v2/pages/{id}?body-format=export_view` (one request
  per page), `direct-children`, `descendants` (max depth 5 per call → recurse), folders,
  whiteboards/databases/embeds, `spaces?keys=`, `spaces/{id}/pages?depth=root`, v1/CQL fallbacks
  (`/rest/api/search?cql=`). v2 has no space key / author name → cached lookups
  (`spaces/{id}`, `/rest/api/user?accountId=` — stops after the first 403, anonymous sites hide
  profiles). Type discovery for an unknown id tries pages → v1 content → other v2 types.
- **Data Center (`server.ts`)** uses REST v1: `/rest/api/content/{id}?expand=body.export_view,version,space,ancestors,history`,
  `/rest/api/content/{id}/child/page?expand=extensions.position,childTypes.page`,
  `/rest/api/space/{KEY}?expand=homepage`, `/rest/api/space/{KEY}/content/page?depth=root`.
  Children inherit the parent's space (no `expand=space`). Sibling order: `extensions.position`
  (may be `"none"`) then title. No folders on DC.
- **Tree order**: never trust API order. `buildTreeOrder()` rebuilds parent→children and sorts by
  `compareSiblings()` (position, then title), then DFS pre-order.
- **`http.ts`**: `getJson`/`getText` — `credentials: 'include'`, `Accept: application/json`,
  retries 429/502/503/504 (Retry-After seconds or HTTP-date, exponential back-off + jitter,
  max 3), per-attempt timeout (60 s headers / 180 s body), a 200 HTML answer (login page) →
  `HttpError(401)`, network failure → `HttpError(0)`. `paginate()` follows v2 `_links.next`
  (may include the context path) and v1 `start/limit`; loop-protected. `onThrottle` callback
  feeds the "Throttled…" UI.
- **Caching rule**: per-client caches store only successful or definitive (403/404) answers; a
  transient failure is evicted. The worker also keeps a bounded LRU of page bodies shared by the
  preview's collection and the export's fetch (`withBodyCache` in `worker.ts`).
- **`collect.ts`** — `collect(client, request, opts)` per mode:
  `current` → `[root]`; `subtree` → root + descendants (depth limit); `folder` → folder as depth-0
  section header + descendants; `space` → space roots + descendants (homepage first);
  `linked` → BFS by hop (1|2), visited set, title→id resolution, same-site only, budget
  `maxItems` (default `DEFAULT_LINKED_BUDGET = 2000`); `selection` → selected ids in tree order.
  Archived excluded unless `includeArchived`, drafts always excluded. Dedup by id, first wins.
  A failed sub-listing skips that branch with a warning instead of failing the whole collection.
- **`links.ts`** — `extractLinksFromExportView()` (uses `data-linked-resource-id`, URL parsing,
  tiny links, `/display/KEY/Title`, space links) and `extractLinksFromStorage()` (`ri:page`).
  Ignores same page, attachments, Jira `/browse/`, people, external, mailto.
- **`url.ts`** — `parseConfluenceUrl(url, contextPath?)` handles Cloud `/wiki/spaces/KEY/pages/ID/…`,
  `edit-v2`, folders, whiteboards, databases, embeds, blogs, `overview`, `/x/CODE`,
  `tinyurl.action?urlIdentifier=`, `viewpage.action?pageId=` and DC `/display/KEY/Title`,
  `/display/~user/Title`, context paths. `decodeTinyCode('phDOEg') === '315494566'`
  (base64url, little-endian). `contentUrl(site, ref)` builds canonical URLs.
- **`session.ts`** — `readSession(baseUrl)` → `'user'|'anonymous'|'signed-out'|'unreachable'`
  via `/rest/api/user/current`. Anonymous is a valid session (public sites). A 401/network
  failure (and 403/404 for a job that started signed in) triggers one session check; only a
  change signed-in → anonymous/login aborts with `SESSION_EXPIRED_MESSAGE`; anonymous jobs get
  "This page isn't public" per page (`lib/errors.ts`).
- **`detect.ts`** — `probePage()` is injected with `executeScript({ func: probePage })`.
  **It must be 100% self-contained**: no imports used at runtime, no module-level helpers
  (Chrome serializes only the function source). `tests/unit/detect.test.ts` rebuilds it from
  its source text to prove this — keep that test passing. It never throws; it returns
  `{isConfluence:false}` for other pages. Flavour: `ajs-cloud-id` meta → `*.atlassian.net` →
  DC version meta → v2 probe. Trusts `location.href` over meta tags (Cloud SPA metas go stale).

Confluence quirks worth knowing (details in `docs/ARCHITECTURE.md` §1/§1b):
- export_view images are absolute same-origin `/download/attachments/{pageId}/{file}`; on Cloud
  they redirect to `api.media.atlassian.com` (works anonymously, rejects credentialed CORS).
- Heading ids in export_view collide across pages → sanitizer prefixes them `p{pageId}-…`.
- Cloud cross-page heading links use editor-style fragments → matched loosely.
- No `data-macro-name` in export_view on real sites → live-render detection also uses classes
  and the storage format.
- DC answers 404 (not 403) for content an anonymous visitor can't see.
- v1 on Cloud is deprecated (warning headers) but works; prefer v2 on Cloud.

### 8.2 `lib/assemble/` — the PDF print document (worker tab)

- `buildPrintDocument(doc, input: AssembleInput)` (`document.ts`) replaces `<head>`/`<body>`:
  `<meta name="referrer" content="no-referrer">`, `<style>` from `buildPrintCss(options)`,
  `section.cf-cover`, `nav.cf-toc` (divs + links, **no headings** so the outline lists pages
  only), then `article.cf-page#p-{id}` per page with `header.cf-page-meta` (h1 title, breadcrumb,
  last updated, author, "Open in Confluence") and the sanitized body. Link-only types get a
  header + link; live pages get `div.cf-live-slot`. Every batch ends with hidden
  `div.cf-dests` links to every article (so Chrome emits `p-{id}` named destinations) and
  zero-size `span.cf-xbatch#p-{id}` for pages printed in other batches.
- `sanitizePageHtml(html, ctx)` (`sanitize.ts`): `replaceUnsupportedContent` (iframes, embeds,
  app macros → FR-9 placeholders) → DOMPurify → Confluence cleanup (UI chrome, AUI `.hidden`,
  spinners, expand controls; DC 9 expand titles live inside a `<button>` that must be unwrapped
  first) → prefix ids and same-page anchors with `p{pageId}-` → rewrite links to exported pages to
  `#p-{id}` (by id, by `PageIndex` title/URL for `/display/` links) → absolutize URLs → demote
  headings (h1→h2…) → drop `loading=lazy`, `srcset` → unwrap inline-comment markers unless
  `includeComments`. View-file macro preview links → `/download/attachments/…`.
- `macros.ts`: `detectLiveRenderMacros(exportHtml, storageHtml, names)` (configurable list in
  settings), `replaceUnsupportedContent(root, {pageUrl})`, `createPlaceholder(doc, spec)`.
- `assets.ts`: `waitForAssets(doc, timeoutMs=15000)` — waits for images (`decode()`), replaces
  failures with a filename placeholder box, waits for `document.fonts.ready`, then
  `refreshLayoutMarks()` (wide tables `cf-wide`/`cf-wide-xl`/`cf-fixed`, keep-together blocks).
- `geometry.ts`: `paperSizeMm()`, `effectiveMarginsMm()` (bottom margin raised to
  `FOOTER_MIN_MARGIN_MM = 12` when page numbers are on) — shared with `toPrintParams` and the
  live-render `@page` rule so all sheets share one geometry.
- `print.css`: all styling of Confluence constructs (panels, tables with repeated headers, code,
  status lozenges, task lists, layouts, Jira tables, cover, TOC, placeholders, legacy colours).
  Imported as a string: `import printCss from './print.css?inline'`. User custom CSS is appended
  last. Use print-safe CSS (no web fonts; `-webkit-print-color-adjust: exact` is set).

### 8.3 `lib/render/` + `lib/pdf/` — printing and post-processing (service worker)

- `cdp.ts`: `createPrintSession(tabId, signal)` attaches `chrome.debugger` (protocol 1.3) once,
  `print(params)` → `Page.printToPDF` with `preferCSSPageSize`, `printBackground`,
  `transferMode: 'ReturnAsStream'`, `generateDocumentOutline`, `generateTaggedPDF` (retried
  without the experimental flags if Chrome rejects them) → `IO.read` loop → `IO.close`;
  `close()` detaches. `DebuggerUnavailableError` when attach is blocked. `detachAll()` for
  cleanup. `toPrintParams(options)` converts mm → inches, footer template `PAGE_NUMBER_FOOTER`.
  Chrome shows the "started debugging this browser" bar while attached — keep sessions short.
- `tabs.ts`: `openWorkerTab(site, nearTabId, signal)` = `openBackgroundTab` (inactive, next to the
  source tab) → `waitForTabComplete` (listener **plus** polling `tabs.get`, a fast page's
  `complete` can be missed) → `executeScript({files:['/worker.js']})` → `ensureWorker` ping.
  Login pages are detected (`LoginRequiredError`). Helper tab URLs end with `#cfp-worker` /
  `#cfp-live` so `closeOrphanTabs()` can find them after a restart. `workerTabUrl(site)`: Cloud
  `{base}/api/v2/spaces?limit=1`, DC `{base}/rest/api/space?limit=1`.
- `liveRender.ts`: `liveRenderPages(pages, opts)` — pool of tabs on real page URLs, inject
  `/live.js`, `live/prepare`, print, close; returns `Map<id, bytes | Error>` (never throws per page).
- `merge.ts` (pdf-lib): `concatPdfs(parts, owner)` (resolves duplicate `p-{id}` names to the
  owning batch), `findDestinationPages`, `findSectionStartPages` (dests, fallback outline titles),
  `readOutline`, `buildOutline` (page tree nested by depth, each page's heading bookmarks from
  Chrome's outline), `finalizePdf`, `finalizeExport` (one parse: sections, live inserts,
  bookmarks, page numbers with `skipFirst` for the cover, metadata), `shiftPageIndex`.
  Fixture PDFs from real Chrome are in `tests/unit/fixtures/chrome-*.pdf`
  (regenerate with `scripts/experiments/make-pdf-fixtures.mjs`).
- `zip.ts`: `zipFiles(entries, signal)` — fflate streaming `Zip`, `compress` per entry, safe
  relative POSIX names (no `..`, unique case-insensitively: `a (2).md`).
- `lib/download.ts`: `saveBytes(bytes, filename, mime, signal)` and `showDownloadItem(id)`;
  offscreen document creation/closing is serialized; blob URL revoked only after a final state.

Page numbers: one batch, no live pages, no cover → Chrome's footer template. Otherwise print
without footer and stamp "n / N" with pdf-lib (`skipFirst: 1` when there is a cover).

### 8.4 `lib/convert/` + `lib/output/` — Markdown and text (worker tab)

- `convertPages(doc, input)` (`index.ts`) → `{ files, assets, placeholders }`. The worker passes
  an **inert** document (`document.implementation.createHTMLDocument('cfp-convert')`) so nothing
  loads (images were otherwise fetched twice). No network in the converter; deterministic output.
- `prepare.ts` (`preparePages`) reuses `sanitizePageHtml` + `replaceUnsupportedContent`, then
  normalizes Confluence markup for conversion (code language from `data-syntaxhighlighter-params`
  / `language-*`, panels, expands, status, task lists, merges adjacent inline tags, strikethrough
  spans → `<s>`), resolves internal links (combined: `#p-{id}` with `<a id>`; separate: relative
  file links) and builds the asset list (only images on the Confluence origin; icons ≤ 24 px and
  avatars become alt text).
- `markdown.ts`: Turndown with custom rules (fences longer than any backtick run inside,
  `**Info:**` blockquote panels, `<details>` expands, GFM tables only for simple tables else
  cleaned HTML, `cfStrong`/`cfEmphasis` that fall back to `<strong>`/`<em>` when delimiters
  would not parse), `escapeMarkdown`, `tidyMarkdown` (fences, blank lines, `<!-- -->` between
  adjacent lists).
- `text.ts`: `writeText` — `=`/`-` underlined titles, aligned table columns (by display width,
  fallback ` | ` rows with a header rule), 4-space indented code, `[Note]` panels, `~~strike~~`,
  `[Image: name]`, 72-`=` page separators.
- Output naming: combined `{baseName}.md|.txt`; separate `NN-{title}.{ext}` in export order plus
  `00-Contents.{ext}` (cover/TOC); assets `assets/{pageId}/{file}`.
- `relinkFailedAssets(files, failed)` swaps relative refs back to absolute URLs.
- `lib/output/assets.ts` `downloadAssets()` — same-origin credentials only, redirects followed,
  `no-referrer`, `allowedOrigin` guard, 60 s / 25 MB per image, 300 MB total; failures are
  reported once as a `degraded` "Images" error.
- `lib/output/chunks.ts` — `readOutputChunks()` (worker) / `collectOutput()` (SW).
- `lib/format.ts` — `FORMATS` (label, ext, mime), `PDF_ONLY_OPTIONS`, `formatOf()`,
  `isTextFormat()`, `exportButtonLabel()`, `convertingMessage()`, `isCompressible()`.

### 8.5 `lib/job/` — orchestration (service worker)

- `runner.ts` — `runJob(job, deps)`; pure helpers exported for tests/manager:
  `currentPageRef`, `applyPolicyToPages`, `maxPagesError`, `isBlockedSpace`,
  `isUnverifiableSpace`, `destinationPageId`, `isLinkOnly`. Messages: `PRODUCT_NAME`,
  `BLOCKED_MESSAGE`, `UNVERIFIED_SPACE_MESSAGE`, `SAVING_MESSAGE`.
- `manager.ts` — `init`, `startJob`, `cancelJob`, `retryJob`, `getJob`, `listJobs`,
  `claimPendingStart`, `handleWorkerMessage`, `handleUiPort` (preview collections over the port,
  cached 90 s, cancelled on disconnect), `treeChildren`, `resolveContentUrl`, `openPreview`,
  `openJobPage`, `previewUrl`, `handleNotificationClick`, keepalive, badge, `buildDeps()` (the
  real `RunnerDeps`). Preview helper tab per site/profile, closed 2 min after last use or 5 s
  after the last UI port closes.
- `store.ts` — session-storage persistence: `saveJob/loadJob/listJobs/deleteJob/pruneJobs`,
  `set/get/take/clearPendingStart` (TTL `PENDING_START_TTL_MS = 90 s`), `save/load/deleteCheckpoint`.

### 8.6 Settings, policy, permissions

- `lib/settings.ts`: `loadSettings()` = `DEFAULT_SETTINGS` ⊕ `chrome.storage.sync['settings']` ⊕
  managed policy (`chrome.storage.managed`, schema `public/managed_schema.json`; throws when no
  policy → caught). `saveSettings`, `onSettingsChanged`, `applyPolicyToOptions`,
  `MAX_PRINT_BATCH_SIZE = 400`, `MAX_CUSTOM_CSS_LENGTH`.
- Policy effects: `blockedSpaceKeys` (pages skipped; linked pages whose space can't be verified
  are skipped too), `disableLiveRender`, `defaultOptions` (locks fields on the options page),
  `maxPages` (rejects; also the linked-mode collect budget).
- `lib/permissions.ts`: `originPattern(origin)` = `origin + '/*'`, `hasSiteAccess`,
  `requestSiteAccess` (**must be called synchronously inside a user gesture** — nothing awaited
  before it in the click handler; fire-and-forget storage writes are fine), `listGrantedOrigins`,
  `removeSiteAccess`, `patternsCoverOrigin`.
- Pending start: before prompting, the popup stores `pendingStart` (session storage); every
  other permission prompt clears it first so an old denied request never starts on an unrelated
  grant. `claimPendingStart` guarantees exactly one start.

### 8.7 UI (`entrypoints/popup|preview|options`, `components/`)

- Preact function components + hooks; no state library. Talk to the SW only via `callSw()` and
  `collectPages()` (port); listen with `onJobUpdate()` / `useJob()`.
- Pure, unit-tested UI logic lives in `components/logic.ts` (margin presets, guard levels,
  `largeExportGuard`, tree model `addChildren/toggleNode/computeCheckStates/selectedInTreeOrder`,
  `statusLabel`, `isRestrictedUrl`, `parseSiteInput`…) and `entrypoints/popup/modes.ts`
  (`availableModes`, `buildRequest`, `isMultiMode`). Put new logic there, not in components.
- Shared components: `OptionsForm` (format segmented control, PDF-only controls hidden in the
  preview / grouped under "PDF layout" on the options page, `locked` fields from policy, `hide`
  list), `PageList`, `TreePicker`, `JobProgress`/`ErrorTable`, `Toggle`/`Checkbox`, `Select`,
  `NumberField`, `Button`, `Notice`/`Toast`, `ProgressBar`, `Icon` (inline SVG only).
- Styles: `assets/ui.css` with CSS variables on `:root` (`--bg`, `--surface`, `--text`,
  `--accent` …) redefined under `@media (prefers-color-scheme: dark)`. Keep focus rings and
  labels (accessibility is tested manually and partly in `ui-components.test.ts`).
- Strings: UI text is English in code; manifest strings are in `public/_locales/en/messages.json`
  (`tests/unit/locales.test.ts` checks every `__MSG_x__` key exists).
- Preview URL: `previewUrl(request)` = `preview.html?req=` + `encodeRequestParam(request)`
  (base64url JSON); `validateRequest()` in `entrypoints/preview/request.ts` re-validates it.

### 8.8 Utilities (`lib/util/`)

`createPool`, `mapPool(items, n, fn, signal)` (pool.ts) · `throwIfAborted`, `sleep(ms, signal)`,
`isAbortError`, `abortError` (abort.ts) · `bytesToBase64`, `base64ToBytes` (chunked, safe for
100 MB), `encodeRequestParam`, `decodeRequestParam` (base64.ts) · `sanitizeFilenamePart`,
`buildFilename` (filename.ts) · `escapeHtml`, `escapeAttr` (escape.ts).

There is **no logging** in the codebase (no `console.*`). Errors surface as `JobError`s and job
messages. If you add temporary logging while debugging, remove it before committing.

---

## 9. Testing guide

### 9.1 Unit tests (`tests/unit/`, Vitest + happy-dom)

- One file per module (`<module>.test.ts`). 31 files, ~440 tests, ~1–2 s total.
- `vitest.config.ts` uses `WxtVitest()`: global `chrome`/`browser` are an in-memory fake
  (`@webext-core/fake-browser`) with storage, runtime messaging, tabs. Reset between tests:
  `import { fakeBrowser } from 'wxt/testing/fake-browser'; beforeEach(() => fakeBrowser.reset());`.
  APIs it lacks (`debugger`, `downloads`, `scripting`, `offscreen`, `permissions`…) must be
  stubbed. The existing tests replace the whole global with exactly what the module uses:
  `vi.stubGlobal('chrome', { debugger: { attach: vi.fn(), sendCommand: vi.fn(), … }, runtime: {…} })`
  and `vi.unstubAllGlobals()` in `afterEach` (see `cdp.test.ts`, `download.test.ts`).
- Mock network with `vi.stubGlobal('fetch', vi.fn(async (url) => new Response(JSON.stringify(x))))`
  (see `clients.test.ts`, `http.test.ts`). Cover v2 (Cloud) and v1 (DC) shapes, and both `''` and
  `/confluence` context paths.
- The runner is tested with a fake `RunnerDeps` harness (`tests/unit/runner.test.ts`, `harness()`):
  extend it for new branches rather than spinning up Chrome.
- Fixtures: `tests/unit/fixtures/exportView.ts` (synthetic Cloud export_view: panels, tables,
  code, expand, links, images, anchors), `convert.ts`, `publicSites.ts` (small excerpts from the
  two public sites only, each with its source page id), `chrome-*.pdf` (real Chrome output).
- happy-dom has no layout: code that measures (`scrollWidth`, `getBoundingClientRect`) must not
  crash on zeros; assert structure, not geometry. Network loading is disabled in the config.
- Remember: Vitest strips types. Always run `npm run compile` as well.

### 9.2 E2E (`tests/e2e/`, Playwright + mock Confluence)

- Run: `npm run test:e2e` (builds `--mode e2e` first). **Re-run `npm run build:e2e` after every
  source change** before `npx playwright test`.
- Harness (`tests/e2e/fixtures.ts`): worker-scoped fixtures `ext` (`ExtensionHarness`), `cloud`
  and `dc` (mock servers), `downloadsDir`, auto `resetMocks`. Key methods:
  `ext.call(msg)` (send `UiToSw` from an extension page), `ext.startJob(request, pages?)`,
  `ext.waitForJob(id, …)`, `ext.exportAndDownload(request, pages?)` → `{ job, file }`,
  `ext.download(id)`, `ext.openPage(url)`, `ext.url('preview.html?…')`, `ext.workerTabUrls()`,
  `ext.debuggerAttachedTabs()`, `ext.closeOtherPages()`. Helpers `cloudSite(mock)`,
  `dcSite(mock)`, `options(overrides)`.
- PDF assertions (`tests/e2e/pdf.ts`): `loadPdf`, `readOutline`, `pageTree`, `outlineHasTree`,
  `namedDestinations`, `links`.
- Mock (`tests/e2e/mock-confluence/server.mjs`, no deps): Cloud under `/wiki` on `127.0.0.1`,
  DC under `/confluence` on `localhost` (separate cookie jars). Requires the session cookie set by
  its HTML pages unless `config.publicAccess`. Pagination size 2; descendants in non-tree order.
  Control endpoints: `GET /__control/log` (every request: method, path, cookie),
  `/__control/reset`, `/__control/config?delayMs=&imageDelayMs=`; config also has
  `publicAccess`, `dropPath`/`dropCount` (destroy connections).
- Mock content (`tests/e2e/mock-confluence/fixtures.mjs`), space `TEST`:
  `100` Test Home → `101` Engineering Handbook → (`102` Getting Started [429 once] → `105` Local
  Setup), `103` Architecture Overview (rich body), `104` Secret Plans (**403**), `107` Old
  Archived Page (archived); `106` Release Notes (404 image); `108` System Diagram (draw.io, live
  render; `liveHtml` draws an SVG); `109` Hostile Page (injection vectors, `hostile.mjs`);
  `500` folder Design Docs → `501`, `502`; `600` Big Manual (many children, batching). DC space:
  `2001` DC Home → `2002`, `2003` → `2004`.
- Test ids: `export.spec.ts` (a)–(s) and `formats.spec.ts` (md1)–(md6), (txt1); list in
  `docs/TESTING.md`. Select with `-g "\(k\)"`.
- Invariants asserted everywhere: valid output, page tree order, skipped pages reported, every
  extension request goes to the mock origin with `GET` (+ cookie), no worker tab / debugger left.
- Things E2E cannot drive (manual QA): permission prompt, keyboard shortcut, context menu,
  notifications, "Save as" dialog, debugger-unavailable fallback.

### 9.3 Live tests (`tests/live/`, opt-in, public sites)

- `npm run test:live` (~30 s). Config `playwright.live.config.ts`; build `--mode live` grants
  host access to exactly `https://uconn.atlassian.net/*` and `https://cwiki.apache.org/*`.
- `tests/live/fixtures.ts`: `APACHE`, `UCONN` (SiteInfo), `liveRequest(site, {mode, root})`,
  `expectTreeOrder`, `treeOfPages`, `imageErrors`, `today()`, re-exports `outlineHasTree`.
  Tests skip when a site is unreachable; `LIVE_SKIP=<host>` skips on purpose.
- Pages used: cwiki COC home `315494566` (tiny `/x/phDOEg`), COMDEV subtree `199529919`,
  survey page with 11 PNGs `67635266`, KIP-1342 (linked mode); UConn space `AI` overview,
  "Copilot vs. ChatGPT" `29030154243`, "Microsoft Copilot" subtree, "OpenAI" folder.
- Assert structure (ids, order, bookmarks, resolved links, image failures), **never** page text or
  exact counts (UConn content changes). Format tests save output under `test-results/live/`.
- Rules: ≤ 15 pages per export, API concurrency 2, no live render, single pages for new tests,
  whole suite < 2 minutes. GitHub: `.github/workflows/live.yml` (weekly + manual).

### 9.4 Test templates (copy, then adapt)

**Unit — pure module with a mocked API** (pattern of `http.test.ts` / `clients.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../../lib/confluence/client';
import type { SiteInfo } from '../../lib/types';

const cloud: SiteInfo = { origin: 'https://acme.atlassian.net', baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki', flavour: 'cloud' };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('CloudClient.getChildren', () => {
  it('returns children in sidebar order', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/v2/pages/1/direct-children')) {
        return json({ results: [
          { id: '3', type: 'page', title: 'B', status: 'current', childPosition: 20 },
          { id: '2', type: 'page', title: 'A', status: 'current', childPosition: 10 },
        ], _links: {} });
      }
      return json({ message: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const kids = await createClient(cloud).getChildren({ id: '1', type: 'page' });
    expect(kids.map((k) => k.id)).toEqual(['2', '3']);
  });
});
```

Do the same for the DC shape (`flavour: 'server'`, `contextPath: '/confluence'`, v1 URLs and
`results[].extensions.position`).

**Unit — sanitizer / converter on markup** (pattern of `sanitize.test.ts`, `convert-markdown.test.ts`):

```ts
import { sanitizePageHtml } from '../../lib/assemble/sanitize';

const ctx = { pageId: '42', site: cloud, pageUrl: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/42',
  exportedIds: new Set(['42', '43']), includeComments: false };

it('rewrites a link to an exported page into an in-document anchor', () => {
  const frag = sanitizePageHtml(
    '<p><a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/43/Other" data-linked-resource-id="43">x</a></p>', ctx);
  const div = document.createElement('div');
  div.append(frag);
  expect(div.querySelector('a')!.getAttribute('href')).toBe('#p-43');
});
```

**Unit — runner branch** (pattern of `runner.test.ts`): use the file's `harness(opts)` (fake
`RunnerDeps`: records `calls`, `statuses`, `prints`, `saved`, `zipped`, `closed`; options for
`infos`, `collected`, `policy`, `batchSize`, `live`, `workerOp`, `convert`, `readMaxBytes`) plus
`makeJob(pages)` / `ref(id, depth)`:

```ts
it('skips a 403 page but finishes the export', async () => {
  const h = harness({ infos: { '2': { ok: false, httpStatus: 403, error: 'No permission' } } });
  const job = makeJob([ref('1'), ref('2', 1)]);
  await runJob(job, h.deps);
  expect(job.status).toBe('done');
  expect(job.errors).toContainEqual(expect.objectContaining({ pageId: '2', severity: 'skipped' }));
  expect(h.saved).toHaveLength(1);
});
```

**E2E** (pattern of `export.spec.ts`; helpers `cloudRequest`, `exportAndRead`, `TITLES` live at
the top of that file):

```ts
test('(x) my scenario', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));   // sets the session cookie
  const { job, file } = await exportAndRead(ext,
    cloudRequest(cloud, { mode: 'subtree', depth: 1, root: { id: '101', type: 'page', title: TITLES[101] } }));
  expect(job.status).toBe('done');
  const pdf = await loadPdf(file.bytes);
  expect(pdf.getTitle()).toBe('Engineering Handbook');
  expectReadOnlyWithCookies(cloud);            // every request GET + cookie, only to the mock
});
```

Need new mock content? Add a page to `tests/e2e/mock-confluence/fixtures.mjs` (id, type, title,
parentId, position, `body: (base) => html`, optional `storage`, `forbidden`, `status`,
`throttleOnce`, `liveHtml`). Keep ids unique and check that existing order/count assertions
(e.g. subtree of 101, space mode) still hold — or put new pages under a new parent.

**Live** (pattern of `tests/live/apache-dc.spec.ts`): one or two pages, structural assertions only.

```ts
test('my live check', async ({ ext, sites }) => {
  // sites.apache is null when reachable, otherwise the reason it isn't
  test.skip(!!sites.apache, `cwiki.apache.org is not reachable (${sites.apache})`);
  const { job } = await ext.exportAndDownload(liveRequest(APACHE, {
    mode: 'current', root: { id: '315494566', type: 'page', spaceKey: 'COC' } }));
  expect(job.status).toBe('done');
  expect(imageErrors(job)).toEqual([]);
});
```

The live `ext` fixture already sets `apiConcurrency: 2` / `liveRenderConcurrency: 1` in sync
storage, and the `cleanup` auto-fixture closes stray pages after each test.

### 9.5 CI (`.github/workflows/ci.yml`)

`npm ci` → `compile` → `test` → license freshness → `check:release` (tags only) → `build` →
production manifest check (no `host_permissions`, no localhost) → zip (Chrome + Edge) →
`npm audit --omit=dev --audit-level=moderate` → E2E under `xvfb-run`.

---

## 10. Recipes

### Add a new export option (e.g. `includeLabels: boolean`)

1. `lib/types.ts`: add to `ExportOptions` (doc comment) and `DEFAULT_OPTIONS`.
2. `lib/settings.ts` `normalizeOptions()`: validate it (`bool(r.includeLabels, base.includeLabels)`).
3. `public/managed_schema.json`: add under `defaultOptions.properties`.
4. If PDF-only: add to `PDF_ONLY_OPTIONS` in `lib/format.ts`.
5. UI: `components/OptionsForm.tsx` (toggle with label + hint); popup only if it is a quick choice.
6. Consumer: `lib/assemble/document.ts` (PDF) and/or `lib/convert/*` (md/txt); the option reaches
   the worker inside `options` of `worker/assemble` / `worker/convert`.
7. Tests: `settings.test.ts` (defaults/normalization), unit test of the consumer, E2E if visible
   in output. Docs: docs/USER_GUIDE.md (and README if it is a headline feature), CHANGELOG, `docs/ARCHITECTURE.md` if contracts changed,
   TESTING.md manual checklist if it needs manual QA.

### Add a worker RPC

1. `lib/messages.ts`: add to `SwToWorker` and `SwToWorkerResponses` (or, for a long operation,
   answer `{started:true}` and add the result type to `WorkerOpResults`).
2. `entrypoints/worker.ts`: add the type to `REQUEST_TYPES` and a `case` in `handle()`.
3. SW side: `callWorker(tabId, msg)` or `runWorkerOp(...)` for background ops; in the runner,
   call it through `deps.callWorker` so unit tests can fake it.
4. Keep responses small (no page HTML, no large binaries — use chunked reads like `worker/readOutput`).

### Add a Confluence API call

1. Add the method to `ConfluenceClient` (`client.ts`) and implement it in **both** `cloud.ts`
   (v2 first, v1/CQL fallback) and `server.ts` (v1). Use `getJson`/`paginate` from `http.ts`
   (never raw `fetch`), pass `this.http` options (signal, throttle callback).
2. Cache only successful/definitive answers. Respect `AbortSignal`.
3. Unit tests in `clients.test.ts` with Cloud and DC response shapes; add the endpoint to the mock
   (`server.mjs`) if E2E paths use it; run the live suite.

### Handle a new Confluence macro / markup

- Static but ugly → CSS in `print.css` (+ normalization in `sanitize.ts` if markup must change),
  and a rule in `lib/convert/prepare.ts`/`markdown.ts`/`text.ts` so md/txt match.
- Not renderable statically → placeholder via `replaceUnsupportedContent` in `macros.ts`
  (FR-9: never drop silently).
- Client-rendered diagram → add the macro name to `DEFAULT_SETTINGS.liveRenderMacros` and/or
  detection in `detectLiveRenderMacros`.
- Add a fixture (synthetic, or a trimmed excerpt from the public sites in `publicSites.ts`) and
  tests in `sanitize.test.ts` / `macros.test.ts` / `convert-*.test.ts`.

### Add a content type

Update `ContentType` (`types.ts`), `toContentType()` (`client.ts`), `LINK_ONLY_TYPES` (runner +
`lib/convert/shared.ts`), `TYPE_LABEL`/`TYPE_ICON` (`components/logic.ts`, `PageList.tsx`),
`TYPE_LABELS` (convert/shared.ts), URL parsing (`url.ts`, `detect.ts` — remember detect is
self-contained, duplicate small logic there), Cloud endpoints/CQL in `cloud.ts`.

### Add a new output format

Follow the Markdown/text precedent: `ExportFormat` + `FORMATS` (`lib/format.ts`), settings
normalization (`EXPORT_FORMATS`), filename ext (`FilenameExt`), a writer under `lib/convert/`
selected in `convertPages`, runner branch (reuse the md/txt branch), `OptionsForm` choices
(`FORMAT_CHOICES`), managed schema enum, E2E in `formats.spec.ts`, docs.

### Change print styling

Edit `lib/assemble/print.css`. Check visually: render a fixture to PDF with Playwright's Chromium
in a scratch script (outside the repo), or load the unpacked build and export a public cwiki page.
Keep `break-inside` rules sane (large tables and long code must still split across sheets).
`geometry.ts` owns page size/margins — do not hard-code sizes in CSS.

### Add a UI setting to the options page

`entrypoints/options/App.tsx` + `components/OptionsForm.tsx` (export options, "Export defaults"
card) or the other cards ("Performance & limits" for concurrency/batch size/thresholds,
"Live render", "Notifications", "Site access"). Validate with `clampInt`/`parseList` (`components/logic.ts`)
and in `normalizeSettings()`. Respect policy locks (`locked` prop).

### Release

1. Update `CHANGELOG.md` (move Unreleased → version/date) and `package.json` version
   (`npm version X.Y.Z --no-git-tag-version`; the manifest version comes from package.json).
2. `npm run compile && npm test && npm run test:e2e && npm run test:live`.
3. `npm run licenses` if deps changed; `npm run check:release` (placeholders must be filled:
   contact email in `PRIVACY.md`/`store/edge-listing.md`, repo owner in `store/listing.md`).
4. `npm run zip` (+ `zip:edge`); upload `.output/*.zip`. Listing text: `store/listing.md`
   (permission justifications, data-usage answers), screenshots `store/screenshots/`.
5. Expect a longer Web Store review because of the `debugger` permission.

---

## 11. Debugging tips

- **Service worker console**: `chrome://extensions` → the extension → "Inspect views: service
  worker". Evaluate `chrome.storage.session.get()` to see stored jobs, pending start, orphan tabs.
- **Worker tab**: during an export it is an inactive tab ending in `#cfp-worker` next to your
  page. Open it to see the assembled print document (it is a real page with the print CSS; use
  DevTools "Rendering → Emulate CSS media: print"). Note: attaching DevTools to it before
  printing makes `chrome.debugger.attach` fail → the fallback print dialog appears.
- **Popup**: right-click the popup → Inspect. **Preview/options**: normal DevTools.
- **E2E failures**: traces in `test-results/<test>/trace.zip` (`npx playwright show-trace`);
  `HEADED=1`; mock request log via `GET /__control/log`; downloaded files land in the test's
  downloads dir (see `fixtures.ts`).
- **Real-data checks without the extension**: bundle the relevant `lib/` functions with Vite in a
  scratch directory (outside the repo) into an IIFE and run them in a tab on a public Confluence
  JSON URL (e.g. `https://cwiki.apache.org/confluence/rest/api/space?limit=1`) — same origin as
  the worker tab. Never use private sites for anything that ends up in the repo.
- **curl the public APIs** to check response shapes, politely:
  `curl -s 'https://cwiki.apache.org/confluence/rest/api/content/315494566?expand=body.export_view,space,version'`,
  `curl -s 'https://uconn.atlassian.net/wiki/api/v2/spaces?keys=AI'`.
- **Common symptom → cause**:
  - Export hangs at "Connecting to Confluence" → worker tab didn't load/inject (login page, CSP,
    closed tab); see `openWorkerTab`/`waitForTabComplete`.
  - "Please log in" on a public site → session logic (`session.ts`) misclassified anonymous.
  - Links between pages not clickable in PDF → missing `p-{id}` destination (`cf-dests`), or
    link not rewritten in `sanitize.ts` (check `PageIndex` for `/display/` links).
  - Bookmarks flat/missing → `finalizeExport`/`buildOutline` or headings not demoted.
  - Images missing → `waitForAssets` timeout, lazy loading attr, cross-origin, or (md) not on the
    Confluence origin (by design kept as absolute URL).
  - Order wrong → `buildTreeOrder`/`compareSiblings` or DC `extensions.position`.
  - Test passes locally but E2E fails on CI → you forgot `npm run build:e2e` locally.

---

## 12. Gotchas and decisions you should not "fix"

- **Worker tab on a JSON URL** is intentional: same-origin cookies, no Confluence app JS, no CSP.
- **No `tabs` permission**: we only read URLs of tabs on granted origins (or via `activeTab`).
- **`probePage` duplicates small helpers** on purpose (must be self-contained).
- **Cover/TOC use no heading tags** so Chrome's outline lists pages only.
- **No hidden marker text in PDFs** (it leaked into copy/paste); sections are located by named
  destinations `p-{id}`, which Chrome only emits for ids that some link targets → `cf-dests`.
- **Zero-size (not `display:none`) placeholders** for cross-batch link targets — Chrome needs a box.
- **h6 uses small-caps**, not `text-transform: uppercase` (it leaked into bookmark titles).
- **Live render runs before printing** so a failed live page falls back to static content.
- **Helper tabs are normal inactive tabs**, not a minimized window (rendering is throttled there).
- **Markdown assets only from the Confluence origin**: a CORS fetch from the worker tab would send
  `Origin: <confluence>` to third-party hosts (privacy) — other images keep their absolute URL.
- **Converter uses an inert document**; passing the live tab document made Chrome fetch images.
- **Anonymous ≠ signed out**: public sites must keep working without login.
- **`preview.html` reuses the popup's collection for 90 s** (same request key) — don't remove the
  cache, it halves the API calls.
- **Filenames use the local date**, tests too (UTC broke tests around midnight).
- **`separateFiles` with one content page** saves a single file (no ZIP, no cover/TOC).
- **Dates/IDs in screenshots and fixtures** must come from public/synthetic sources only.
- **TypeScript 7** is the Go-based compiler; some older TS-plugin tooling may not work — use
  `npm run compile`.
- `.wxt/` is generated by `wxt prepare` (postinstall). If types for `wxt/*` imports are missing,
  run `npx wxt prepare`.
- Import WXT helpers explicitly: `import { defineBackground } from 'wxt/utils/define-background'`,
  `import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script'`.

---

## 13. Code conventions

- Strict TypeScript, no `any` unless unavoidable at an API boundary (then narrow immediately).
- Pure functions for logic; side effects (chrome APIs, network) at the edges and injectable
  (`RunnerDeps`, `fetchImpl` options) so they can be unit-tested.
- Comments explain *why* (Chrome/Confluence quirks, decisions), with the requirement id when
  relevant (`FR-9`). Match the existing density; don't narrate obvious code.
- Errors shown to users are full sentences, specific and actionable ("Please log in to Confluence
  in this browser, then try again."). Shared messages live in `lib/errors.ts` / `runner.ts`.
- Requirement ids `FR-1`…`FR-17` are listed in `docs/ARCHITECTURE.md` §0.
- Keep bundle size small (no new UI libraries; inline SVG icons).
- Commits: imperative subject, body explaining what/why; end with the co-author trailer used in
  this repo's history when an AI agent authored the change. Never commit `.output/`,
  `test-results/`, `node_modules/` (see `.gitignore`).

---

## 14. Quick reference: where is …?

| Looking for | Go to |
|---|---|
| Manifest / permissions / build modes | `wxt.config.ts` |
| Extension name & description strings | `public/_locales/en/messages.json` |
| Default options / settings | bottom of `lib/types.ts` |
| Settings validation | `lib/settings.ts` `normalizeOptions` / `normalizeSettings` / `normalizePolicy` |
| Which options are PDF-only | `lib/format.ts` `PDF_ONLY_OPTIONS` |
| Message types | `lib/messages.ts` |
| SW message routing | `entrypoints/background.ts` `handleUi()` |
| Worker message routing | `entrypoints/worker.ts` `handle()` |
| Export state machine | `lib/job/runner.ts` `runJob()` |
| Real runner dependencies | `lib/job/manager.ts` `buildDeps()` |
| Starting/cancelling jobs | `lib/job/manager.ts` `startJob` / `cancelJob` |
| Helper tab lifecycle | `lib/render/tabs.ts` |
| Printing | `lib/render/cdp.ts` |
| Bookmarks, page numbers, metadata | `lib/pdf/merge.ts` `finalizeExport` |
| HTML cleanup & link rewriting | `lib/assemble/sanitize.ts` |
| Placeholders for unsupported content | `lib/assemble/macros.ts` |
| Cover / TOC / page header markup | `lib/assemble/document.ts` |
| PDF look & feel | `lib/assemble/print.css` |
| Markdown rules | `lib/convert/markdown.ts` (+ `prepare.ts`) |
| Text layout | `lib/convert/text.ts` |
| Export modes / page ordering | `lib/confluence/collect.ts`, `client.ts` `buildTreeOrder` |
| Cloud vs DC API calls | `lib/confluence/cloud.ts`, `server.ts` |
| Popup detection | `lib/confluence/detect.ts` `probePage` |
| URL shapes | `lib/confluence/url.ts` |
| Filenames | `lib/util/filename.ts` |
| Download saving | `lib/download.ts` |
| Context menu patterns | `lib/linkPatterns.ts` |
| Popup modes / request building | `entrypoints/popup/modes.ts` |
| Large export guard, tree picker logic | `components/logic.ts` |
| Mock Confluence | `tests/e2e/mock-confluence/server.mjs`, `fixtures.mjs` |
| E2E harness | `tests/e2e/fixtures.ts`, `tests/e2e/pdf.ts` |
| Live test sites & helpers | `tests/live/fixtures.ts` |
| Store listing / privacy | `store/listing.md`, `PRIVACY.md` |
| Enterprise policy | `public/managed_schema.json`, `docs/ENTERPRISE.md` |
