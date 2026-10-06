# User guide

Everything about using **Fast PDF Export for Confluence**: export modes, formats, options, permissions,
limitations and troubleshooting. For a short overview see the [README](../README.md).

> "Confluence" is a trademark of Atlassian. This extension is not affiliated with or endorsed by Atlassian.

## Contents

- [Features](#features)
- [How it works (and why it is private)](#how-it-works-and-why-it-is-private)
- [Supported Confluence](#supported-confluence)
- [Install](#install)
- [Usage](#usage)
- [Permissions](#permissions)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)

## Features

**Export modes**

| Mode | What ends up in the PDF |
|---|---|
| **This page** | The page you are looking at. One click, no preview. Also available with the keyboard shortcut **Alt+Shift+P** (change it at `chrome://extensions/shortcuts`). |
| **This page + children** | The page and all its descendants in sidebar order. You can limit the depth. |
| **This folder** | Everything in a Confluence folder, recursively, in tree order. |
| **Pages linked from this page** | The page plus every page on the same site that it links to (page links, URLs and smart links), 1 or 2 hops deep. Pages are de-duplicated and link cycles are ignored. |
| **Choose pages from tree** | A tree of the space that loads as you expand it, with tri-state checkboxes. Pages are exported in tree order. |
| **Entire space** | Every page of the space, in sidebar order. |

Before a multi-page export starts, you see a **preview**: every page that will be included, with
its breadcrumb and a checkbox so you can drop pages. You get a warning when an export goes over
150 pages and must confirm it above 500 pages. Both thresholds can be changed in the options.

**Output**

- **Cover page**: title, source URL, export date, who exported it and the page count.
- **Table of contents**: entries link to the pages inside the PDF.
- **PDF bookmarks (outline)**: one bookmark per page, nested like the page tree, with each page's
  headings below it.
- **A new sheet for every page**, with a header block: title, breadcrumb, last-updated date and a link to the original.
- **Internal links**: a link to another page that is also in the PDF jumps inside the PDF. Other links still point to Confluence.
- **Page numbers** in the footer (the cover is not numbered), and PDF metadata (title, author, subject).
- **Options**: paper size (A4, Letter, Legal, A3), orientation, margins, and toggles for the cover, TOC,
  page header blocks, page numbers, inline comment highlights, archived pages and shrinking wide
  tables. You can also add custom CSS for your own branding.
- **Separate files**: one file per page, bundled in a ZIP, as an alternative to one combined document.
- **Filenames** look like `{SPACE}_{Root page title}_{YYYY-MM-DD}.pdf` (`.md`, `.txt` or `.zip`).
  Files are saved through Chrome's downloads, so your "Ask where to save each file" setting is respected.

**Formats**

PDF is the default. Pick another format in the popup (for one export), in the preview, or as the
default in the options.

| Format | What you get |
|---|---|
| **PDF** | One vector PDF (or one per page in a ZIP), as described above. |
| **Markdown** (`.md`) | GitHub-flavoured Markdown: headings, tables (complex tables stay as clean HTML tables), fenced code blocks with their language, task lists, panels as quotes (`**Note:** …`), expand macros as `<details>`, status lozenges as `` `DONE` ``. The cover becomes YAML front matter, the TOC a nested list of links. With **Include images** (default) the `.md` file and an `assets/` folder come in a ZIP with relative image links; without it you get a single `.md` file that links to the images on Confluence. |
| **Text** (`.txt`) | Readable UTF-8 plain text: underlined titles, indented lists and code, tables as aligned columns, links as `text (url)`. Images become `[Image: name]`. |

Links between exported pages stay internal in every format (anchors in one document, relative
file links with one file per page). Content that can't be converted becomes a visible note with a
link to Confluence. Paper size, margins, page numbers, live render, wide-table fitting and custom
CSS only apply to PDF. Markdown and text exports don't print anything, so Chrome shows no
"started debugging this browser" bar for them.

**Fidelity**

- Tables, code blocks, panels, info/note/warning macros, layouts, status lozenges, Jira issue
  tables, images and expand macros (printed expanded).
- Some content can't be printed from a static copy, such as iframes, embedded videos, whiteboards,
  databases and live macros. It is replaced by a **visible placeholder with a link to the
  original**. Nothing is dropped silently.
- **Live render (optional, slower)**: diagrams and charts drawn by browser apps (for example
  draw.io, Gliffy, Lucidchart, Mermaid, PlantUML, roadmaps and charts) are rendered by
  opening the real page in a background tab and printing it. The pages are then merged into the
  PDF in the right place. You can change which macros trigger live render in the options.

**Convenience**

- **Context menu** on links to Confluence pages: *Export this page* and *Export this page + children*
  (in your default format).
  It appears on Confluence-shaped links (`/wiki/…`, `*.atlassian.net`, `viewpage.action`) and on any
  page link of a site you already allowed. For a site you have not allowed yet, the menu opens the
  export page, which asks for access only after showing you which site it is.
- **Progress view** that shows page X of N and the current page, with a **Cancel** button and a
  summary of skipped or degraded pages at the end. Cancel also stops a download that is waiting
  in Chrome's "Save as" dialog, so a cancelled export never leaves a file behind. Collecting the
  pages for the preview can be cancelled too. A system notification appears when the export
  finishes.
- **Robust**: if you can't view a page (403/404), it is skipped and listed in the summary, and the
  rest of the export continues; a branch of the tree that can't be listed is skipped and reported
  the same way. When Confluence rate-limits requests (HTTP 429), the extension backs off, retries
  automatically and shows "Throttled by Confluence, retrying…". A request that gets no answer
  times out instead of hanging the export. If your session expires during an export, it stops
  with a clear sign-in message.
- **Enterprise ready**: you can force-install it and configure it with managed policy (blocked
  spaces, a page limit, default options, disabling live render). See [ENTERPRISE.md](ENTERPRISE.md).

## How it works (and why it is private)

- **In your browser.** There is no backend and no API token. The extension calls Confluence's
  REST API **on the same site you are viewing**, using the session you are already logged in with.
  Public sites work without signing in: pages anyone can read export anonymously (the cover then
  has no "exported by").
- **Read-only.** It only sends `GET` requests and never changes anything in Confluence.
- **You only see what you can already see.** Confluence enforces your own permissions.
- **No data leaves your device.** There is no analytics, telemetry or remote logging. The PDF is
  saved straight to your downloads folder. See [PRIVACY.md](../PRIVACY.md).
- **Embedded resources load like in Confluence.** Images and other resources embedded in your
  pages (attachments, emoji, avatars, images inserted from other websites) are loaded by the
  browser while the PDF is built, from wherever the page references them — which can include
  hosts outside your Confluence site, exactly as when you view the page. No referrer is sent with
  those requests.
- **Access per site.** The extension has no access to any website when you install it. The first
  time you export from a Confluence site, Chrome asks you to allow access to **that site only**.
  You can revoke access at any time on the options page or at `chrome://extensions`.

Behind the scenes, the extension opens a background tab on a lightweight Confluence API URL on
the same site. It fetches the pages there, assembles one print-ready document and prints it to
PDF with Chrome's own PDF engine (`Page.printToPDF` through `chrome.debugger`). Bookmarks,
metadata and any live-rendered pages are added with [pdf-lib](https://pdf-lib.js.org/). For
Markdown and text, the same tab converts the pages instead (with
[Turndown](https://github.com/mixmark-io/turndown) for Markdown) and, for Markdown with images,
downloads the page images; nothing is printed. The background tab closes when the export is done.

## Supported Confluence

| Deployment | Supported | Notes |
|---|---|---|
| Confluence Cloud on `*.atlassian.net` | Yes | REST API v2 with v1/CQL fallbacks |
| Confluence Cloud on a custom domain | Yes | Detected from the page itself, not from the domain name |
| Confluence Data Center / Server 7.x and newer | Yes | REST API v1. Root installs and context paths such as `/confluence` both work |

Content types: pages, blog posts, folders (Cloud), and space overviews. Whiteboards, databases and
embeds have no printable content, so they appear in the TOC as link-only entries.

Browsers: Google Chrome and other Chromium-based browsers (Microsoft Edge, Brave, Arc, and so on),
version 120 or newer.

## Install

**Chrome Web Store:** *coming soon* (link will be added here once the listing is published).

**From source (load unpacked):**

```bash
npm ci
npm run build
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `.output/chrome-mv3` folder.
3. Pin the extension, open a Confluence page and click the toolbar icon.

For Microsoft Edge, run `npm run build -- -b edge` and load `.output/edge-mv3` at `edge://extensions`.

## Usage

1. Open any page, folder or space overview in Confluence.
2. Click the extension icon (or press **Alt+Shift+P** to export the current page straight away).
3. Pick a mode and options. If this is your first export from this site, allow access when Chrome asks.
4. For multi-page modes, review the preview, untick pages you don't want and click **Export**.
5. The PDF appears in your downloads.

## Permissions

| Permission | Why it is needed |
|---|---|
| `activeTab` | Reads the URL and Confluence page information of the current tab, only when you click the icon, use the shortcut or use the context menu. |
| `scripting` | Injects the extension's own bundled scripts (no remote code) into Confluence tabs on sites you allowed: to detect the page, fetch content and assemble the print document. |
| `debugger` | Prints the assembled document to a vector PDF with Chrome's `Page.printToPDF`. Without it, every export would need the print dialog. The extension attaches only to tabs it opened itself and detaches right after printing. |
| `downloads` | Saves the finished PDF, Markdown or text file (or ZIP) to your downloads folder. |
| `storage` | Keeps your settings (synced by Chrome if you use Chrome Sync), the progress of a running export (session-only), and reads managed policy set by an administrator. |
| `offscreen` | The background service worker can't create file URLs, so a hidden extension page turns the finished PDF, Markdown, text or ZIP bytes into a downloadable file. |
| `notifications` | Tells you when an export has finished or failed. |
| `contextMenus` | Adds "Export this page" and "Export this page + children" to the menu you get when you right-click a Confluence link. |
| Optional host access (`https://*/*`, `http://*/*`) | Confluence can run on any domain (Atlassian Cloud, custom domains, on-premise Data Center, sometimes plain HTTP inside company networks). Access is requested **one site at a time**, only when you export from that site. |

The extension does **not** request the `tabs`, `cookies`, `history`, `webRequest` or "all sites" permissions.

## Limitations

- **Debugger banner.** While a PDF is printing, Chrome shows a bar saying that *"Fast PDF Export
  for Confluence" started debugging this browser*. It goes away when printing is done. This is how
  Chrome signals `chrome.debugger` use and the extension can't hide it. Do not click "Cancel" on
  the bar during an export, because that stops the print. Markdown and text exports never show it.
- **Diagrams from Connect/Forge apps** (draw.io, Gliffy, Lucidchart, charts, roadmaps and similar)
  are drawn in the browser by those apps and are usually missing from Confluence's static export
  format. Turn on **Live render** to include them. Live render is slower (a few seconds per page)
  and depends on the app finishing its rendering within the timeout.
- **Chromium only.** Firefox and Safari don't support the APIs this extension needs.
- **Whiteboards, databases and embeds** are listed as links, not rendered.
- **Not pixel-identical** to Confluence's own PDF themes. Use custom CSS in the options to adjust styling.
- **Very large exports** (several hundred pages) are printed in batches (at most 400 pages per
  print) to keep memory in check. Links and table-of-contents entries work across batches. They
  still take a few minutes and need enough free memory.
- **Linked pages** (2 hops) stop following links after 2,000 items (or your administrator's page
  limit) and say so in the preview.
- **Draft pages** are never exported. **Archived pages** are excluded by default and can be included in the options.
- Attachments that aren't images (for example Office files or ZIPs) are not embedded. Links to them stay in the PDF.

## Troubleshooting

| Symptom | What to do |
|---|---|
| The popup says this is not a Confluence page | Open an actual page, folder or space overview, not a search result, dashboard or the editor of an unsaved draft. Custom-domain and Data Center sites are recognized from the page itself. Reload the tab once after installing the extension. |
| Nothing happens after allowing site access | Chrome may close the popup while it shows the permission prompt. The export should start automatically afterwards. If it doesn't, click the icon again. |
| You denied site access, or the export says it has no access to the site | Allow the site on the options page, or at `chrome://extensions` → *Details* → *Site access*. |
| The system print dialog opens instead of a download | Another extension or DevTools session may already be debugging the worker tab, or your administrator has disabled developer tools. The extension falls back to the browser's print dialog: choose **Save as PDF**. |
| Images are grey boxes with a filename | The image could not be loaded (deleted, no permission, or a timeout). Check that you can open the image in Confluence and try again. |
| A diagram or chart is missing | Turn on **Live render**. If the macro isn't detected, add its name to the live-render macro list in the options. |
| "Throttled by Confluence, retrying…" | Confluence is rate-limiting requests. The export continues on its own. Lower *API concurrency* in the options if it happens often. |
| Pages listed as *skipped* | You don't have permission to view them, or they were deleted, archived or are drafts. On a public site without signing in, pages that aren't public are skipped too ("This page isn't public"): sign in to include them. With a managed list of blocked spaces, a linked page whose space can't be determined is skipped as well. |
| You are logged out or SSO expired | The export stops with a sign-in message. Log in to Confluence in a normal tab, then export again. |
| "An export helper tab was closed" | The extension prints from a background tab next to your page (and, for live render, a few more). Closing it (or its window) stops the export. Leave these tabs alone until the export finishes; they close themselves. |
| The keyboard shortcut does nothing | Another extension may use **Alt+Shift+P**. Change the shortcut at `chrome://extensions/shortcuts`. |
| The export stops when the computer sleeps or the browser closes | Start it again. If Chrome stopped the extension in the background, **Try again** on the export page restarts it with the same pages (no new collection). Exports are not resumed across browser restarts. |

If the problem persists, open an issue with your Chrome version, Confluence flavour (Cloud or Data
Center plus version) and the error summary shown in the progress view. Please don't include page
content or other confidential information.
