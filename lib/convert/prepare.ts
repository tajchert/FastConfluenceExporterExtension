/**
 * Shared front half of the Markdown / text converters: sanitizes each page exactly like the PDF
 * path (lib/assemble/sanitize.ts + macros.ts), then normalizes Confluence's markup into a small
 * set of semantic markers both writers understand:
 *
 *   pre[data-cf-code][data-cf-lang][data-cf-title]       code / noformat blocks (plain text inside)
 *   div[data-cf-panel][data-cf-panel-title]               info/note/warning/tip/success/generic panels
 *   div[data-cf-expand][data-cf-title]                    expand macros, <details>
 *   span[data-cf-status]                                  status lozenges (upper-cased text)
 *   li[data-cf-task="done"|"open"]                        task list items (glyph removed)
 *   [data-cf-placeholder] + data-cf-label/-text/-url/-page-url   FR-9 placeholders
 *   a[data-cf-anchor]                                     link target (emitted as <a id> in Markdown)
 *
 * Links between exported pages, same-page anchors and image sources are rewritten for the
 * output layout (combined file vs one file per page, Markdown vs text).
 */
import { buildPageIndex, sanitizePageHtml } from '../assemble/sanitize';
import { sanitizeFilenamePart } from '../util/filename';
import type { PageBody } from '../confluence/client';
import type { PageRef } from '../types';
import type { AssetRef, ConvertInput } from './types';
import { LINK_ONLY_TYPES, encodeFragment, encodeRelPath, safeDecode, safeHttpUrl } from './shared';

export interface PreparedPage {
  ref: PageRef;
  body?: PageBody;
  /** Normalized content (owned by the converter's document); absent for link-only / unavailable pages. */
  root?: HTMLElement;
  /** Shown instead of content when the body is missing or could not be processed. */
  unavailable?: string;
  linkOnly: boolean;
  /** Separate mode: this page's file name (no directory). */
  file?: string;
}

export interface PreparedExport {
  pages: PreparedPage[];
  assets: AssetRef[];
  placeholders: number;
  /** Ids of the pages that are in the output. */
  outputIds: Set<string>;
}

type Format = 'markdown' | 'text';

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL', 'CENTER',
]);

export function isBlockElement(node: Node): boolean {
  return node.nodeType === 1 && BLOCK_TAGS.has((node as Element).tagName);
}

// ───────────────────────────── entry point ───────────────────────────────────────────────────

export function preparePages(doc: Document, input: ConvertInput, format: Format): PreparedExport {
  const excluded = new Set(input.excludeIds ?? []);
  const entries: { ref: PageRef; body?: PageBody }[] = [];
  const seen = new Set<string>();
  for (const p of input.pages) {
    if (seen.has(p.ref.id) || excluded.has(p.ref.id)) continue;
    seen.add(p.ref.id);
    entries.push(p);
  }
  const outputIds = new Set(entries.map((p) => p.ref.id));
  const ext = format === 'markdown' ? 'md' : 'txt';
  const width = Math.max(2, String(entries.length).length);

  const pageIndex = buildPageIndex(
    [...entries.map((p) => ({ ...p.ref, url: p.body?.url ?? p.ref.url })), ...input.allPages].filter((p) => outputIds.has(p.id)),
    input.site,
  );

  let placeholders = 0;
  const pages: PreparedPage[] = entries.map((entry, i) => {
    const { ref, body } = entry;
    const page: PreparedPage = { ref, body, linkOnly: LINK_ONLY_TYPES.has(ref.type) && !body };
    if (input.separate) {
      const nn = String(i + 1).padStart(width, '0');
      page.file = `${nn}-${sanitizeFilenamePart(body?.title || ref.title || '', 80) || 'Untitled'}.${ext}`;
    }
    if (page.linkOnly) return page;
    if (!body) {
      page.unavailable = 'The content of this page is not available.';
      return page;
    }
    const pageUrl = safeHttpUrl(body.url || ref.url) ?? input.site.baseUrl;
    try {
      const frag = sanitizePageHtml(body.html, {
        pageId: ref.id,
        site: input.site,
        pageUrl,
        exportedIds: outputIds,
        pageIndex,
        includeComments: input.options.includeComments,
      });
      const root = doc.createElement('div');
      root.append(doc.importNode(frag, true));
      placeholders += root.querySelectorAll('.cf-placeholder').length;
      normalize(root);
      page.root = root;
    } catch (err) {
      page.unavailable = `This page could not be processed (${errorMessage(err)}).`;
    }
    return page;
  });

  resolveAnchors(doc, pages, input.separate, format);

  const assets: AssetRef[] = [];
  if (format === 'markdown' && input.options.downloadImages) {
    for (const page of pages) if (page.root) collectAssets(page.root, page.ref.id, input.site.origin, assets);
  }
  return { pages, assets, placeholders, outputIds };
}

function errorMessage(err: unknown): string {
  const m = (err as { message?: unknown })?.message;
  return typeof m === 'string' && m ? m : String(err);
}

// ───────────────────────────── normalization ─────────────────────────────────────────────────

function normalize(root: HTMLElement): void {
  normalizePlaceholders(root);
  normalizeCode(root);
  normalizePanels(root);
  normalizeExpands(root);
  normalizeStatus(root);
  normalizeTasks(root);
  normalizeEmoticons(root);
  normalizeMentions(root);
  normalizeIconImages(root);
  normalizeHeadings(root);
  normalizeStrikethrough(root);
  unwrapSingleParagraphs(root);
  trimBreaks(root);
  mergeAdjacentInline(root);
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

/** Own-property lookup (names come from page markup: never hit Object.prototype). */
function lookup(map: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function collapse(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s\u200b\ufeff]+/g, ' ').trim();
}

function normalizePlaceholders(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const box of Array.from(root.querySelectorAll('.cf-placeholder'))) {
    const inline = box.classList.contains('cf-placeholder-inline');
    const label = collapse(box.querySelector('.cf-placeholder-label')?.textContent) || 'Content';
    // The shared placeholder texts talk about "the PDF".
    const text = collapse(box.querySelector('.cf-placeholder-text')?.textContent).replace(/\bthe PDF\b/g, 'this export');
    const url = safeHttpUrl(box.querySelector('.cf-placeholder-url a[href]')?.getAttribute('href'));
    const pageUrl = safeHttpUrl(box.querySelector('.cf-placeholder-open a[href]')?.getAttribute('href'));
    const out = doc.createElement(inline ? 'span' : 'div');
    out.setAttribute('data-cf-placeholder', '');
    out.setAttribute('data-cf-label', label);
    if (text) out.setAttribute('data-cf-text', text);
    if (url) out.setAttribute('data-cf-url', url);
    if (pageUrl) out.setAttribute('data-cf-page-url', pageUrl);
    // Content keeps the node from being treated as blank by the Markdown writer.
    out.textContent = label;
    box.replaceWith(out);
  }
}

// ── code ──

const LANGUAGES: Record<string, string> = {
  js: 'javascript', jscript: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript',
  py: 'python', python: 'python', sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash', 'c#': 'csharp',
  'c-sharp': 'csharp', csharp: 'csharp', cs: 'csharp', cpp: 'cpp', 'c++': 'cpp', c: 'c', java: 'java', xml: 'xml',
  html: 'html', xhtml: 'html', css: 'css', sass: 'scss', scss: 'scss', less: 'less', sql: 'sql', ruby: 'ruby', rails: 'ruby', ror: 'ruby', rb: 'ruby',
  php: 'php', perl: 'perl', pl: 'perl', ps: 'powershell', powershell: 'powershell', yaml: 'yaml', yml: 'yaml',
  json: 'json', groovy: 'groovy', scala: 'scala', go: 'go', golang: 'go', kotlin: 'kotlin', kt: 'kotlin',
  swift: 'swift', diff: 'diff', patch: 'diff', erlang: 'erlang', erl: 'erlang', vb: 'vbnet', vbnet: 'vbnet',
  actionscript3: 'actionscript', as3: 'actionscript', delphi: 'delphi', pascal: 'pascal', coldfusion: 'cfm',
  javafx: 'javafx', jfx: 'javafx', r: 'r', rust: 'rust', rs: 'rust', dockerfile: 'dockerfile', docker: 'dockerfile',
  graphql: 'graphql', markdown: 'markdown', md: 'markdown', lua: 'lua', matlab: 'matlab', haskell: 'haskell',
  clojure: 'clojure', objc: 'objectivec', 'objective-c': 'objectivec', objectivec: 'objectivec', protobuf: 'protobuf',
  properties: 'properties', ini: 'ini', toml: 'toml', makefile: 'makefile', cmake: 'cmake', nginx: 'nginx',
  text: '', plain: '', plaintext: '', none: '', txt: '', nohighlight: '',
};

function normalizeLanguage(raw: string | null | undefined): string {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  const known = lookup(LANGUAGES, v);
  if (known !== undefined) return known;
  return v.replace(/[^\w#+.-]/g, '').slice(0, 30);
}

function languageOf(pre: Element): string {
  const params = pre.getAttribute('data-syntaxhighlighter-params') || '';
  const brush = /(?:^|;)\s*brush:\s*([^;\s]+)/i.exec(params);
  if (brush) return normalizeLanguage(brush[1]);
  for (const el of [pre, pre.querySelector('code')]) {
    if (!el) continue;
    const lang = el.getAttribute('data-language') || el.getAttribute('data-code-language');
    if (lang) return normalizeLanguage(lang);
    const cls = /(?:^|\s)(?:language|lang)-([^\s]+)/.exec(el.getAttribute('class') || '');
    if (cls) return normalizeLanguage(cls[1]);
  }
  return '';
}

/** Text of a <pre> with <br> as newlines and no trailing blank lines. */
function preText(pre: Element): string {
  const clone = pre.cloneNode(true) as Element;
  for (const br of Array.from(clone.querySelectorAll('br'))) br.replaceWith(pre.ownerDocument.createTextNode('\n'));
  // Line-number gutters (some highlighters) are not code.
  for (const g of Array.from(clone.querySelectorAll('.gutter, .line-number, .linenumber'))) g.remove();
  return (clone.textContent || '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
}

function normalizeCode(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const make = (pre: Element, title: string): HTMLPreElement => {
    const out = doc.createElement('pre');
    out.setAttribute('data-cf-code', '');
    const lang = languageOf(pre);
    if (lang) out.setAttribute('data-cf-lang', lang);
    if (title) out.setAttribute('data-cf-title', title);
    out.textContent = preText(pre);
    return out;
  };
  // Confluence code / noformat macros: a panel with an optional header and one <pre>.
  for (const panel of Array.from(root.querySelectorAll('div.code.panel, div.preformatted.panel'))) {
    if (!root.contains(panel)) continue;
    const pre = panel.querySelector('pre');
    if (!pre || pre.closest('[data-cf-code]')) continue;
    const header = panel.querySelector(':scope > .codeHeader, :scope > .preformattedHeader, :scope > .panelHeader');
    panel.replaceWith(make(pre, collapse(header?.textContent)));
  }
  for (const pre of Array.from(root.querySelectorAll('pre:not([data-cf-code])'))) {
    if (pre.parentElement?.closest('pre')) continue;
    pre.replaceWith(make(pre, ''));
  }
}

// ── panels ──

const PANEL_TYPES: Record<string, string> = {
  information: 'Info',
  info: 'Info',
  note: 'Note',
  warning: 'Warning',
  tip: 'Tip',
  success: 'Success',
  error: 'Error',
};

function normalizePanels(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const build = (el: Element, type: string, title: string, body: Element | null) => {
    const out = doc.createElement('div');
    out.setAttribute('data-cf-panel', type);
    if (title) out.setAttribute('data-cf-panel-title', title);
    const source = body ?? el;
    while (source.firstChild) out.appendChild(source.firstChild);
    el.replaceWith(out);
  };
  // Process inner panels first so their content moves intact.
  const panels = Array.from(
    root.querySelectorAll('.confluence-information-macro, div.panel, div[data-panel-type]'),
  ).reverse();
  for (const el of panels) {
    if (!root.contains(el) || el.hasAttribute('data-cf-panel')) continue;
    if (el.classList.contains('confluence-information-macro')) {
      const kind = Array.from(el.classList)
        .map((c) => /^confluence-information-macro-(\w+)$/.exec(c)?.[1])
        .find((k) => k && lookup(PANEL_TYPES, k) !== undefined);
      const type = lookup(PANEL_TYPES, kind ?? '') ?? 'Info';
      const titleEl = el.querySelector(':scope > p.title, :scope > .title, :scope > .confluence-information-macro-title');
      const title = collapse(titleEl?.textContent);
      titleEl?.remove();
      const body = el.querySelector(':scope > .confluence-information-macro-body');
      build(el, type, title, body);
      continue;
    }
    const panelType = (el.getAttribute('data-panel-type') || '').toLowerCase();
    const header = el.querySelector(':scope > .panelHeader');
    const title = collapse(header?.textContent);
    header?.remove();
    const body = el.querySelector(':scope > .panelContent');
    build(el, lookup(PANEL_TYPES, panelType) ?? '', title, body);
  }
}

// ── expand ──

function normalizeExpands(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const build = (el: Element, title: string, bodies: Node[]) => {
    const out = doc.createElement('div');
    out.setAttribute('data-cf-expand', '');
    out.setAttribute('data-cf-title', title || 'Details');
    for (const b of bodies) out.appendChild(b);
    el.replaceWith(out);
  };
  for (const el of Array.from(root.querySelectorAll('.cf-expand, details')).reverse()) {
    if (!root.contains(el)) continue;
    if (el.tagName === 'DETAILS') {
      const summary = el.querySelector(':scope > summary');
      const title = collapse(summary?.textContent);
      summary?.remove();
      build(el, title, Array.from(el.childNodes));
      continue;
    }
    const titleEl = el.querySelector(':scope > .cf-expand-title');
    const title = collapse(titleEl?.textContent);
    titleEl?.remove();
    const body = el.querySelector(':scope > .cf-expand-body');
    build(el, title, Array.from((body ?? el).childNodes));
  }
}

// ── inline macros ──

function normalizeStatus(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const el of Array.from(root.querySelectorAll('.status-macro, .aui-lozenge, [data-node-type="status"]'))) {
    if (!root.contains(el) || el.parentElement?.closest('[data-cf-status]')) continue;
    const text = collapse(el.textContent).toUpperCase();
    if (!text) {
      el.remove();
      continue;
    }
    const out = doc.createElement('span');
    out.setAttribute('data-cf-status', '');
    out.textContent = text;
    el.replaceWith(out);
  }
}

function normalizeTasks(root: HTMLElement): void {
  for (const li of Array.from(root.querySelectorAll('li.cf-task'))) {
    li.setAttribute('data-cf-task', li.classList.contains('cf-task-done') ? 'done' : 'open');
    const glyph = li.querySelector(':scope > .cf-task-box');
    glyph?.remove();
  }
}

const EMOTICONS: Record<string, string> = {
  smile: '🙂', sad: '🙁', cheeky: '😛', tongue: '😛', laugh: '😀', wink: '😉', 'thumbs-up': '👍', 'thumbs-down': '👎',
  information: 'ℹ\ufe0f', tick: '✅', check: '✅', cross: '❌', error: '❌', warning: '⚠\ufe0f', plus: '➕', minus: '➖',
  question: '❓', 'light-on': '💡', 'light-off': '💡', 'yellow-star': '⭐', 'red-star': '⭐', 'green-star': '⭐',
  'blue-star': '⭐', star: '⭐', heart: '❤\ufe0f', 'broken-heart': '💔',
};

function normalizeEmoticons(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const span of Array.from(root.querySelectorAll('span.cf-emoji'))) unwrap(span);
  for (const img of Array.from(root.querySelectorAll('img.emoticon, img[data-emoji-id], img[data-emoji-shortname], img[data-emoticon-name]'))) {
    const fallback = (img.getAttribute('data-emoji-fallback') || '').trim();
    const name =
      (img.getAttribute('data-emoticon-name') || '').trim() ||
      (Array.from(img.classList).find((c) => c.startsWith('emoticon-'))?.slice('emoticon-'.length) ?? '');
    const alt = (img.getAttribute('alt') || '').trim();
    const shortname = (img.getAttribute('data-emoji-shortname') || '').trim();
    const altName = /^\((.+)\)$/.exec(alt)?.[1];
    let text = '';
    if (fallback && !fallback.startsWith(':') && fallback.length <= 16) text = fallback;
    else if (name && lookup(EMOTICONS, name)) text = lookup(EMOTICONS, name)!;
    else if (altName && lookup(EMOTICONS, altName)) text = lookup(EMOTICONS, altName)!;
    else text = shortname || fallback || alt;
    img.replaceWith(doc.createTextNode(text));
  }
}

function normalizeMentions(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const el of Array.from(
    root.querySelectorAll('a.confluence-userlink, a.user-mention, a[data-account-id], a[data-username], span.user-mention, [data-mention-id]'),
  )) {
    if (!root.contains(el)) continue;
    // Avatars inside a user link carry no information in text form.
    el.replaceWith(doc.createTextNode(collapse(el.textContent)));
  }
  for (const img of Array.from(root.querySelectorAll('img.userLogo, img.confluence-userlink, img.user-avatar'))) img.remove();
}

const ICON_SRC = /\/images\/icons\/|\/download\/resources\/|\/secure\/viewavatar|\/universal_avatar\/|\/rest\/api\/\d\/universal_avatar|\/images\/border\/|\/s\/[^/]*\/_\/images\//i;

/** Small decorative images (issue type icons, file-type icons, avatars) → their label or nothing. */
function normalizeIconImages(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    const w = Number(img.getAttribute('width'));
    const h = Number(img.getAttribute('height'));
    const small = (w > 0 && w <= 24) || (h > 0 && h <= 24);
    const iconish = small || ICON_SRC.test(src) || img.classList.contains('icon') || img.classList.contains('confluence-embedded-file-icon');
    if (!iconish) continue;
    const label = collapse(img.getAttribute('alt') || img.getAttribute('title'));
    // Keep a meaningful label ("Bug"), drop file names and empty alts.
    const keep = label && !/\.\w{2,5}$/.test(label) && label.length <= 40;
    if (keep) img.replaceWith(doc.createTextNode(label));
    else img.remove();
  }
}

/** `<h2><strong>Title</strong></h2>` → `<h2>Title</h2>` (headings are bold anyway). */
function normalizeHeadings(root: HTMLElement): void {
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
    for (const b of Array.from(h.querySelectorAll('strong, b'))) {
      if (collapse(b.textContent) === collapse(h.textContent)) unwrap(b);
    }
  }
}

/** `<span style="text-decoration: line-through">` → `<s>` (rendered as `~~…~~` in both formats). */
function normalizeStrikethrough(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const el of Array.from(root.querySelectorAll('span[style], font[style]'))) {
    const style = (el as HTMLElement).style;
    const deco = `${style?.textDecoration || ''} ${style?.textDecorationLine || ''} ${el.getAttribute('style') || ''}`;
    if (!/line-through/i.test(deco) || el.querySelector(BLOCK_SELECTOR)) continue;
    const s = doc.createElement('s');
    while (el.firstChild) s.appendChild(el.firstChild);
    el.replaceWith(s);
  }
}

const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).map((t) => t.toLowerCase()).join(', ');

/** `<li><p>x</p></li>` and `<td><p>x</p></td>` → no paragraph (keeps lists tight, cells inline). */
function unwrapSingleParagraphs(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('li, td, th'))) {
    const kids = Array.from(el.childNodes).filter((n) => !(n.nodeType === 3 && !(n.textContent || '').trim()));
    const paragraphs = kids.filter((n) => n.nodeType === 1 && (n as Element).tagName === 'P');
    if (paragraphs.length !== 1) continue;
    // Only when the paragraph is the first block (inline content may follow, e.g. a nested list).
    const first = kids.find((n) => isBlockElement(n));
    if (first !== paragraphs[0]) continue;
    if (kids.some((n) => n !== first && n.nodeType === 1 && !isBlockElement(n))) continue;
    unwrap(paragraphs[0] as Element);
  }
}

/**
 * A <br> that starts or ends a line box (at the edge of a block, also inside inline wrappers, or
 * next to a nested block such as a code panel in a list item) renders as a stray line break.
 */
function trimBreaks(root: HTMLElement): void {
  const isWs = (n: Node | null) => !!n && n.nodeType === 3 && !(n.textContent || '').replace(/[\s\u200b]/g, '');
  const isBlockish = (n: Node) => isBlockElement(n) || (n.nodeType === 1 && (n as Element).matches('[data-cf-panel], [data-cf-expand], div[data-cf-placeholder]'));
  /** The next (or previous) meaningful node in the same line box; null at a block edge. */
  const neighbour = (n: Node, dir: 'nextSibling' | 'previousSibling'): Node | null => {
    let cur: Node = n;
    for (;;) {
      let sib = cur[dir];
      while (isWs(sib)) sib = sib![dir];
      if (sib) return sib;
      const parent = cur.parentNode;
      if (!parent || parent === root || isBlockish(parent)) return null;
      cur = parent;
    }
  };
  const lineEdge = (n: Node | null) => !n || isBlockish(n);
  const breaks = Array.from(root.querySelectorAll('br')).filter((br) => !br.closest('pre'));
  for (const br of [...breaks].reverse()) {
    if (lineEdge(neighbour(br, 'nextSibling'))) br.remove();
  }
  for (const br of breaks) {
    if (br.isConnected || br.parentNode) {
      if (root.contains(br) && lineEdge(neighbour(br, 'previousSibling'))) br.remove();
    }
  }
}

const MERGEABLE = new Set(['STRONG', 'B', 'EM', 'I', 'CODE', 'S', 'DEL', 'STRIKE']);

/**
 * `<em>a</em><em>b</em>` → `<em>ab</em>`: Markdown can't write two emphasis runs (or code spans)
 * back to back (`*a**b*`, `` `a``b` ``). Only siblings with nothing (not even a space) between.
 */
function mergeAdjacentInline(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('strong, b, em, i, code, s, del, strike'))) {
    if (!el.parentNode || el.closest('pre') || el.hasAttribute('id')) continue;
    let next = el.nextSibling;
    while (next && next.nodeType === 3 && !next.textContent) next = next.nextSibling;
    if (!next || next.nodeType !== 1) continue;
    const other = next as Element;
    if (other.tagName !== el.tagName || !MERGEABLE.has(el.tagName)) continue;
    // Merge `el` into the following element so a run of three or more ends up in one.
    while (el.lastChild) other.insertBefore(el.lastChild, other.firstChild);
    el.remove();
  }
}

// ───────────────────────────── anchors & links ───────────────────────────────────────────────

function looseId(s: string): string {
  return s.toLowerCase().replace(/[-_\s]+/g, '');
}

function resolveAnchors(doc: Document, pages: PreparedPage[], separate: boolean, format: Format): void {
  /** element id → owning page id */
  const owner = new Map<string, string>();
  const elements = new Map<string, Element>();
  const byPage = new Map<string, string[]>();
  const outputIds = new Set(pages.map((p) => p.ref.id));
  const fileOf = new Map(pages.map((p) => [p.ref.id, p.file ?? '']));

  for (const page of pages) {
    if (!page.root) continue;
    const list: string[] = [];
    for (const el of Array.from(page.root.querySelectorAll('[id]'))) {
      const id = el.getAttribute('id') || '';
      if (!id || owner.has(id)) continue;
      owner.set(id, page.ref.id);
      elements.set(id, el);
      list.push(id);
    }
    byPage.set(page.ref.id, list);
  }

  const loose = (pageId: string, frag: string): string | null => {
    const want = looseId(frag);
    if (want.length < 3) return null;
    let best: string | null = null;
    for (const id of byPage.get(pageId) ?? []) {
      const rest = looseId(id.slice(`p${pageId}-`.length));
      if ((rest === want || rest.endsWith(want)) && (!best || id.length < best.length)) best = id;
    }
    return best;
  };

  const linked = new Set<string>();

  for (const page of pages) {
    if (!page.root) continue;
    for (const a of Array.from(page.root.querySelectorAll('a[href^="#"]'))) {
      const raw = (a.getAttribute('href') || '').slice(1);
      const fallback = a.getAttribute('data-cf-fallback');
      a.removeAttribute('data-cf-fallback');
      const decoded = safeDecode(raw);
      let target: { pageId: string; anchor?: string } | null = null;
      if (owner.has(raw)) target = { pageId: owner.get(raw)!, anchor: raw };
      else if (owner.has(decoded)) target = { pageId: owner.get(decoded)!, anchor: decoded };
      else if (/^p-[^-]/.test(decoded) && outputIds.has(decoded.slice(2))) target = { pageId: decoded.slice(2) };
      else {
        const heading = /^p(\d+)-(.+)$/.exec(decoded);
        const hit = heading ? loose(heading[1]!, heading[2]!) : null;
        if (hit) target = { pageId: owner.get(hit)!, anchor: hit };
        else if (fallback) {
          const fid = safeDecode(fallback.slice(1));
          if (owner.has(fid)) target = { pageId: owner.get(fid)!, anchor: fid };
          else if (/^p-/.test(fid) && outputIds.has(fid.slice(2))) target = { pageId: fid.slice(2) };
        }
      }
      if (!target) {
        a.removeAttribute('href');
        continue;
      }
      const href = linkHref(target, page.ref.id, separate, format, fileOf);
      if (href === null) a.removeAttribute('href');
      else a.setAttribute('href', href);
      if (target.anchor && href !== null) linked.add(target.anchor);
    }
  }

  // Link targets become explicit `<a id>` markers (Markdown) — only the ones something links to.
  for (const id of linked) {
    const el = elements.get(id);
    if (!el) continue;
    const marker = doc.createElement('a');
    marker.setAttribute('data-cf-anchor', id);
    if (/^H[1-6]$/.test(el.tagName)) el.insertBefore(marker, el.firstChild);
    else if (el.tagName === 'TR' || el.tagName === 'TD' || el.tagName === 'TH' || el.tagName === 'LI') el.insertBefore(marker, el.firstChild);
    else el.parentNode?.insertBefore(marker, el);
  }
  for (const page of pages) {
    if (!page.root) continue;
    for (const el of Array.from(page.root.querySelectorAll('[id]'))) el.removeAttribute('id');
  }
}

function linkHref(
  target: { pageId: string; anchor?: string },
  fromPage: string,
  separate: boolean,
  format: Format,
  fileOf: Map<string, string>,
): string | null {
  const enc = (s: string) => (format === 'markdown' ? encodeFragment(s) : s);
  if (!separate) return '#' + enc(target.anchor ?? `p-${target.pageId}`);
  if (target.pageId === fromPage) return target.anchor ? '#' + enc(target.anchor) : null;
  const file = fileOf.get(target.pageId) ?? '';
  if (!file) return null;
  if (format === 'text') return file;
  return encodeRelPath(file) + (target.anchor ? '#' + encodeFragment(target.anchor) : '');
}

// ───────────────────────────── images → assets ───────────────────────────────────────────────

function imageFileName(img: Element, url: URL): string {
  const alias = (img.getAttribute('data-linked-resource-default-alias') || '').trim();
  const last = safeDecode(url.pathname.split('/').filter(Boolean).pop() || '');
  return sanitizeFilenamePart(alias || last, 80) || 'image';
}

/**
 * Images on the Confluence site itself become bundle assets (Cloud attachments are same-origin
 * URLs that redirect to the media service). Images hosted elsewhere keep their absolute URL: the
 * export tab never requests other hosts (a CORS fetch from there would reveal the Confluence
 * origin in its `Origin` header).
 */
function collectAssets(root: HTMLElement, pageId: string, origin: string, assets: AssetRef[]): void {
  const byUrl = new Map<string, string>();
  const used = new Set<string>();
  const dir = `assets/${sanitizeFilenamePart(pageId, 40) || 'page'}`;
  for (const img of Array.from(root.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') || '';
    const abs = safeHttpUrl(src);
    if (!abs || new URL(abs).origin !== origin) continue;
    let path = byUrl.get(abs);
    if (!path) {
      const name = imageFileName(img, new URL(abs));
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let candidate = name;
      for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${stem}-${n}${ext}`;
      used.add(candidate.toLowerCase());
      path = `${dir}/${candidate}`;
      byUrl.set(abs, path);
      assets.push({ url: abs, path });
    }
    img.setAttribute('src', encodeRelPath(path));
    img.setAttribute('data-cf-asset', '');
  }
}

/** Display name of an image for text output: its alt text or its file name. */
export function imageLabel(img: Element): string {
  const alt = collapse(img.getAttribute('alt'));
  if (alt) return alt;
  const alias = collapse(img.getAttribute('data-linked-resource-default-alias'));
  if (alias) return alias;
  const src = img.getAttribute('src') || '';
  try {
    const u = new URL(src, 'https://x.invalid/');
    if (u.protocol === 'data:') return 'embedded image';
    return safeDecode(u.pathname.split('/').filter(Boolean).pop() || '') || 'image';
  } catch {
    return 'image';
  }
}
