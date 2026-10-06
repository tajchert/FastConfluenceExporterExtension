/**
 * GitHub-flavoured Markdown writer (turndown + a few rules for Confluence's normalized markers,
 * see ./prepare.ts). Runs in the worker tab (needs a DOM).
 */
import TurndownService from 'turndown';
import { strikethrough } from '@joplin/turndown-plugin-gfm';
import type { CoverInfo } from '../messages';
import type { ConvertInput, ConvertedFile } from './types';
import type { PreparedExport, PreparedPage } from './prepare';
import { imageLabel, isBlockElement } from './prepare';
import {
  TYPE_LABELS,
  encodeFragment,
  encodeRelPath,
  escapeHtml,
  mdUrl,
  pageMeta,
  pageTitle,
  safeHttpUrl,
  tocEntries,
  yamlString,
} from './shared';

// ───────────────────────────── escaping ──────────────────────────────────────────────────────

const WORD = /[\p{L}\p{N}]/u;

/**
 * Escapes text so it renders literally in GFM. Stricter than turndown's default where GFM needs
 * it (`<tag>`, entities, `1)` lists, `~~`) and quieter for intra-word underscores (snake_case).
 */
export function escapeMarkdown(text: string): string {
  let s = text
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
  s = s.replace(/_/g, (_m, i: number, all: string) =>
    i > 0 && i < all.length - 1 && WORD.test(all[i - 1]!) && WORD.test(all[i + 1]!) ? '_' : '\\_',
  );
  if ((s.match(/~/g) ?? []).length >= 2) s = s.replace(/~/g, '\\~');
  // Line-start syntax: turndown strips the leading whitespace of a line (block start, after <br>)
  // before escaping, so a text node that starts with whitespace sits mid-line.
  return s
    .replace(/^-(?=\s|$)/, '\\-')
    .replace(/^\+(?=\s|$)/, '\\+')
    .replace(/^(=+)/, '\\$1')
    .replace(/^(#{1,6})(?=\s|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
}

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const n = runs.reduce((m, r) => Math.max(m, r.length), 0) + 1;
  const fence = '`'.repeat(n);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function trimNewlines(s: string): string {
  return s.replace(/^\n+/, '').replace(/\n+$/, '');
}

function quote(s: string): string {
  return s
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** First line starts a paragraph (not a list, table, heading, quote, fence, HTML block…). */
function startsWithParagraph(md: string): boolean {
  return !!md && !/^(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,}|\||<|!\[|\s{4})/.test(md);
}

// ───────────────────────────── emphasis ──────────────────────────────────────────────────────

const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
/** Inline elements whose Markdown starts and ends with punctuation (`[`, `` ` ``, `*`, `<`, `!`…). */
const MARKUP_INLINE = new Set(['A', 'CODE', 'IMG', 'STRONG', 'B', 'EM', 'I', 'SUP', 'SUB', 'S', 'DEL', 'STRIKE']);

/**
 * The character rendered right outside `node` in direction `dir`: '' at a line edge (block
 * boundary, <br>), '.' for neighbouring Markdown markup (which always ends in punctuation).
 */
function outerChar(node: Node, dir: 'previousSibling' | 'nextSibling'): string {
  const edge = (t: string) => (dir === 'previousSibling' ? Array.from(t).pop() : Array.from(t)[0]) ?? '';
  let cur: Node = node;
  for (;;) {
    let sib = cur[dir];
    while (sib) {
      if (sib.nodeType === 3) {
        const t = sib.textContent || '';
        if (t) return SPACE.test(edge(t)) ? ' ' : edge(t);
      } else if (sib.nodeType === 1) {
        const el = sib as Element;
        if (el.tagName === 'BR' || isBlockElement(el)) return '';
        if (MARKUP_INLINE.has(el.tagName)) return '.';
        const t = el.textContent || '';
        if (t) return SPACE.test(edge(t)) ? ' ' : edge(t);
      }
      sib = sib[dir];
    }
    const parent = cur.parentNode;
    if (!parent || parent.nodeType !== 1 || isBlockElement(parent) || !(parent as Element).parentNode) return '';
    if (MARKUP_INLINE.has((parent as Element).tagName)) return '.';
    cur = parent;
  }
}

/**
 * Whether `*`/`**` delimiters around `content` open and close emphasis in CommonMark: the opener
 * must be left-flanking and the closer right-flanking. Content that starts (ends) with punctuation
 * needs whitespace, punctuation or a line edge outside it, e.g. `tests<strong>.</strong> We`
 * can't be written as `tests**.** We`.
 */
function delimitable(content: string, node: Node): boolean {
  const chars = Array.from(content);
  const first = chars[0];
  const last = chars[chars.length - 1];
  if (!first || !last || SPACE.test(first) || SPACE.test(last)) return false;
  const loose = (c: string) => c === '' || SPACE.test(c) || PUNCT.test(c);
  // Whitespace at the element's edges is written outside the delimiters by turndown.
  const text = node.textContent || '';
  const before = () => (/^\s/u.test(text) ? ' ' : outerChar(node, 'previousSibling'));
  const after = () => (/\s$/u.test(text) ? ' ' : outerChar(node, 'nextSibling'));
  if (PUNCT.test(first) && !loose(before())) return false;
  if (PUNCT.test(last) && !loose(after())) return false;
  return true;
}

function emphasis(content: string, node: Node, delimiter: string, tag: 'strong' | 'em'): string {
  if (!content.trim()) return '';
  const parent = node.parentNode as Element | null;
  // `*…*` directly inside `**…**` easily mis-nests (`***`, `\**`); HTML always nests correctly.
  const nested =
    tag === 'em' && !!parent && (parent.tagName === 'STRONG' || parent.tagName === 'B') && !/^[\p{L}\p{N}](?:.*[\p{L}\p{N}])?$/su.test(content);
  if (!nested && delimitable(content, node)) return delimiter + content + delimiter;
  return `<${tag}>${content}</${tag}>`;
}

// ───────────────────────────── tables ────────────────────────────────────────────────────────

const COMPLEX_CELL_CONTENT =
  'pre, ul, ol, table, h1, h2, h3, h4, h5, h6, blockquote, hr, dl, details, [data-cf-panel], [data-cf-expand], div[data-cf-placeholder]';

function tableRows(table: Element): Element[] {
  const rows: Element[] = [];
  for (const c of Array.from(table.children)) {
    if (c.tagName === 'TR') rows.push(c);
    else if (c.tagName === 'THEAD' || c.tagName === 'TBODY' || c.tagName === 'TFOOT') {
      for (const r of Array.from(c.children)) if (r.tagName === 'TR') rows.push(r);
    }
  }
  return rows.filter((r) => cellsOf(r).length > 0);
}

function cellsOf(row: Element): Element[] {
  return Array.from(row.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
}

function span(cell: Element, attr: 'colspan' | 'rowspan'): number {
  const n = Number(cell.getAttribute(attr) || '1');
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
}

/** Index of the header row for a GFM table, or -1 when the table must stay HTML. */
function simpleTableHeader(rows: Element[]): number {
  if (rows.length === 0) return -1;
  for (const row of rows) {
    for (const cell of cellsOf(row)) {
      if (span(cell, 'colspan') > 1 || span(cell, 'rowspan') > 1) return -1;
      if (cell.querySelector(COMPLEX_CELL_CONTENT)) return -1;
    }
  }
  const theadRows = rows.filter((r) => r.parentElement?.tagName === 'THEAD');
  if (theadRows.length > 1) return -1;
  if (theadRows.length === 1) return rows.indexOf(theadRows[0]!) === 0 ? 0 : -1;
  // Header rows written as <th> in the body: only one leading row may be a header.
  const allTh = (r: Element) => cellsOf(r).every((c) => c.tagName === 'TH');
  if (rows.length > 1 && allTh(rows[0]!) && allTh(rows[1]!)) return -1;
  return 0; // first row (header or not) becomes the GFM header
}

const KEEP_ATTRS: Record<string, string[]> = {
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan'],
  A: ['href', 'id'],
  IMG: ['src', 'alt'],
  OL: ['start'],
};

/** A table that GFM can't express, as compact HTML without styling attributes. */
function cleanTableHtml(table: Element): string {
  const doc = table.ownerDocument;
  const clone = table.cloneNode(true) as Element;
  for (const a of Array.from(clone.querySelectorAll('a[data-cf-anchor]'))) {
    a.setAttribute('id', a.getAttribute('data-cf-anchor') || '');
  }
  for (const s of Array.from(clone.querySelectorAll('[data-cf-status]'))) {
    const code = doc.createElement('code');
    code.textContent = s.textContent;
    s.replaceWith(code);
  }
  for (const pre of Array.from(clone.querySelectorAll('pre'))) {
    const out = doc.createElement('pre');
    (pre.textContent || '').split('\n').forEach((line, i) => {
      if (i > 0) out.appendChild(doc.createElement('br'));
      out.appendChild(doc.createTextNode(line));
    });
    pre.replaceWith(out);
  }
  for (const ph of Array.from(clone.querySelectorAll('[data-cf-placeholder]'))) {
    const out = doc.createElement('span');
    const em = doc.createElement('em');
    em.textContent = ph.getAttribute('data-cf-label') || 'Content';
    out.append(em);
    const text = ph.getAttribute('data-cf-text');
    if (text) out.append(' ' + text);
    for (const [attr, label] of [['data-cf-url', ''], ['data-cf-page-url', 'View it in Confluence']] as const) {
      const href = ph.getAttribute(attr);
      if (!href) continue;
      const a = doc.createElement('a');
      a.setAttribute('href', href);
      a.textContent = label || href;
      out.append(' ', a);
    }
    ph.replaceWith(out);
  }
  for (const p of Array.from(clone.querySelectorAll('[data-cf-panel]'))) {
    const type = p.getAttribute('data-cf-panel') || '';
    const title = p.getAttribute('data-cf-panel-title') || '';
    if (type || title) {
      const head = doc.createElement('p');
      const strong = doc.createElement('strong');
      strong.textContent = type ? `${type}:` : title;
      head.append(strong);
      if (type && title) head.append(' ' + title);
      p.insertBefore(head, p.firstChild);
    }
  }
  for (const e of Array.from(clone.querySelectorAll('[data-cf-expand]'))) {
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = e.getAttribute('data-cf-title') || 'Details';
    details.append(summary);
    while (e.firstChild) details.appendChild(e.firstChild);
    e.replaceWith(details);
  }
  for (const li of Array.from(clone.querySelectorAll('li[data-cf-task]'))) {
    li.insertBefore(doc.createTextNode(li.getAttribute('data-cf-task') === 'done' ? '☑ ' : '☐ '), li.firstChild);
  }
  for (const c of Array.from(clone.querySelectorAll('colgroup, col'))) c.remove();
  for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    const keep = KEEP_ATTRS[el.tagName] ?? [];
    for (const attr of Array.from(el.attributes)) {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
      else if ((attr.name === 'colspan' || attr.name === 'rowspan') && span(el, attr.name) === 1) el.removeAttribute(attr.name);
    }
  }
  for (const s of Array.from(clone.querySelectorAll('span, font, u, ins, mark'))) {
    if (s.attributes.length === 0) {
      const parent = s.parentNode;
      if (!parent) continue;
      while (s.firstChild) parent.insertBefore(s.firstChild, s);
      s.remove();
    }
  }
  return clone.outerHTML
    .replace(/\s*\n\s*/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/<(tr|thead|tbody|tfoot)>/g, '\n<$1>')
    .replace(/<\/table>$/, '\n</table>');
}

// ───────────────────────────── turndown service ──────────────────────────────────────────────

interface Services {
  main: TurndownService;
  cell: TurndownService;
}

function createService(br: string, services: Partial<Services>): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br,
  });
  service.escape = escapeMarkdown;
  service.use(strikethrough);

  service.addRule('cfStrong', {
    filter: ['strong', 'b'],
    replacement: (content, node) => emphasis(content, node, '**', 'strong'),
  });

  service.addRule('cfEmphasis', {
    filter: ['em', 'i'],
    replacement: (content, node) => emphasis(content, node, '*', 'em'),
  });

  service.addRule('cfSupSub', {
    filter: ['sup', 'sub'],
    replacement: (content, node) => {
      const tag = node.nodeName.toLowerCase();
      return content.trim() ? `<${tag}>${content}</${tag}>` : '';
    },
  });

  service.addRule('cfHeading', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (content, node) => {
      const level = Number(node.nodeName.charAt(1));
      // A closing `#` run after a space would be read as the optional closing sequence.
      const text = content
        .replace(/\s*(?:<br>|\\)?\n+\s*/g, ' ')
        .trim()
        .replace(/(\s)(#+)$/, '$1\\$2');
      if (!text) return '';
      return `\n\n${'#'.repeat(level)} ${text}\n\n`;
    },
  });

  service.addRule('cfListItem', {
    filter: 'li',
    replacement: (content, node) => {
      const li = node as HTMLElement;
      const parent = li.parentNode as Element | null;
      let prefix = '- ';
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start'));
        const index = Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(li);
        prefix = `${(Number.isFinite(start) && start > 0 ? start : 1) + index}. `;
      }
      const task = li.getAttribute('data-cf-task');
      const box = task ? (task === 'done' ? '[x] ' : '[ ] ') : '';
      const isParagraph = /\n$/.test(content);
      let body = trimNewlines(content) + (isParagraph ? '\n' : '');
      // Continuation lines are indented; empty lines stay empty (also inside code blocks).
      body = body.replace(/\n(?=[^\n])/g, '\n' + ' '.repeat(prefix.length));
      return prefix + box + body + (li.nextSibling ? '\n' : '');
    },
  });

  service.addRule('cfListBreak', {
    filter: (node) => (node as HTMLElement).hasAttribute?.('data-cf-list-break'),
    // Two lists separated only by a blank line merge into one list in CommonMark.
    replacement: () => '\n\n<!-- -->\n\n',
  });

  service.addRule('cfCode', {
    filter: 'pre',
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const text = (pre.textContent || '').replace(/\s+$/, '');
      const lang = pre.getAttribute('data-cf-lang') || '';
      const title = pre.getAttribute('data-cf-title') || '';
      const longest = (text.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      const head = title ? `**${escapeMarkdown(title)}**\n\n` : '';
      return `\n\n${head}${fence}${lang}\n${text}\n${fence}\n\n`;
    },
  });

  service.addRule('cfInlineCode', {
    filter: (node) => node.nodeName === 'CODE' && !(node.parentNode as Element | null)?.closest?.('pre'),
    replacement: (_content, node) => {
      const text = (node.textContent || '').replace(/\s*\n\s*/g, ' ');
      if (!text.trim()) return '';
      // `<code><a href>x</a></code>`: a code span can't hold a link, so the link wraps the code.
      const link = (node as HTMLElement).querySelector('a[href]');
      const href = link?.getAttribute('href');
      if (link && href && (link.textContent || '').trim() === text.trim()) {
        return `[${codeSpan(text.trim())}](${/^[a-z][a-z0-9+.-]*:/i.test(href) ? mdUrl(href) : href})`;
      }
      return codeSpan(text);
    },
  });

  service.addRule('cfAnchor', {
    filter: (node) => node.nodeName === 'A' && (node as HTMLElement).hasAttribute('data-cf-anchor'),
    replacement: (_content, node) => `<a id="${escapeHtml((node as HTMLElement).getAttribute('data-cf-anchor') || '')}"></a>`,
  });

  service.addRule('cfLink', {
    filter: (node) => node.nodeName === 'A' && !!(node as HTMLElement).getAttribute('href'),
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') || '';
      const text = content.trim();
      if (!text) return '';
      const absolute = /^[a-z][a-z0-9+.-]*:/i.test(href);
      // Bare URLs as autolinks: <https://example.com/x>
      if (/^https?:\/\/[^\s<>]+$/i.test(href) && (text === href || text === escapeMarkdown(href))) return `<${href}>`;
      return `[${text}](${absolute ? mdUrl(href) : href})`;
    },
  });

  service.addRule('cfImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const img = node as HTMLElement;
      const src = img.getAttribute('src') || '';
      if (!src) return '';
      const alt = (img.getAttribute('alt') || imageLabel(img)).replace(/\s+/g, ' ').trim().replace(/([\\[\]])/g, '\\$1');
      const dest = img.hasAttribute('data-cf-asset') ? src : mdUrl(src);
      return `![${alt}](${dest})`;
    },
  });

  service.addRule('cfStatus', {
    filter: (node) => (node as HTMLElement).hasAttribute?.('data-cf-status'),
    replacement: (_content, node) => {
      const text = (node.textContent || '').trim();
      return text ? codeSpan(text) : '';
    },
  });

  service.addRule('cfPlaceholder', {
    filter: (node) => (node as HTMLElement).hasAttribute?.('data-cf-placeholder'),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const label = escapeMarkdown(el.getAttribute('data-cf-label') || 'Content');
      const url = el.getAttribute('data-cf-url');
      const pageUrl = el.getAttribute('data-cf-page-url');
      const linkTo = (u: string, text?: string) =>
        text ? `[${text}](${mdUrl(u)})` : /^[^\s<>]+$/.test(u) ? `<${u}>` : `[${escapeMarkdown(u)}](${mdUrl(u)})`;
      if (el.tagName === 'SPAN') {
        const target = url || pageUrl;
        return target ? `*[${label}](${mdUrl(target)})*` : `*${label}*`;
      }
      const parts = [`**${label}**`];
      const text = el.getAttribute('data-cf-text');
      if (text) parts.push('— ' + escapeMarkdown(text));
      const links: string[] = [];
      if (url) links.push(linkTo(url));
      if (pageUrl) links.push(linkTo(pageUrl, 'View it in Confluence'));
      return `\n\n${quote([parts.join(' '), links.join(' · ')].filter(Boolean).join(' '))}\n\n`;
    },
  });

  service.addRule('cfPanel', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).hasAttribute('data-cf-panel'),
    replacement: (content, node) => {
      const el = node as HTMLElement;
      const type = el.getAttribute('data-cf-panel') || '';
      const title = el.getAttribute('data-cf-panel-title') || '';
      const header = type ? `**${type}:**${title ? ' ' + escapeMarkdown(title) : ''}` : title ? `**${escapeMarkdown(title)}**` : '';
      const body = trimNewlines(content);
      let md: string;
      if (!header) md = body;
      else if (!body) md = header;
      else if (!title && startsWithParagraph(body)) md = `${header} ${body}`;
      else md = `${header}\n\n${body}`;
      return md ? `\n\n${quote(md)}\n\n` : '';
    },
  });

  service.addRule('cfExpand', {
    filter: (node) => node.nodeName === 'DIV' && (node as HTMLElement).hasAttribute('data-cf-expand'),
    replacement: (content, node) => {
      const title = (node as HTMLElement).getAttribute('data-cf-title') || 'Details';
      const body = trimNewlines(content);
      return `\n\n<details>\n<summary>${escapeHtml(title)}</summary>\n\n${body}${body ? '\n\n' : ''}</details>\n\n`;
    },
  });

  service.addRule('cfTable', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as HTMLElement;
      // Nested tables are emitted by the outermost table (as HTML).
      if (table.parentElement?.closest('table')) return '';
      const rows = tableRows(table);
      if (rows.length === 0) return '';
      const header = simpleTableHeader(rows);
      if (header < 0) return `\n\n${cleanTableHtml(table)}\n\n`;
      const cellService = services.cell ?? service;
      const grid = rows.map((r) => cellsOf(r).map((c) => cellMarkdown(cellService, c)));
      const cols = Math.max(...grid.map((r) => r.length));
      const line = (cells: string[]) =>
        '| ' + Array.from({ length: cols }, (_, i) => cells[i] ?? '').map((c) => c || ' ').join(' | ') + ' |';
      const out = [line(grid[header]!), '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |'];
      grid.forEach((r, i) => {
        if (i !== header) out.push(line(r));
      });
      const caption = table.querySelector(':scope > caption')?.textContent?.trim();
      return `\n\n${caption ? `*${escapeMarkdown(caption)}*\n\n` : ''}${out.join('\n').replace(/ {2,}\|/g, ' |')}\n\n`;
    },
  });

  return service;
}

function cellMarkdown(service: TurndownService, cell: Element): string {
  const md = service.turndown(cell as HTMLElement);
  return md
    .replace(/<br>\n/g, '<br>')
    .replace(/\n+/g, '<br>')
    .replace(/(?:<br>)+$/g, '')
    .replace(/^(?:<br>)+/g, '')
    .replace(/\|/g, '\\|')
    .trim();
}

function services(): Services {
  const partial: Partial<Services> = {};
  partial.cell = createService('<br>', partial);
  partial.main = createService('\\', partial);
  return partial as Services;
}

// ───────────────────────────── post-processing ───────────────────────────────────────────────

/**
 * Trailing whitespace off, whitespace-only lines emptied, at most one blank line in a row —
 * outside fenced code blocks, which are left byte-for-byte. Ends with exactly one newline.
 */
export function tidyMarkdown(md: string): string {
  const out: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let blank = 0;
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    // An opening fence may follow a list marker (`1. ```` when a list item starts with code).
    const m = /^((?:>\s?)*)((?:\s*(?:[-+*]|\d{1,9}[.)])\s+)?)\s*(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      out.push(raw);
      if (m && !m[2] && m[3]!.charAt(0) === fence.char && m[3]!.length >= fence.len && /^((?:>\s?)*)\s*[`~]+\s*$/.test(raw)) fence = null;
      continue;
    }
    if (m) fence = { char: m[3]!.charAt(0), len: m[3]!.length };
    const line = raw.replace(/[ \t\u00a0]+$/, '');
    if (!line.replace(/^(?:>\s?)*/, '').trim() && !/^>/.test(line)) {
      if (++blank > 1) continue;
      out.push('');
      continue;
    }
    blank = 0;
    out.push(line);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}

// ───────────────────────────── document assembly ─────────────────────────────────────────────

function frontMatter(fields: [string, string | number | string[] | undefined][]): string {
  const lines = ['---'];
  for (const [k, v] of fields) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (typeof v === 'number') lines.push(`${k}: ${v}`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.map(yamlString).join(', ')}]`);
    else lines.push(`${k}: ${yamlString(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function coverFrontMatter(cover: CoverInfo, generatedBy: string): string {
  return frontMatter([
    ['title', cover.title || 'Confluence export'],
    ['source', safeHttpUrl(cover.sourceUrl)],
    ['space', cover.spaceKey],
    ['exported', cover.exportedAt],
    ['exported_by', cover.exportedBy],
    ['pages', cover.pageCount],
    ['generator', generatedBy],
  ]);
}

function pageFrontMatter(page: PreparedPage): string {
  const meta = pageMeta(page.ref, page.body);
  return frontMatter([
    ['title', pageTitle(page.ref, page.body)],
    ['id', page.ref.id],
    ['type', page.ref.type !== 'page' ? page.ref.type : undefined],
    ['space', page.body?.spaceKey || page.ref.spaceKey],
    ['url', meta.url],
    ['breadcrumb', meta.breadcrumb],
    ['last_updated', meta.updatedIso],
    ['author', meta.author],
    ['version', meta.version],
  ]);
}

function metaLine(page: PreparedPage): string {
  const meta = pageMeta(page.ref, page.body);
  const items: string[] = [];
  if (meta.breadcrumb.length) items.push(meta.breadcrumb.map(escapeMarkdown).join(' › '));
  if (page.ref.type !== 'page' && page.ref.type !== 'blogpost') items.push(TYPE_LABELS[page.ref.type] ?? page.ref.type);
  if (meta.updated) items.push(`Last updated ${meta.updated}${meta.author ? ` by ${escapeMarkdown(meta.author)}` : ''}`);
  else if (meta.author) items.push(`by ${escapeMarkdown(meta.author)}`);
  if (meta.url) items.push(`[Open in Confluence](${mdUrl(meta.url)})`);
  return items.length ? `*${items.join(' · ')}*` : '';
}

interface Linker {
  /** Markdown link destination for an exported page, or null when it is not in the output. */
  page(id: string): string | null;
}

const PLAIN_WRAPPERS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'CENTER']);

function isPlainWrapper(el: Element): boolean {
  return PLAIN_WRAPPERS.has(el.tagName) && !Array.from(el.attributes).some((a) => a.name.startsWith('data-cf-'));
}

function isBlank(n: Node): boolean {
  return (n.nodeType === 3 && !(n.textContent || '').trim()) || n.nodeType === 8;
}

/**
 * The block rendered right before `node` (looking through wrapper <div>s on both sides), or
 * null when that is inline content or the start of a container.
 */
function previousBlock(node: Node, root: Element): Element | null {
  let cur: Node = node;
  for (;;) {
    let sib = cur.previousSibling;
    while (sib && isBlank(sib)) sib = sib.previousSibling;
    if (sib) {
      if (sib.nodeType !== 1) return null;
      let el = sib as Element;
      for (;;) {
        if (!isPlainWrapper(el)) return el;
        let last = el.lastChild;
        while (last && isBlank(last)) last = last.previousSibling;
        if (!last || last.nodeType !== 1) return el;
        el = last as Element;
      }
    }
    const parent = cur.parentNode;
    if (!parent || parent === root || parent.nodeType !== 1 || !isPlainWrapper(parent as Element)) return null;
    cur = parent;
  }
}

/** Marks lists that directly follow another list (e.g. a TOC macro after a bullet list). */
function separateAdjacentLists(root: Element): void {
  for (const list of Array.from(root.querySelectorAll('ul, ol'))) {
    if (list.parentElement?.closest('li')) continue;
    const prev = previousBlock(list, root);
    if (!prev || (prev.tagName !== 'UL' && prev.tagName !== 'OL')) continue;
    const marker = root.ownerDocument.createElement('div');
    marker.setAttribute('data-cf-list-break', '');
    marker.textContent = '-'; // not blank for turndown
    list.parentNode!.insertBefore(marker, list);
  }
}

function pageBody(page: PreparedPage, md: Services, input: ConvertInput, linker: Linker): string {
  const url = safeHttpUrl(page.body?.url || page.ref.url);
  const open = url ? ` [Open it in Confluence](${mdUrl(url)})` : '';
  if (page.root) {
    try {
      separateAdjacentLists(page.root);
      return md.main.turndown(page.root);
    } catch (err) {
      // One broken page must never break the whole export.
      return `${escapeMarkdown(`This page could not be converted (${String((err as Error)?.message || err)}).`)}${open}`;
    }
  }
  if (page.linkOnly) {
    if (page.ref.type === 'folder') {
      const children = input.allPages.filter((p) => p.parentId === page.ref.id && linker.page(p.id) !== null);
      if (!children.length) return '';
      return ['This folder contains:', '', ...children.map((c) => `- [${escapeMarkdown(pageTitle(c))}](${linker.page(c.id)})`)].join('\n');
    }
    const kind = (TYPE_LABELS[page.ref.type] ?? 'Item').toLowerCase();
    return `This ${kind} can't be exported as content.${open}`;
  }
  return `${escapeMarkdown(page.unavailable || 'The content of this page is not available.')}${open}`;
}

function tocList(input: ConvertInput, prep: PreparedExport, linker: Linker): string {
  const excluded = new Set(input.excludeIds ?? []);
  const entries = tocEntries(
    input.allPages,
    prep.pages.map((p) => p.ref),
    excluded,
  );
  return entries
    .map(({ ref, level }) => {
      const title = escapeMarkdown(pageTitle(ref));
      const dest = linker.page(ref.id);
      const kind = ref.type !== 'page' ? ` *(${TYPE_LABELS[ref.type] ?? ref.type})*` : '';
      return `${'  '.repeat(level)}- ${dest ? `[${title}](${dest})` : title}${kind}`;
    })
    .join('\n');
}

export function writeMarkdown(prep: PreparedExport, input: ConvertInput): ConvertedFile[] {
  const md = services();
  const byId = new Map(prep.pages.map((p) => [p.ref.id, p]));

  if (!input.separate) {
    const linker: Linker = { page: (id) => (byId.has(id) ? `#${encodeFragment(`p-${id}`)}` : null) };
    const parts: string[] = [];
    if (input.cover) parts.push(coverFrontMatter(input.cover, input.generatedBy));
    if (input.toc) {
      const list = tocList(input, prep, linker);
      if (list) parts.push(`**Contents**\n\n${list}`);
    }
    for (const page of prep.pages) {
      const head = `<a id="p-${escapeHtml(page.ref.id)}"></a>\n# ${escapeMarkdown(pageTitle(page.ref, page.body))}`;
      const meta = input.options.includePageMeta ? metaLine(page) : '';
      parts.push([head, meta, pageBody(page, md, input, linker)].filter(Boolean).join('\n\n'));
    }
    return [{ path: `${input.baseName}.md`, text: tidyMarkdown(parts.join('\n\n')) }];
  }

  const linker: Linker = {
    page: (id) => {
      const f = byId.get(id)?.file;
      return f ? encodeRelPath(f) : null;
    },
  };
  const files: ConvertedFile[] = [];
  // The index file carries the cover (front matter) and / or the table of contents.
  if (input.toc || input.cover) {
    const list = input.toc ? tocList(input, prep, linker) : '';
    const parts: string[] = [];
    if (input.cover) parts.push(coverFrontMatter(input.cover, input.generatedBy));
    parts.push(`# ${escapeMarkdown(input.cover?.title || 'Contents')}`);
    if (input.toc && input.cover?.title) parts.push('**Contents**');
    if (list) parts.push(list);
    files.push({ path: '00-Contents.md', text: tidyMarkdown(parts.join('\n\n')) });
  }
  for (const page of prep.pages) {
    const parts: string[] = [];
    if (input.options.includePageMeta) parts.push(pageFrontMatter(page));
    parts.push(`# ${escapeMarkdown(pageTitle(page.ref, page.body))}`);
    parts.push(pageBody(page, md, input, linker));
    files.push({ path: page.file!, text: tidyMarkdown(parts.filter(Boolean).join('\n\n')) });
  }
  return files;
}
