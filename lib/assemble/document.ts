/**
 * Builds the print document (cover, TOC, one <article> per page) inside the worker tab's own
 * document. The service worker then prints that tab with `Page.printToPDF`.
 */
import type { CoverInfo } from '../messages';
import type {
  ContentType,
  ExportOptions,
  FetchedPageInfo,
  PageRef,
  SiteInfo,
} from '../types';
import type { PageBody } from '../confluence/client';
import printCss from './print.css?inline';
import { effectiveMarginsMm, paperSizeMm } from './geometry';
import { buildPageIndex, sanitizePageHtml, type PageIndex } from './sanitize';

export interface AssembleInput {
  pages: { ref: PageRef; body?: PageBody; info?: FetchedPageInfo; live?: boolean }[]; // in order
  allPages: PageRef[];
  site: SiteInfo;
  options: ExportOptions;
  cover: CoverInfo | null;
  toc: boolean;
  generatedBy: string; // "Fast Confluence Exporter v1.0.0"
  /**
   * Ids from `allPages` that are NOT part of the final PDF (failed / skipped / pruned). They are
   * left out of the TOC and links to them keep pointing at Confluence.
   */
  excludeIds?: string[];
}

// ───────────────────────────── page geometry ─────────────────────────────────────────────────
// Pure helpers live in ./geometry so the service worker (lib/render/cdp.ts) can share them.
export { FOOTER_MIN_MARGIN_MM, effectiveMarginsMm, paperSizeMm } from './geometry';

const MM_TO_PX = 96 / 25.4;

/** Printable area in millimetres. */
export function contentBoxMm(options: ExportOptions): { width: number; height: number } {
  const sheet = paperSizeMm(options.paperSize, options.orientation);
  const m = effectiveMarginsMm(options);
  return {
    width: Math.max(50, sheet.width - m.left - m.right),
    height: Math.max(50, sheet.height - m.top - m.bottom),
  };
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** @page size/orientation/margins + print.css + the user's custom CSS (last, so it wins). */
export function buildPrintCss(options: ExportOptions): string {
  const sheet = paperSizeMm(options.paperSize, options.orientation);
  const m = effectiveMarginsMm(options);
  const box = contentBoxMm(options);
  const parts = [
    `@page { size: ${fmt(sheet.width)}mm ${fmt(sheet.height)}mm; margin: ${fmt(m.top)}mm ${fmt(m.right)}mm ${fmt(m.bottom)}mm ${fmt(m.left)}mm; }`,
    `:root { --cf-content-width: ${fmt(box.width)}mm; --cf-content-height: ${fmt(box.height)}mm; }`,
    printCss,
  ];
  const custom = (options.customCss ?? '').trim();
  if (custom) parts.push('/* custom CSS */', custom);
  return parts.join('\n');
}

// ───────────────────────────── small DOM helpers ─────────────────────────────────────────────

type Child = Node | string | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? doc.createTextNode(c) : c);
  }
  return node;
}

function safeHttpUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function link(doc: Document, href: string | undefined, text: string): Node {
  const url = safeHttpUrl(href);
  return url ? el(doc, 'a', { href: url }, text) : doc.createTextNode(text);
}

function formatDate(iso: string | undefined, withTime = false): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    });
  } catch {
    return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
  }
}

const TYPE_LABELS: Record<ContentType, string> = {
  page: 'Page',
  blogpost: 'Blog post',
  folder: 'Folder',
  whiteboard: 'Whiteboard',
  database: 'Database',
  embed: 'Smart link',
  slides: 'Slides',
};

const LINK_ONLY_TYPES = new Set<ContentType>(['folder', 'whiteboard', 'database', 'embed', 'slides']);

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── cover & TOC ───────────────────────────────────────────────────

function buildCover(doc: Document, cover: CoverInfo, site: SiteInfo, generatedBy: string): HTMLElement {
  const siteName = cover.siteTitle || site.siteTitle || hostOf(cover.sourceUrl) || hostOf(site.origin) || 'Confluence';
  const rows: [string, Node | string][] = [];
  const source = safeHttpUrl(cover.sourceUrl);
  if (source) rows.push(['Source', link(doc, source, source)]);
  if (cover.spaceKey) rows.push(['Space', cover.spaceKey]);
  const exported = formatDate(cover.exportedAt, true);
  if (exported) rows.push(['Exported', exported]);
  if (cover.exportedBy) rows.push(['Exported by', cover.exportedBy]);
  rows.push(['Pages', String(cover.pageCount)]);

  const table = el(
    doc,
    'table',
    { class: 'cf-cover-meta' },
    el(doc, 'tbody', {}, ...rows.map(([k, v]) => el(doc, 'tr', {}, el(doc, 'th', { scope: 'row' }, k), el(doc, 'td', {}, v)))),
  );

  const subtitle = [
    cover.spaceKey ? `Space ${cover.spaceKey}` : '',
    `${cover.pageCount} ${cover.pageCount === 1 ? 'page' : 'pages'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return el(
    doc,
    'section',
    { class: 'cf-cover', 'aria-label': 'Cover' },
    el(
      doc,
      'div',
      { class: 'cf-cover-inner' },
      el(doc, 'div', { class: 'cf-cover-site' }, siteName),
      // Not a heading on purpose: the PDF outline should list pages only.
      el(doc, 'div', { class: 'cf-cover-title' }, cover.title || 'Confluence export'),
      el(doc, 'div', { class: 'cf-cover-subtitle' }, subtitle),
      table,
    ),
    el(doc, 'div', { class: 'cf-cover-generator' }, `Generated by ${generatedBy}`),
  );
}

function tocLevelClass(level: number): string {
  return level <= 3 ? `cf-toc-l${level}` : 'cf-toc-deep';
}

/**
 * TOC levels of the pages in the PDF, from the full page list in tree order: a page sits under
 * its nearest ancestor that is in the PDF; children of a page that is not (failed / skipped)
 * take its place — the same rule as the PDF bookmarks (lib/pdf/merge.ts buildOutline).
 */
export function tocLevels(allPages: PageRef[], included: (id: string) => boolean): Map<string, number> {
  const levels = new Map<string, number>();
  const stack: { depth: number; level: number; included: boolean }[] = [];
  for (const p of allPages) {
    const depth = Number.isFinite(p.depth) ? p.depth : 0;
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const top = stack[stack.length - 1];
    const level = top ? top.level + (top.included ? 1 : 0) : 0;
    const inc = included(p.id);
    if (inc && !levels.has(p.id)) levels.set(p.id, level);
    stack.push({ depth, level, included: inc });
  }
  return levels;
}

function buildToc(doc: Document, allPages: PageRef[], included: (id: string) => boolean): HTMLElement {
  const root = el(doc, 'ol', { class: 'cf-toc-list' });
  const nav = el(
    doc,
    'nav',
    { class: 'cf-toc', 'aria-label': 'Table of contents' },
    el(doc, 'div', { class: 'cf-toc-title' }, 'Contents'),
    root,
  );
  const levels = tocLevels(allPages, included);
  const entries = allPages.filter((p, i) => levels.has(p.id) && allPages.findIndex((q) => q.id === p.id) === i);
  if (entries.length === 0) return nav;

  const stack: HTMLOListElement[] = [root];
  let lastLi: HTMLLIElement | null = null;

  for (const entry of entries) {
    // Never nest more than one level below the previous entry.
    const level = Math.min(levels.get(entry.id)!, lastLi ? stack.length : 0);
    if (level > stack.length - 1 && lastLi) {
      const ol = el(doc, 'ol');
      lastLi.append(ol);
      stack.push(ol);
    }
    while (stack.length - 1 > level) stack.pop();

    const entryDiv = el(doc, 'div', { class: 'cf-toc-entry' }, el(doc, 'a', { href: `#p-${entry.id}` }, entry.title || 'Untitled'));
    if (entry.type !== 'page') entryDiv.append(el(doc, 'span', { class: 'cf-toc-kind' }, TYPE_LABELS[entry.type] ?? entry.type));
    const li = el(doc, 'li', { class: tocLevelClass(level) }, entryDiv);
    stack[stack.length - 1]!.append(li);
    lastLi = li;
  }
  return nav;
}

// ───────────────────────────── page sections ─────────────────────────────────────────────────

function buildHeader(
  doc: Document,
  ref: PageRef,
  body: PageBody | undefined,
  info: FetchedPageInfo | undefined,
  options: ExportOptions,
): HTMLElement {
  const title = body?.title || ref.title || 'Untitled';
  const header = el(doc, 'header', { class: 'cf-page-meta' }, el(doc, 'h1', { class: 'cf-page-title' }, title));
  if (!options.includePageMeta) return header;

  const items: Node[] = [];
  const crumbs = (body?.breadcrumb?.length ? body.breadcrumb : ref.breadcrumb ?? []).filter((c) => c && c.trim());
  if (crumbs.length) items.push(el(doc, 'span', { class: 'cf-breadcrumb' }, crumbs.join(' › ')));
  if (ref.type !== 'page' && ref.type !== 'blogpost') items.push(el(doc, 'span', {}, TYPE_LABELS[ref.type] ?? ref.type));
  const updated = formatDate(body?.lastModified ?? info?.lastModified);
  if (updated) items.push(el(doc, 'span', {}, `Last updated ${updated}`));
  const author = body?.authorDisplayName ?? info?.authorDisplayName;
  if (author) items.push(el(doc, 'span', { class: 'cf-author' }, `by ${author}`));
  const version = body?.version ?? info?.version;
  if (version) items.push(el(doc, 'span', {}, `Version ${version}`));
  const url = safeHttpUrl(body?.url || ref.url);
  if (url) items.push(el(doc, 'span', {}, el(doc, 'a', { href: url }, 'Open in Confluence')));
  if (items.length) header.append(el(doc, 'div', { class: 'cf-page-info' }, ...items));
  return header;
}

function buildArticle(
  doc: Document,
  entry: AssembleInput['pages'][number],
  input: AssembleInput,
  exportedIds: Set<string>,
  pageIndex: PageIndex,
): HTMLElement {
  const { ref, body, info } = entry;
  const linkOnly = LINK_ONLY_TYPES.has(ref.type) || !!info?.linkOnly;
  const classes = ['cf-page'];
  if (ref.type === 'folder') classes.push('cf-section');
  if (entry.live) classes.push('cf-live');

  const article = el(doc, 'article', {
    class: classes.join(' '),
    id: `p-${ref.id}`,
    'data-page-id': ref.id,
    'data-type': ref.type,
  });
  article.append(buildHeader(doc, ref, body, info, input.options));
  const url = safeHttpUrl(body?.url || ref.url);

  if (entry.live) {
    article.append(
      el(
        doc,
        'div',
        { class: 'cf-live-slot', 'data-page-id': ref.id },
        el(
          doc,
          'p',
          { class: 'cf-live-note' },
          'This page contains diagrams or dynamic content. It is rendered from Confluence on the following pages.',
        ),
      ),
    );
    return article;
  }

  if (linkOnly && !body) {
    if (ref.type === 'folder') {
      const children = input.allPages.filter((p) => p.parentId === ref.id && exportedIds.has(p.id));
      if (children.length > 0) {
        article.append(
          el(
            doc,
            'div',
            { class: 'cf-linkonly cf-folder-contents' },
            el(doc, 'p', {}, 'This folder contains:'),
            el(doc, 'ul', {}, ...children.map((c) => el(doc, 'li', {}, el(doc, 'a', { href: `#p-${c.id}` }, c.title || 'Untitled')))),
          ),
        );
      }
      return article;
    }
    const kind = (TYPE_LABELS[ref.type] ?? 'Item').toLowerCase();
    const note = el(doc, 'p', { class: 'cf-linkonly' }, `This ${kind} can't be exported as content. `);
    if (url) note.append(el(doc, 'a', { href: url }, 'Open it in Confluence'));
    article.append(note);
    return article;
  }

  const content = el(doc, 'div', { class: 'cf-content' });
  if (body) {
    try {
      content.append(
        sanitizePageHtml(body.html, {
          pageId: ref.id,
          site: input.site,
          pageUrl: url ?? input.site.baseUrl,
          exportedIds,
          pageIndex,
          includeComments: input.options.includeComments,
        }),
      );
    } catch (err) {
      content.replaceChildren(unavailable(doc, url, `This page could not be processed (${errorMessage(err)}).`));
    }
  } else {
    content.append(unavailable(doc, url, 'The content of this page is not available.'));
  }
  article.append(content);
  return article;
}

function unavailable(doc: Document, url: string | undefined, text: string): HTMLElement {
  const p = el(doc, 'p', { class: 'cf-unavailable' }, text + ' ');
  if (url) p.append(el(doc, 'a', { href: url }, 'Open it in Confluence'));
  return p;
}

function errorMessage(err: unknown): string {
  const m = (err as { message?: unknown })?.message;
  return typeof m === 'string' && m ? m : String(err);
}

// ───────────────────────────── post-layout passes ────────────────────────────────────────────

/** Heading-id comparison key: case, hyphens, underscores and spaces ignored. */
function looseId(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, '');
}

/**
 * Cloud links to another page's heading use editor-style fragments (`#Included-Models`) while
 * export_view ids look like `PageTitle-IncludedModels`. Finds the heading id of page `pageId` that
 * ends with the fragment when hyphens and spaces are ignored (shortest such id wins).
 */
function looseHeadingTarget(byPage: Map<string, string[]>, pageId: string, frag: string): string | null {
  const want = looseId(frag);
  if (want.length < 3) return null;
  let best: string | null = null;
  for (const id of byPage.get(pageId) ?? []) {
    const rest = looseId(id.slice(`p${pageId}-`.length));
    if ((rest === want || rest.endsWith(want)) && (!best || id.length < best.length)) best = id;
  }
  return best;
}

/** Points in-document anchors whose target is missing at their page (or drops the link). */
function fixDanglingAnchors(doc: Document, documentPageIds: Set<string>): void {
  const ids = new Set<string>();
  /** page id → its prefixed content ids (`p{id}-…`) */
  const byPage = new Map<string, string[]>();
  for (const node of Array.from(doc.querySelectorAll('[id]'))) {
    ids.add(node.id);
    const m = /^p(\d+)-/.exec(node.id);
    if (m) {
      let list = byPage.get(m[1]!);
      if (!list) byPage.set(m[1]!, (list = []));
      list.push(node.id);
    }
  }
  for (const a of Array.from(doc.querySelectorAll('a[href^="#"]'))) {
    const href = a.getAttribute('href') || '';
    const fallback = a.getAttribute('data-cf-fallback');
    a.removeAttribute('data-cf-fallback');
    const raw = href.slice(1);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    if (ids.has(raw) || ids.has(decoded)) continue;
    // Page-level anchors may target a page printed in another batch: leave them alone.
    if (/^p-[^-]/.test(raw) && documentPageIds.has(raw.slice(2))) continue;
    const heading = /^p(\d+)-(.+)$/.exec(decoded);
    const loose = heading ? looseHeadingTarget(byPage, heading[1]!, heading[2]!) : null;
    if (loose) {
      a.setAttribute('href', `#${loose}`);
      continue;
    }
    if (fallback) {
      const fid = fallback.slice(1);
      if (ids.has(fid) || documentPageIds.has(fid.replace(/^p-/, ''))) {
        a.setAttribute('href', fallback);
        continue;
      }
    }
    a.removeAttribute('href');
  }
  for (const a of Array.from(doc.querySelectorAll('[data-cf-fallback]'))) a.removeAttribute('data-cf-fallback');
}

function availableWidth(table: HTMLElement): number {
  const parent = table.parentElement;
  if (!parent) return 0;
  const view = parent.ownerDocument.defaultView;
  let width = parent.clientWidth;
  if (view && width > 0) {
    const cs = view.getComputedStyle(parent);
    width -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  }
  return width;
}

/** Width the author gave the table in the editor (px), or 0 when unknown. */
function designWidth(table: HTMLElement): number {
  const attr = Number(table.getAttribute('data-table-width'));
  const cols = Array.from(table.querySelectorAll(':scope > colgroup > col')) as HTMLElement[];
  let sum = 0;
  for (const c of cols) {
    const m = /^([\d.]+)px$/.exec((c.style.width || '').trim());
    if (!m) {
      sum = 0;
      break;
    }
    sum += parseFloat(m[1]!);
  }
  return Math.max(Number.isFinite(attr) ? attr : 0, sum);
}

/**
 * Replaces fixed pixel widths (editor colgroups, inline table widths) with proportional ones.
 * Returns true when every column got a percentage width (a fixed layout then keeps them).
 */
function normalizeTableWidths(table: HTMLElement): boolean {
  table.removeAttribute('width');
  table.style.removeProperty('width');
  table.style.removeProperty('min-width');
  const cols = Array.from(table.querySelectorAll(':scope > colgroup > col')) as HTMLElement[];
  const px = cols.map((c) => {
    const v = c.style.width || c.getAttribute('width') || '';
    const m = /^([\d.]+)(px)?$/.exec(v.trim());
    return m ? parseFloat(m[1]!) : NaN;
  });
  const proportional = cols.length > 0 && px.every((n) => Number.isFinite(n) && n > 0);
  if (proportional) {
    const total = px.reduce((a, b) => a + b, 0);
    cols.forEach((c, i) => {
      c.removeAttribute('width');
      c.style.width = `${((px[i]! / total) * 100).toFixed(3)}%`;
    });
  } else {
    for (const c of cols) {
      c.removeAttribute('width');
      c.style.removeProperty('width');
    }
  }
  for (const cell of Array.from(table.querySelectorAll('th, td')) as HTMLElement[]) {
    if (cell.closest('table') !== table) continue;
    cell.style.removeProperty('min-width');
    if (/px$/.test(cell.style.width)) cell.style.removeProperty('width');
  }
  return proportional;
}

/**
 * Layout-dependent marking, done in as few layout passes as possible:
 *  - small pre/panels/blocks get `cf-keep` (break-inside: avoid); big ones may split across sheets;
 *  - tables wider than their container get `cf-wide`, then `cf-wide-xl` if still too wide;
 *    `cf-fixed` (fixed table layout) only when the author's column widths were kept as
 *    percentages — otherwise auto layout gives text-heavy columns more room.
 * In environments without layout (tests) every measurement is 0 and nothing harmful happens.
 */
function markLayout(doc: Document, options: ExportOptions): void {
  const box = contentBoxMm(options);
  const keepLimitPx = box.height * MM_TO_PX * 0.5;

  const blocks = Array.from(
    doc.querySelectorAll(
      '.cf-content pre, .cf-content .code.panel, .cf-content .confluence-information-macro, .cf-content .panel, .cf-content blockquote, .cf-content .cf-expand, .cf-content .toc-macro',
    ),
  ) as HTMLElement[];
  // Measure everything with the current classes removed so re-runs are idempotent.
  blocks.forEach((b) => b.classList.remove('cf-keep'));
  const heights = blocks.map((b) => b.getBoundingClientRect().height);
  blocks.forEach((b, i) => {
    if (heights[i]! <= keepLimitPx) b.classList.add('cf-keep');
  });

  if (!options.shrinkWideTables) return;
  const tables = (Array.from(doc.querySelectorAll('.cf-content table')) as HTMLElement[]).filter(
    (t) => !t.parentElement?.closest('table'),
  );
  const tooWide = (t: HTMLElement) => {
    const avail = availableWidth(t);
    return avail > 0 && Math.max(t.getBoundingClientRect().width, t.scrollWidth) > avail + 1;
  };
  // Tables designed wider than the sheet (editor "wide"/"full-width" layouts, pixel colgroups) are
  // squeezed by max-width: 100%; give them the smaller wide-table type so rows stay compact.
  const designedWide = (t: HTMLElement) => {
    const avail = availableWidth(t);
    return avail > 0 && designWidth(t) > avail * 1.15;
  };
  const wide = tables.filter((t) => tooWide(t) || designedWide(t));
  for (const t of wide) {
    if (normalizeTableWidths(t)) t.classList.add('cf-fixed');
    t.classList.add('cf-wide');
  }
  const stillWide = wide.filter(tooWide);
  for (const t of stillWide) t.classList.add('cf-wide-xl');
}

const layoutOptions = new WeakMap<Document, ExportOptions>();

/**
 * Re-runs the layout-dependent marks (keep-together blocks, wide tables) on a document built by
 * buildPrintDocument. waitForAssets() calls it once images have their real sizes.
 */
export function refreshLayoutMarks(doc: Document): void {
  const options = layoutOptions.get(doc);
  if (!options) return;
  try {
    markLayout(doc, options);
  } catch {
    // Layout marking is cosmetic; printing proceeds without it.
  }
}

// ───────────────────────────── entry point ───────────────────────────────────────────────────

export function buildPrintDocument(doc: Document, input: AssembleInput): void {
  const excluded = new Set(input.excludeIds ?? []);
  const inDocument = input.allPages.filter((p) => !excluded.has(p.id));
  const documentPageIds = new Set(inDocument.map((p) => p.id));
  for (const p of input.pages) if (!excluded.has(p.ref.id)) documentPageIds.add(p.ref.id);
  const exportedIds = new Set(documentPageIds);
  const pageIndex = buildPageIndex(
    [...input.pages.map((p) => ({ ...p.ref, url: p.body?.url ?? p.ref.url })), ...input.allPages].filter((p) => documentPageIds.has(p.id)),
    input.site,
  );

  const firstTitle = input.pages[0]?.body?.title || input.pages[0]?.ref.title;
  const title = input.cover?.title || firstTitle || 'Confluence export';

  const head = doc.createElement('head');
  head.append(
    el(doc, 'meta', { charset: 'utf-8' }),
    // Images embedded in pages may come from other hosts: never tell them which Confluence
    // site (possibly an internal host name) the export is reading from.
    el(doc, 'meta', { name: 'referrer', content: 'no-referrer' }),
    el(doc, 'meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
    el(doc, 'meta', { name: 'generator', content: input.generatedBy }),
    el(doc, 'title', {}, title),
  );
  const style = doc.createElement('style');
  style.id = 'cf-print-css';
  style.textContent = buildPrintCss(input.options);
  head.append(style);

  const main = el(doc, 'main', { class: 'cf-doc' });
  if (input.cover) main.append(buildCover(doc, input.cover, input.site, input.generatedBy));
  if (input.toc) {
    if (inDocument.length > 0) main.append(buildToc(doc, input.allPages, (id) => !excluded.has(id)));
    else main.append(buildToc(doc, input.pages.map((p) => p.ref), () => true));
  }

  const seen = new Set<string>();
  for (const entry of input.pages) {
    if (seen.has(entry.ref.id) || excluded.has(entry.ref.id)) continue;
    seen.add(entry.ref.id);
    try {
      main.append(buildArticle(doc, entry, input, exportedIds, pageIndex));
    } catch (err) {
      // One broken page must never break the whole export.
      const article = el(doc, 'article', { class: 'cf-page', id: `p-${entry.ref.id}`, 'data-page-id': entry.ref.id });
      article.append(
        buildHeader(doc, entry.ref, undefined, entry.info, input.options),
        unavailable(doc, safeHttpUrl(entry.ref.url), `This page could not be assembled (${errorMessage(err)}).`),
      );
      main.append(article);
    }
  }

  // Pages printed in another batch: a zero-size target per page keeps Chrome from dropping the
  // TOC entries and links that point at them (it drops links to ids missing in the printed
  // document). The resulting `/p-{id}` destination in this batch is a placeholder: when the
  // batches are merged, the batch holding the real section owns the name (concatPdfs `owner`).
  // Not display:none — Chrome needs a laid-out box to emit the link and destination.
  const elsewhere = [...documentPageIds].filter((id) => !seen.has(id));
  if (elsewhere.length) {
    main.append(
      ...elsewhere.map((id) =>
        el(doc, 'span', {
          id: `p-${id}`,
          class: 'cf-xbatch',
          'aria-hidden': 'true',
          style: 'position:absolute;width:0;height:0;overflow:hidden',
        }),
      ),
    );
  }

  // Chrome only emits a named destination (`/p-{id}`) for an id that some `<a href="#id">` in the
  // same printed document targets. Batches after the first (no TOC) and exports without a TOC
  // would otherwise have no destinations for lib/pdf/merge.ts to locate sections (live-render
  // inserts, rebuilt outline). Links inside display:none create destinations but no link boxes.
  if (seen.size) {
    main.append(
      el(
        doc,
        'div',
        { class: 'cf-dests', 'aria-hidden': 'true', style: 'display:none' },
        ...[...seen].map((id) => el(doc, 'a', { href: `#p-${id}`, tabindex: '-1' })),
      ),
    );
  }

  const body = doc.createElement('body');
  body.append(main);
  doc.documentElement.replaceChildren(head, body);
  doc.title = title;

  fixDanglingAnchors(doc, documentPageIds);
  layoutOptions.set(doc, input.options);
  refreshLayoutMarks(doc);
}
