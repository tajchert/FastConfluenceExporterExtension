# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Renamed the extension to **Fast Confluence Exporter (PDF & Markdown)** (short: "Fast Confluence Exporter"; previously "Fast PDF Export for Confluence"). PDF metadata (Creator) and generated-by lines use the new name; store images and screenshots updated.

## [1.1.0] - 2026-10-07

### Added

- **Markdown and plain-text export.** Besides PDF (still the default), every export can be saved
  as Markdown (`.md`, GitHub-flavoured: tables, fenced code with its language, task lists,
  panels as quotes, expands as `<details>`) or plain text (`.txt`). Pick the format in the popup
  for one export, in the preview, or as the default in Settings (managed policy:
  `defaultOptions.format`). Cover, table of contents and page details apply to every format;
  paper size, margins, page numbers, live render, wide-table fitting and custom CSS are PDF-only.
- Markdown can bundle the page images (on by default, `downloadImages`): the `.md` file and an
  `assets/` folder come in a ZIP with relative links. Images that can't be downloaded keep their
  Confluence URL and are listed in the export summary. Off: a single `.md` file that links to the
  images on Confluence.
- "One file per page (ZIP)" works for all formats: Markdown and text files are numbered in
  page-tree order (`01-…`, `02-…`) with an optional `00-Contents` index (cover and table of contents), and links between the
  exported pages point to the right file.
- Markdown and text exports don't print, so Chrome shows no "started debugging this browser" bar.

### Changed

- The context menu items read "Export this page" / "Export this page + children" and use the
  default format from Settings; notifications name the format ("Markdown export finished").

### Fixed

- Public Confluence sites can be exported without signing in: a network hiccup no longer stops
  the export with "please log in", and pages that aren't public are reported as such. On Data
  Center, a session that expires mid-export is reported once instead of as many "not found" pages.
- Data Center: links written as `/display/SPACE/Title` jump within the PDF; Gliffy and draw.io
  images are no longer sent to live render; the page tree macro gets a placeholder; hidden
  attachment details, empty settings boxes and "Getting issue details…" placeholders no longer
  print; Jira table headers repeat on every sheet; no trailing blank sheet after a page.
- Cloud: tiny links that land on `tinyurl.action` are recognized; non-page items at a space root
  (folders, whiteboards, …) and slides appear in the tree; empty Jira work-item tables become a
  placeholder; coloured text keeps its colour; links to another page's heading and to a space
  overview resolve inside the PDF; the "recently updated" spinner and "Show More" are dropped.
- Cloud uses REST API v2 for the helper tab and the popup's page lookup.

### Changed

- PDF bookmarks follow the page tree, with each page's headings below it; the TOC and the
  bookmarks agree when a page in the middle of the tree is skipped.
- The cover page is no longer numbered. Links and TOC entries to pages in another print batch
  (exports over 150 pages) now work.
- Cloud exports need one request per page instead of two; tree listings and linked-page lookups
  need far fewer requests. Linked pages (2 hops) stop at 2,000 items (or the managed page limit).
- Collecting pages for the preview shows progress and throttling and can be cancelled; the popup's
  page count is reused by the preview. Rows carry breadcrumbs.
- Drafts are never exported (also with "Include archived").
- The context menu only appears on Confluence links (and links of allowed sites) and never asks
  for site access itself.
- The short name is now "Fast PDF Export". `THIRD_PARTY_LICENSES.txt` ships with the extension.
- Privacy policy: discloses that images embedded in pages load from wherever they are hosted.

### Fixed

- Cancel also cancels a pending download, closes a helper tab that was still opening, and
  interrupts post-processing; an open "Save as" dialog is no longer reported as success.
- A permission grant can no longer start the same export twice, or start an old export.
- A failed space or author lookup is retried instead of remembered for the whole export; with
  blocked spaces, a linked page whose space can't be checked is skipped (fail closed).
- One failing branch no longer aborts a whole subtree/space collection; an unanswered request
  times out; an expired session stops the export with a sign-in message.
- Long exports no longer risk Chrome's 5-minute limit for a single service-worker request.
- Wide/Jira tables (right border, overlapping headers, column widths), uppercase h6 text in
  bookmarks, hidden marker text in copy/paste, empty page-tree macros dropped silently, tagged-PDF
  references of merged pages, and progress that jumped back to 0 %.

## [1.0.0] - 2026-10-06

First public release.

### Added

- Export modes: **This page**, **This page + children** (with a depth limit), **This folder**,
  **Pages linked from this page** (1 or 2 hops, de-duplicated, safe from cycles),
  **Choose pages from tree** (manual selection, tree order) and **Entire space**.
- Preview step for multi-page exports, where you can drop individual pages. Large exports trigger
  a warning (more than 150 pages) and need confirmation (more than 500 pages).
- One combined vector PDF with a cover page, a clickable table of contents, PDF bookmarks, a
  header block for each page, page numbers and PDF metadata. Links between exported pages jump
  inside the PDF.
- Option to export separate PDFs bundled in a ZIP.
- Visible placeholders with links for content that can't be printed statically (iframes, embeds,
  whiteboards, databases).
- Optional **Live render** for diagrams and charts drawn by browser apps, printed from the real
  page and merged into the PDF.
- PDF options: paper size, orientation, margins, cover, TOC, page metadata, comments, page
  numbers, archived pages, shrinking wide tables and custom CSS.
- Context menu on Confluence links and the **Alt+Shift+P** keyboard shortcut.
- Progress view with a cancel button, an error summary and a completion notification.
- Works with any Confluence Cloud site (including custom domains) and Confluence Data Center /
  Server 7.x and newer. Site access is requested at runtime, one site at a time.
- Enterprise managed policy: `blockedSpaceKeys`, `disableLiveRender`, `maxPages`, `defaultOptions`.

[Unreleased]: https://github.com/tajchert/FastConfluenceExporterExtension/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/tajchert/FastConfluenceExporterExtension/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tajchert/FastConfluenceExporterExtension/releases/tag/v1.0.0
