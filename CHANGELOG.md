# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/<owner>/confluence-fast-pdf-export/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/<owner>/confluence-fast-pdf-export/releases/tag/v1.0.0
