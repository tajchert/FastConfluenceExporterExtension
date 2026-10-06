# Testing

Testing has three layers:

| Layer | Tooling | Runs in CI | What it proves |
|---|---|---|---|
| Unit | Vitest + happy-dom (`tests/unit/*.test.ts`) | Yes | Pure logic: URL parsing, tiny-link decoding, pagination, collection order, link extraction, sanitizer, macro detection, filenames, settings and policy validation, PDF merge/outline, zip |
| E2E | Playwright + the built extension + a local mock Confluence (`tests/e2e/`) | Yes | The whole pipeline in a real Chromium: popup / preview → worker tab → printToPDF → live render → pdf-lib → download |
| Manual QA | The checklist below, on real Cloud and Data Center sites | Before each release | Real-world fidelity, performance, store-review behavior |

## Unit tests

```bash
npm test                         # all unit tests
npx vitest run tests/unit/url.test.ts
npm run test:watch               # watch mode
npm run compile                  # strict type check (run it as well, Vitest does not type-check)
```

Conventions:

- One file per module: `tests/unit/<module>.test.ts`.
- `happy-dom` provides `DOMParser`, `document` and `Element` for the sanitizer, links and assembler
  tests. Code that runs in the service worker must not depend on DOM globals, so keep those tests
  DOM-free where possible.
- `WxtVitest()` (in `vitest.config.ts`) stubs the global `chrome` and `browser` with an in-memory fake
  (`@webext-core/fake-browser`). It implements storage, runtime messaging and tabs. APIs it
  doesn't implement (for example `debugger` or `downloads`) must be stubbed per test with `vi.spyOn`/`vi.fn`.
  Reset state between tests with `fakeBrowser.reset()` (`import { fakeBrowser } from 'wxt/testing/fake-browser'`).
- Mock `fetch` for the API client (`vi.stubGlobal('fetch', …)`) and use the response shapes
  from [ARCHITECTURE.md §1](ARCHITECTURE.md#1-spike-findings-verified-on-a-real-confluence-cloud-site-2026-10-06).
  Always cover v2 (Cloud) and v1 (Data Center) shapes, and both a root context path (`''`) and
  a `/confluence` context path.
- Use only synthetic fixtures (made-up spaces, titles and people). **Never** commit content copied
  from a real Confluence site.

## E2E tests

```bash
npx playwright install chromium  # once
npm run test:e2e                 # = npm run build:e2e && playwright test
```

```bash
HEADED=1 npx playwright test             # watch the browser
npx playwright test -g "\(b\)"           # one test
node tests/e2e/mock-confluence/server.mjs 8090 cloud   # the mock on its own (or `server`)
```

- `npm run build:e2e` builds with `--mode e2e` into `.output/chrome-mv3-e2e`. That build adds install-time host
  permissions for `http://localhost/*` and `http://127.0.0.1/*`, so tests don't have to click the
  runtime permission prompt. Production builds never contain them.
- `tests/e2e/fixtures.ts` loads the unpacked extension into a persistent Playwright Chromium
  (`channel: 'chromium'`, new headless mode; the headless shell cannot run extensions) with
  `--disable-extensions-except` / `--load-extension`. One browser is shared by all tests
  (`workers: 1`).
- The tests drive the extension like its own UI does: an extension page sends `UiToSw` messages
  (`job/start`, `job/get`, `job/cancel`, `collect`) to the service worker, or the test clicks
  through `popup.html` / `preview.html`. Playwright's `download` event does not fire for
  `chrome.downloads`, so the file is found with `chrome.downloads.search` and read from disk
  (CDP `Browser.setDownloadBehavior: allow` keeps the extension's filename).
- `tests/e2e/mock-confluence/server.mjs` (plain Node, no dependencies) emulates Confluence Cloud
  under `/wiki` (HTML pages with `ajs-*` metas, REST v2 and v1) and Data Center under
  `/confluence` (v1 only, served as `localhost` so the two sites never share cookies). It
  requires the session cookie its HTML pages set, paginates with a page size of 2, returns
  descendants in non-tree order, answers 403 for one page, 429 + `Retry-After: 1` once for
  another, 404 for one image, and serves a real PNG. "Hostile Page" (109) serves known HTML-injection
  vectors (`hostile.mjs`, shared with the sanitizer unit test) whose payloads would request
  `/wiki/__pwned?v=N` if they ran. Content is in `fixtures.mjs`;
  `/__control/*` endpoints and the `log`/`config` fields let tests slow responses and inspect
  every request.
- Assertions to keep: the downloaded file is a valid PDF, its page count matches, its bookmarks
  follow the page tree (`pageTree()` compares the page bookmarks, ignoring each page's heading
  bookmarks), internal links resolve to named destinations, skipped pages are reported, and
  **every request the extension makes goes to the mock origin and uses `GET`** (with the session
  cookie). The fixtures embed no images from other hosts; real pages may (see PRIVACY.md §2).

What the suite covers (`tests/e2e/export.spec.ts`): (a) single page with metadata, outline,
prefixed anchors, images and a network check; (b) subtree order, 403 skipped, 429 retried,
archived excluded, nested bookmarks with each page's headings; (c) folder; (d) linked pages,
de-duplicated, broken image reported, breadcrumbs; (e) separate files → ZIP; (f, f2) cancel while
fetching and while assembling (no worker tab or debugger session left, next export works);
(g) preview pruning; (g2, h2) popup probe on Cloud and DC; (g3) popup → preview (the preview
reuses the popup's collection; breadcrumbs in the filtered list); (h) Data Center subtree;
(i) logged out; (j) live render inserted into the PDF, page numbers stamped on every sheet but
the cover; (k) several print batches merged, TOC links to pages of the second batch kept and
resolving to the real sections; (l) entire space; (m) manual selection in tree order; (n) two
concurrent exports; (o) hostile export_view: no injection vector runs in the worker tab (real
Chromium), no foreign requests; (p) session expires mid-export → one sign-in error, no per-page
"no permission" noise; (r) preview collection cancelled, and closing the preview closes its
helper tab.

Not covered by E2E (Chrome UI the tests cannot drive): the runtime permission prompt and the
`pendingStart` hand-off (unit-tested: `claimPendingStart` starts a pending export once), the
keyboard shortcut, the context menu (its link patterns are unit-tested), notifications, the
"Save as" dialog (cancel/timeout behaviour is unit-tested in `download.test.ts`) and the
debugger-unavailable fallback. Check them manually (below).

## Manual QA checklist

Run before every release on the **latest stable Chrome** and **latest stable Edge**, on
**macOS and Windows**. Test against:

- **Cloud A:** a `*.atlassian.net` site (a free Atlassian Cloud site is enough).
- **Cloud B:** a Cloud site on a custom domain, if you have one.
- **DC:** Confluence Data Center 7.x/8.x/9.x. The official Docker image with a trial license
  works. Test one instance at the root context (`/`) and one at `/confluence`.

Use a test space with synthetic content: at least 25 pages in a tree, 3 levels deep. It should
include a folder (Cloud), a whiteboard and a database (Cloud), images, a wide table, a long code
block, info/note/warning panels, an expand macro, a Jira issue macro, a page with a draw.io or
Gliffy diagram (if the app is installed), and a page that a second test user can't view.

### Smoke (each browser × each site)

- [ ] Fresh install: the extension has **no host access** (`chrome://extensions` → Details → Site access).
- [ ] The toolbar icon is crisp at 16 px and 32 px (try 100 % and 200 % display scaling), in both light and dark browser themes.
- [ ] The popup on a non-Confluence site says it is not a Confluence page and does nothing else.
- [ ] The popup on a Confluence page shows the page title, space key and last-updated date.
- [ ] First export from a site prompts for access to **that origin only**. After you grant it, the export runs **once** (one job, one download), also when the popup closed during the prompt.
- [ ] Deny the prompt from the popup (the popup closes), then within a minute add the same site on the options page: **no** export starts by itself.
- [ ] Revoking the site on the options page means the next export asks again.

### Acceptance criteria (spec §14, generic)

- [ ] **This page:** produces a PDF in **≤ 5 s** (text + about 10 images) with the correct title, images, tables, code blocks and panels, and clickable links. Check on Cloud A, Cloud B and DC.
- [ ] **This page + children** on a 25-page tree produces **one** PDF with a cover, a clickable TOC in **sidebar order**, each page starting on a new sheet, **bookmarks per page** (nested by depth), and page numbers in the footer. Should take ≤ 30 s.
- [ ] Depth limit for subtree exports is respected (depth 1 = root + direct children).
- [ ] **Folder** export (Cloud) includes all nested pages in tree order. Whiteboards and databases appear as **link-only** TOC entries.
- [ ] **Linked pages, depth 1** includes every same-site page linked from the root (via `ri:page` link, plain URL and smart link/inline card), **de-duplicated**. Links between included pages **jump within the PDF**. External links, attachments, Jira links and people links are not followed.
- [ ] **Linked pages, depth 2** follows one more hop with no duplicates and no infinite loop on A ↔ B cycles.
- [ ] **Manual tree selection** exports exactly the checked pages, in tree order, also when they come from different branches. Tri-state parents behave correctly.
- [ ] **Preview** lets you uncheck pages, and the export omits them. More than 150 pages shows a warning; more than 500 requires confirmation.
- [ ] A page **without view permission** (log in as the second user) is **skipped and reported**. The rest exports fine.
- [ ] Pages with **draw.io / Gliffy** diagrams show the diagram with **Live render** on. With it off, a placeholder or static image appears and nothing breaks.
- [ ] **Cancel** stops the job within **2 s**, also right after clicking Export (while the helper tab is still opening) and while Chrome's "Save as" dialog is open (the dialog's download is cancelled; no file appears). Afterwards there are **no orphan tabs**, no debugging bar, and no stale `chrome.debugger` session (the next export works).
- [ ] Close the preview without exporting: its helper tab (`…/rest/api/space?limit=1`) closes within a few seconds. Quit Chrome during an export with "Continue where you left off" on: after the restart, restored helper tabs close by themselves.
- [ ] **Network:** in DevTools for the service worker, the worker tab and the extension pages, the extension's own requests go only to the Confluence origin being exported (no analytics, fonts or CDNs). Images embedded in pages from other hosts load from those hosts, without a `Referer` header.
- [ ] **Read-only:** every request to Confluence is a `GET`.
- [ ] Works on the **latest stable Chrome and Edge** on **macOS and Windows**.

### Data Center specifics

- [ ] Detection works on `/display/KEY/Page+Title`, `/pages/viewpage.action?pageId=…` and `/spaces/KEY/pages/…` URLs.
- [ ] Context path `/confluence`: API calls, images and "Open in Confluence" links include the context path.
- [ ] Sidebar order of children matches DC's page tree.
- [ ] The cover shows the DC user's display name.
- [ ] HTTP (non-TLS) intranet site: the permission prompt is for `http://host/*` and export works.

### Fidelity

- [ ] Images keep their original resolution. An image that fails to load becomes a placeholder box showing the filename.
- [ ] Wide tables shrink to fit (option on) or overflow cleanly (option off). Table headers repeat on every sheet.
- [ ] Long code lines wrap, and nothing is cut off.
- [ ] Expand macros are printed expanded, without the toggle UI.
- [ ] Iframes and embedded videos are replaced by a placeholder with the URL.
- [ ] Same-page anchors (TOC macro inside a page) jump to the right heading in the combined PDF, without colliding with other pages.
- [ ] Inline comment highlights are hidden by default and shown with *Include comments* on.
- [ ] Text is selectable and searchable. The PDF metadata (Title, Author, Subject, Creator) is set (check in the viewer's document properties).
- [ ] Paper sizes A4, Letter, Legal and A3, landscape, and custom margins all apply.
- [ ] Custom CSS from the options is applied.

### Options and other entry points

- [ ] **Separate files** produces a ZIP with one PDF per page and unique filenames.
- [ ] The filename is `{SPACE}_{Root title}_{YYYY-MM-DD}.pdf`, with characters that are invalid on Windows or macOS removed.
- [ ] With Chrome's "Ask where to save each file" on, the Save dialog appears. With it off, the file goes straight to Downloads.
- [ ] **Alt+Shift+P** exports the current page without opening the popup.
- [ ] The **context menu** on a Confluence page link offers *Export this page to PDF* and *Export this page + children*, and both work. It doesn't appear on non-Confluence links (for example `https://example.com/display/foo/bar`). On a not-yet-allowed site it opens the export page with "Allow & export" instead of prompting.
- [ ] A completion notification appears (and can be turned off in the options).
- [ ] Closing the source tab mid-export doesn't stop the export.
- [ ] Throttling: lowering limits on DC, or a large export on Cloud, shows "Throttled by Confluence, retrying…" and then finishes.

### Robustness

- [ ] Another debugger is attached (open DevTools on the worker tab before printing, or run a second debugging extension): the export falls back to the print dialog with a clear message.
- [ ] Session expired or logged out (also mid-export, e.g. sign out in another tab): a clear sign-in error, and no partial file.
- [ ] A Confluence request that never answers (e.g. a stalled proxy) times out and the export finishes or fails cleanly instead of hanging.
- [ ] A 100-page export finishes in ≤ 2 min without a tab crash. Watch memory in Chrome's Task Manager; peak should be < 1.5 GB.
- [ ] Two exports started one after another: both finish, with no interference between them.

### Enterprise policy

See [ENTERPRISE.md](ENTERPRISE.md). With a test policy loaded through `chrome://policy`, or locally
via `/etc/opt/chrome/policies/managed/` on Linux or a configuration profile on macOS:

- [ ] `blockedSpaceKeys` refuses exports from those spaces. With a block list, a linked page whose space can't be determined is skipped ("could not be checked against your administrator's policy"), never exported.
- [ ] `disableLiveRender: true` forces Live render off.
- [ ] `maxPages` blocks larger exports.
- [ ] `defaultOptions` are used as defaults.
- [ ] Malformed values are ignored, not fatal.

### Store package

- [ ] `npm run zip` succeeds, and the ZIP contains no source maps with absolute local paths, no `.env`, and no test fixtures.
- [ ] `manifest.json` in the ZIP: no `host_permissions` key (or an empty one), and there are no `localhost` entries (those are e2e-only).
- [ ] The icons appear in `chrome://extensions`, in the toolbar and on the Web Store upload preview.
- [ ] `npm audit --omit=dev --audit-level=moderate` passes (this also runs in CI).
- [ ] `npm run check:release` passes: no `<your-email>` / `<owner>` placeholders left in `PRIVACY.md`, `README.md` or `store/*.md`, and `THIRD_PARTY_LICENSES.txt` is current (`npm run licenses`). The ZIP contains `THIRD_PARTY_LICENSES.txt`.
