/**
 * Plain-text writer: readable UTF-8 text with `\n` line endings and no markup. Walks the
 * normalized DOM from ./prepare.ts and lays it out block by block.
 */
import type { CoverInfo } from '../messages';
import type { SiteInfo } from '../types';
import type { ConvertInput, ConvertedFile } from './types';
import type { PreparedExport, PreparedPage } from './prepare';
import { imageLabel, isBlockElement } from './prepare';
import { TYPE_LABELS, displayWidth, hostOf, isoMinute, padEnd, pageMeta, pageTitle, safeHttpUrl, tocEntries } from './shared';

const PAGE_SEPARATOR = '='.repeat(72);
const RULE = '-'.repeat(40);
const MAX_TABLE_WIDTH = 120;
/** Marks an empty line inside a code block, so the final tidy keeps blank runs in code as-is. */
const CODE_BLANK = '\ue000';

// ───────────────────────────── inline text ───────────────────────────────────────────────────

/** Collapses HTML whitespace; NBSP becomes a space, zero-width characters disappear. */
function collapseText(s: string): string {
  return s.replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '').replace(/[\s\u00a0]+/g, ' ');
}

/** Tidies an inline run: one space between words, `\n` from <br> kept, no blank edges. */
function cleanInline(s: string): string {
  const lines = s.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const out: string[] = [];
  for (const l of lines) {
    if (!l && out.length && !out[out.length - 1]) continue;
    out.push(l);
  }
  return out.join('\n');
}

function indent(text: string, prefix: string, firstPrefix = prefix): string {
  return text
    .split('\n')
    .map((l, i) => (l ? (i === 0 ? firstPrefix : prefix) + l : l))
    .join('\n');
}

/** Elements that are rendered as blocks even when written inside inline markup. */
function hasBlockContent(el: Element): boolean {
  for (const c of Array.from(el.children)) {
    if (isBlockElement(c) || c.hasAttribute('data-cf-panel') || c.hasAttribute('data-cf-expand')) return true;
    if (hasBlockContent(c)) return true;
  }
  return false;
}

function isBlockish(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  if (isBlockElement(el)) return true;
  if (el.hasAttribute('data-cf-placeholder')) return el.tagName !== 'SPAN';
  return hasBlockContent(el);
}

function sameUrl(text: string, url: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/^mailto:/i, '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  try {
    return norm(text) === norm(url) || norm(text) === norm(decodeURI(url));
  } catch {
    return norm(text) === norm(url);
  }
}

// ───────────────────────────── renderer ──────────────────────────────────────────────────────

/** Renders a node's children as a list of blocks (each block may span several lines). */
function renderChildren(el: Node): string[] {
  const out: string[] = [];
  let inline = '';
  const flush = () => {
    const t = cleanInline(inline);
    if (t) out.push(t);
    inline = '';
  };
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) inline += collapseText(child.textContent || '');
    else if (child.nodeType === 1) {
      if (isBlockish(child)) {
        flush();
        out.push(...renderBlock(child as Element));
      } else inline += renderInline(child as Element);
    }
  }
  flush();
  return out.filter((b) => b.trim());
}

function inlineText(el: Node): string {
  return cleanInline(
    Array.from(el.childNodes)
      .map((c) => (c.nodeType === 3 ? collapseText(c.textContent || '') : c.nodeType === 1 ? renderInline(c as Element) : ''))
      .join(''),
  );
}

function oneLine(blocks: string[]): string {
  return blocks
    .join(' ')
    .split(CODE_BLANK)
    .join('')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function inlineChildren(el: Element): string {
  return Array.from(el.childNodes)
    .map((c) => (c.nodeType === 3 ? collapseText(c.textContent || '') : c.nodeType === 1 ? renderInline(c as Element) : ''))
    .join('');
}

function renderInline(el: Element): string {
  if (el.hasAttribute('data-cf-anchor')) return '';
  if (el.hasAttribute('data-cf-status')) return `[${(el.textContent || '').trim()}]`;
  if (el.hasAttribute('data-cf-placeholder')) {
    const url = el.getAttribute('data-cf-url') || el.getAttribute('data-cf-page-url');
    return `[${el.getAttribute('data-cf-label') || 'Content'}${url ? `: ${url}` : ''}]`;
  }
  switch (el.tagName) {
    case 'BR':
      return '\n';
    case 'IMG': {
      const label = imageLabel(el);
      return label ? `[Image: ${label}]` : '';
    }
    case 'A': {
      const text = inlineText(el);
      const href = (el.getAttribute('href') || '').trim();
      if (!href || href.startsWith('#')) return text;
      const url = href.replace(/^mailto:/i, '');
      if (!text) return url;
      if (sameUrl(text, href)) return text;
      return `${text} (${url})`;
    }
    case 'SCRIPT':
    case 'STYLE':
      return '';
    case 'S':
    case 'DEL':
    case 'STRIKE': {
      if (hasBlockContent(el)) return '\n' + renderChildren(el).join('\n') + '\n';
      const inner = inlineChildren(el);
      const m = /^(\s*)([^]*?)(\s*)$/.exec(inner)!;
      return m[2] ? `${m[1]}~~${m[2]}~~${m[3]}` : inner;
    }
    default:
      if (hasBlockContent(el)) return '\n' + renderChildren(el).join('\n') + '\n';
      return Array.from(el.childNodes)
        .map((c) => (c.nodeType === 3 ? collapseText(c.textContent || '') : c.nodeType === 1 ? renderInline(c as Element) : ''))
        .join('');
  }
}

function heading(text: string, underline: string | null): string {
  const t = text.replace(/\s*\n\s*/g, ' ').trim();
  if (!t) return '';
  return underline ? `${t}\n${underline.repeat(Math.max(1, displayWidth(t)))}` : t;
}

function renderBlock(el: Element): string[] {
  if (el.hasAttribute('data-cf-placeholder')) {
    const parts = [`[${el.getAttribute('data-cf-label') || 'Content'}]`];
    const text = el.getAttribute('data-cf-text');
    if (text) parts.push(text);
    const url = el.getAttribute('data-cf-url');
    if (url) parts.push(url);
    const pageUrl = el.getAttribute('data-cf-page-url');
    if (pageUrl) parts.push(`(View it in Confluence: ${pageUrl})`);
    return [parts.join(' ')];
  }
  if (el.hasAttribute('data-cf-panel')) return [renderPanel(el)];
  if (el.hasAttribute('data-cf-expand')) {
    const title = el.getAttribute('data-cf-title') || 'Details';
    const body = renderChildren(el).join('\n\n');
    return [body ? `${title}\n${indent(body, '  ')}` : title];
  }
  switch (el.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const level = Number(el.getAttribute('data-cf-level')) || Number(el.tagName.charAt(1));
      return [heading(inlineText(el), level <= 1 ? '=' : level === 2 ? '-' : null)];
    }
    case 'UL':
    case 'OL':
      return [renderList(el)];
    case 'TABLE':
      return [renderTable(el)];
    case 'PRE':
      return [renderCode(el)];
    case 'HR':
      return [RULE];
    case 'BLOCKQUOTE': {
      const body = renderChildren(el).join('\n\n');
      return body ? [body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')] : [];
    }
    case 'DL': {
      const lines: string[] = [];
      for (const c of Array.from(el.children)) {
        const t = renderChildren(c).join('\n');
        if (!t) continue;
        lines.push(c.tagName === 'DD' ? indent(t, '  ') : t);
      }
      return lines.length ? [lines.join('\n')] : [];
    }
    case 'SCRIPT':
    case 'STYLE':
      return [];
    default:
      return renderChildren(el);
  }
}

function renderPanel(el: Element): string {
  const type = el.getAttribute('data-cf-panel') || '';
  const title = el.getAttribute('data-cf-panel-title') || '';
  const head = type ? `[${type}]${title ? ' ' + title : ''}` : title ? `[${title}]` : '';
  const blocks = renderChildren(el);
  if (!head) return blocks.join('\n\n');
  if (!blocks.length) return head;
  const first = blocks[0]!;
  // "[Info] First paragraph…" when the panel starts with plain text, body indented below.
  if (!title && !/^(- |\d+\. |\[[ x]\] |    |> )/.test(first) && !first.includes('\n')) {
    const rest = blocks.slice(1).join('\n\n');
    return rest ? `${head} ${first}\n\n${indent(rest, '  ')}` : `${head} ${first}`;
  }
  return `${head}\n${indent(blocks.join('\n\n'), '  ')}`;
}

function renderCode(el: Element): string {
  const title = el.getAttribute('data-cf-title');
  const code = (el.textContent || '')
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l.trim() ? '    ' + l.replace(/\s+$/, '') : CODE_BLANK))
    .join('\n');
  return title ? `${title}:\n\n${code}` : code;
}

function renderList(list: Element): string {
  const ordered = list.tagName === 'OL';
  const startAttr = Number(list.getAttribute('start'));
  let n = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
  const items: string[] = [];
  for (const child of Array.from(list.children)) {
    // Invalid but common: a nested list directly inside a list belongs to the previous item.
    if (child.tagName === 'UL' || child.tagName === 'OL') {
      const nested = renderList(child);
      if (!nested) continue;
      if (items.length) items[items.length - 1] += '\n' + indent(nested, '  ');
      else items.push(indent(nested, '  '));
      continue;
    }
    if (child.tagName !== 'LI') continue;
    const task = child.getAttribute('data-cf-task');
    const marker = task ? (task === 'done' ? '[x] ' : '[ ] ') : ordered ? `${n}. ` : '- ';
    n++;
    // Nested lists stay tight under their item; other blocks (code, paragraphs) get a blank line.
    const body = renderChildren(child).reduce(
      (acc, b) => (acc ? acc + (/^(- |\d+\. |\[[ x]\] )/.test(b) ? '\n' : '\n\n') + b : b),
      '',
    );
    // A code block first: the marker on a line of its own (`1.     code` would blur the two).
    if (body.startsWith('    ')) items.push(`${marker.trimEnd()}\n${indent(body, '  ')}`);
    else items.push(indent(body || '', '  ', marker) || marker.trimEnd());
  }
  return items.join('\n');
}

// ── tables ──

function renderTable(table: Element): string {
  const rows: Element[] = [];
  for (const c of Array.from(table.children)) {
    if (c.tagName === 'TR') rows.push(c);
    else if (['THEAD', 'TBODY', 'TFOOT'].includes(c.tagName)) rows.push(...Array.from(c.children).filter((r) => r.tagName === 'TR'));
  }
  const grid: string[][] = [];
  const pending: (number | undefined)[] = []; // rowspan carry-over per column
  let headerRows = 0;
  rows.forEach((row) => {
    const cells = Array.from(row.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    if (cells.length === 0) return;
    const out: string[] = [];
    let col = 0;
    const skipSpanned = () => {
      while ((pending[col] ?? 0) > 0) {
        pending[col]!--;
        out[col++] = '';
      }
    };
    for (const cell of cells) {
      skipSpanned();
      const text = oneLine(renderChildren(cell));
      const colspan = Math.max(1, Math.floor(Number(cell.getAttribute('colspan')) || 1));
      const rowspan = Math.max(1, Math.floor(Number(cell.getAttribute('rowspan')) || 1));
      for (let i = 0; i < colspan; i++) {
        out[col] = i === 0 ? text : '';
        if (rowspan > 1) pending[col] = rowspan - 1;
        col++;
      }
    }
    skipSpanned();
    grid.push(out.map((c) => c ?? ''));
    if (headerRows === grid.length - 1 && (row.parentElement?.tagName === 'THEAD' || cells.every((c) => c.tagName === 'TH'))) {
      headerRows = grid.length;
    }
  });
  if (grid.length === 0) return '';
  const cols = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < cols) r.push('');
  // Drop columns that are empty everywhere.
  const keep = Array.from({ length: cols }, (_, i) => grid.some((r) => r[i]!.trim()));
  const rowsOut = grid.map((r) => r.filter((_, i) => keep[i]));
  const n = rowsOut[0]?.length ?? 0;
  if (n === 0) return '';
  if (n === 1) return rowsOut.map((r) => r[0]).filter(Boolean).join('\n');

  const widths = Array.from({ length: n }, (_, i) => Math.max(...rowsOut.map((r) => displayWidth(r[i]!))));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (n - 1);
  // Trailing empty cells (spanned header cells, ragged rows) add nothing but separators.
  const used = (r: string[]) => r.slice(0, r.reduce((last, c, i) => (c.trim() ? i + 1 : last), 0));
  const header = Math.min(headerRows, rowsOut.length);
  if (total > MAX_TABLE_WIDTH) {
    const lines = rowsOut.map((r) => used(r).join(' | ').trim());
    if (header > 0 && header < lines.length) {
      const width = Math.min(MAX_TABLE_WIDTH, Math.max(...lines.slice(0, header).map(displayWidth)));
      lines.splice(header, 0, '-'.repeat(Math.max(3, width)));
    }
    return lines.join('\n');
  }
  const lines = rowsOut.map((r) => {
    const cells = used(r);
    return cells
      .map((c, i) => (i === cells.length - 1 ? c : padEnd(c, widths[i]!)))
      .join(' | ')
      .replace(/\s+$/, '');
  });
  // Only one header row is underlined (the last one when several).
  if (header > 0 && header < rowsOut.length) lines.splice(header, 0, widths.map((w) => '-'.repeat(w)).join('-+-'));
  return lines.join('\n');
}

// ───────────────────────────── document assembly ─────────────────────────────────────────────

function tidyText(s: string): string {
  const lines = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t\u00a0]+$/, ''));
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    // Empty lines inside code blocks are kept as they are (not counted as blank runs).
    if (l.includes(CODE_BLANK)) {
      const rest = l.split(CODE_BLANK).join('').replace(/[ \t\u00a0]+$/, '');
      if (!rest.trim()) {
        out.push('');
        blank = 0;
        continue;
      }
      out.push(rest);
      blank = 0;
      continue;
    }
    if (!l) {
      if (++blank > 2) continue;
    } else blank = 0;
    out.push(l);
  }
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out.join('\n') + '\n';
}

function coverBlock(cover: CoverInfo, site: SiteInfo, generatedBy: string): string {
  // Cloud sites are all titled "Confluence": the host name says more.
  const named = [cover.siteTitle, site.siteTitle].find((t) => t && t.trim() && t.trim().toLowerCase() !== 'confluence');
  const siteName = named?.trim() || hostOf(cover.sourceUrl) || hostOf(site.origin);
  const title = cover.title || 'Confluence export';
  const rows: [string, string][] = [];
  if (siteName) rows.push(['Site', siteName]);
  const source = safeHttpUrl(cover.sourceUrl);
  if (source) rows.push(['Source', source]);
  if (cover.spaceKey) rows.push(['Space', cover.spaceKey]);
  const exported = isoMinute(cover.exportedAt);
  if (exported) rows.push(['Exported', exported]);
  if (cover.exportedBy) rows.push(['Exported by', cover.exportedBy]);
  rows.push(['Pages', String(cover.pageCount)]);
  const w = Math.max(...rows.map(([k]) => k.length)) + 1;
  return [
    heading(title, '='),
    '',
    ...rows.map(([k, v]) => `${(k + ':').padEnd(w)} ${v}`),
    '',
    `Generated by ${generatedBy}`,
  ].join('\n');
}

function metaBlock(page: PreparedPage): string {
  const meta = pageMeta(page.ref, page.body);
  const lines: string[] = [];
  if (meta.breadcrumb.length) lines.push(`Path: ${meta.breadcrumb.join(' › ')}`);
  if (page.ref.type !== 'page' && page.ref.type !== 'blogpost') lines.push(`Type: ${TYPE_LABELS[page.ref.type] ?? page.ref.type}`);
  const updated = [meta.updated, meta.author ? `by ${meta.author}` : '', meta.version ? `(version ${meta.version})` : '']
    .filter(Boolean)
    .join(' ');
  if (updated) lines.push(`Last updated: ${updated}`);
  if (meta.url) lines.push(`URL: ${meta.url}`);
  return lines.join('\n');
}

interface Linker {
  /** Display reference for an exported page ('' = in this document), or null when not exported. */
  page(id: string): string | null;
}

function pageText(page: PreparedPage, input: ConvertInput, linker: Linker): string {
  const url = safeHttpUrl(page.body?.url || page.ref.url);
  const open = url ? ` Open it in Confluence: ${url}` : '';
  if (page.root) {
    try {
      levelHeadings(page.root);
      return renderChildren(page.root).join('\n\n');
    } catch (err) {
      // One broken page must never break the whole export.
      return `This page could not be converted (${String((err as Error)?.message || err)}).${open}`;
    }
  }
  if (page.linkOnly) {
    if (page.ref.type === 'folder') {
      const children = input.allPages.filter((p) => p.parentId === page.ref.id && linker.page(p.id) !== null);
      if (!children.length) return '';
      return [
        'This folder contains:',
        ...children.map((c) => {
          const where = linker.page(c.id);
          return `- ${pageTitle(c)}${where ? ` (${where})` : ''}`;
        }),
      ].join('\n');
    }
    const kind = (TYPE_LABELS[page.ref.type] ?? 'Item').toLowerCase();
    return `This ${kind} can't be exported as content.${open}`;
  }
  return `${page.unavailable || 'The content of this page is not available.'}${open}`;
}

/**
 * Content headings are demoted below the page title (h1 → h2, …), and many pages start at h2 or
 * h3: the page's top heading level is underlined with '-' so sections stand out from paragraphs.
 */
function levelHeadings(root: HTMLElement): void {
  const headings = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
  if (!headings.length) return;
  const top = Math.min(...headings.map((h) => Number(h.tagName.charAt(1))));
  const shift = Math.max(0, top - 2);
  for (const h of headings) h.setAttribute('data-cf-level', String(Number(h.tagName.charAt(1)) - shift));
}

function tocText(input: ConvertInput, prep: PreparedExport, linker: Linker): string {
  const entries = tocEntries(
    input.allPages,
    prep.pages.map((p) => p.ref),
    new Set(input.excludeIds ?? []),
  );
  return entries
    .map(({ ref, level }) => {
      const where = linker.page(ref.id);
      const kind = ref.type !== 'page' ? ` [${TYPE_LABELS[ref.type] ?? ref.type}]` : '';
      return `${'  '.repeat(level)}${pageTitle(ref)}${kind}${where ? ` (${where})` : ''}`;
    })
    .join('\n');
}

function pageSection(page: PreparedPage, input: ConvertInput, linker: Linker): string {
  const parts = [heading(pageTitle(page.ref, page.body), '=')];
  if (input.options.includePageMeta) {
    const meta = metaBlock(page);
    if (meta) parts.push(meta);
  }
  const body = pageText(page, input, linker);
  if (body) parts.push(body);
  return parts.join('\n\n');
}

export function writeText(prep: PreparedExport, input: ConvertInput): ConvertedFile[] {
  const byId = new Map(prep.pages.map((p) => [p.ref.id, p]));

  if (!input.separate) {
    const linker: Linker = { page: (id) => (byId.has(id) ? '' : null) };
    const sections: string[] = [];
    const front: string[] = [];
    if (input.cover) front.push(coverBlock(input.cover, input.site, input.generatedBy));
    if (input.toc) {
      const toc = tocText(input, prep, linker);
      if (toc) front.push(`${heading('Contents', '-')}\n\n${toc}`);
    }
    if (front.length) sections.push(front.join('\n\n\n'));
    for (const page of prep.pages) sections.push(pageSection(page, input, linker));
    return [{ path: `${input.baseName}.txt`, text: tidyText(sections.join(`\n\n${PAGE_SEPARATOR}\n\n`)) }];
  }

  const linker: Linker = { page: (id) => byId.get(id)?.file ?? null };
  const files: ConvertedFile[] = [];
  // The index file carries the cover and / or the table of contents.
  if (input.toc || input.cover) {
    const parts: string[] = [];
    if (input.cover) parts.push(coverBlock(input.cover, input.site, input.generatedBy));
    if (input.toc) {
      const toc = tocText(input, prep, linker);
      parts.push(`${heading('Contents', '-')}${toc ? `\n\n${toc}` : ''}`);
    }
    files.push({ path: '00-Contents.txt', text: tidyText(parts.join('\n\n\n')) });
  }
  for (const page of prep.pages) {
    files.push({ path: page.file!, text: tidyText(pageSection(page, input, linker)) });
  }
  return files;
}
