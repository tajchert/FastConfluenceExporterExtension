/**
 * Macro handling for the fast print path.
 *
 *  - `detectLiveRenderMacros` decides whether a page contains client-rendered content (draw.io,
 *    Gliffy, charts, …) that only the real Confluence UI can draw (FR-10).
 *  - `replaceUnsupportedContent` swaps content that cannot be printed statically (iframes, media,
 *    live search, empty app/macro placeholders) for a visible placeholder box with links back to the
 *    source, so nothing is ever dropped silently (FR-9).
 */

/** Macros that legitimately render nothing (or only anchors) and must not be reported as missing. */
const BENIGN_EMPTY_MACROS = new Set([
  'anchor',
  'toc',
  'toc-zone',
  'children',
  'excerpt',
  'excerpt-include',
  'include',
  'details',
  'detailssummary',
  'column',
  'section',
  'layout',
  'pagetree',
  'recently-updated',
  'contentbylabel',
  'content-report-table',
  'attachments',
  'blog-posts',
  'info',
  'note',
  'tip',
  'warning',
  'panel',
  'expand',
  'code',
  'noformat',
  'status',
  'span',
  'div',
  'tasks-report-macro',
  'popular-labels',
  'listlabels',
  'related-labels',
  'contributors',
  'contributors-summary',
  'change-history',
  'profile',
  'profile-picture',
  'space-details',
  'spaces',
  'favpages',
  'recently-updated-dashboard',
  'pagetreesearch-hidden',
  'unmigrated-inline-wiki-markup',
]);

/** Macros whose output is interactive and never meaningful on paper. */
const ALWAYS_REPLACED_MACROS = new Set([
  'livesearch',
  'pagetreesearch',
  'create-from-template',
  'createpage',
  'iframe',
  'widget',
  'multimedia',
  'whiteboard',
  'whiteboard-embed',
  'embed',
]);

const MACRO_LABELS: Record<string, string> = {
  drawio: 'draw.io diagram',
  'inc-drawio': 'draw.io diagram',
  'drawio-sketch': 'draw.io sketch',
  gliffy: 'Gliffy diagram',
  lucidchart: 'Lucidchart diagram',
  lucid: 'Lucid diagram',
  roadmap: 'Roadmap',
  chart: 'Chart',
  'jira-chart': 'Jira chart',
  jira: 'Jira issues',
  jiraissues: 'Jira issues',
  mermaid: 'Mermaid diagram',
  plantuml: 'PlantUML diagram',
  miro: 'Miro board',
  figma: 'Figma design',
  livesearch: 'Live search',
  pagetreesearch: 'Page tree search',
  'create-from-template': 'Create-from-template button',
  createpage: 'Create page button',
  iframe: 'Embedded web page',
  widget: 'Embedded media',
  multimedia: 'Embedded media',
  whiteboard: 'Whiteboard',
  'whiteboard-embed': 'Whiteboard',
  embed: 'Embedded content',
};

/** Elements that count as visible content inside a macro container. */
const CONTENT_SELECTOR =
  'img, svg, table, canvas, video, audio, iframe, object, embed, picture, hr, input, pre, ul, ol';

const INLINE_PARENTS = new Set([
  'P', 'SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LABEL', 'CODE', 'SMALL', 'SUP', 'SUB', 'FONT', 'MARK', 'DEL', 'INS', 'CITE', 'Q', 'ABBR',
]);

// ───────────────────────────── detection ─────────────────────────────────────────────────────

function normalizeTerms(macroNames: string[]): string[] {
  const out: string[] = [];
  for (const n of macroNames) {
    const t = String(n ?? '').trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function matchTerm(value: string, terms: string[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  for (const t of terms) if (v === t) return t;
  for (const t of terms) if (v.includes(t)) return t;
  return null;
}

/** Icons, spinners and placeholders don't count as a static rendering of a diagram. */
function isIconishImage(img: Element): boolean {
  const src = (img.getAttribute('src') || img.getAttribute('data-image-src') || '').trim();
  if (!src) return true;
  if (/\/images\/icons\/|\/download\/resources\/|spinner|loading|placeholder|blank\.gif|\/s\/[^/]*\/_\//i.test(src)) {
    return true;
  }
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  return (w > 0 && w <= 24) || (h > 0 && h <= 24);
}

function hasStaticRendering(el: Element): boolean {
  const imgs: Element[] = el.tagName === 'IMG' ? [el] : Array.from(el.querySelectorAll('img'));
  if (imgs.some((img) => !isIconishImage(img))) return true;
  const svgs: Element[] = el.tagName.toLowerCase() === 'svg' ? [el] : Array.from(el.querySelectorAll('svg'));
  return svgs.some((svg) => svg.childElementCount > 0);
}

function textOf(el: Element): string {
  return (el.textContent || '').replace(/[\s​ ﻿]+/g, '');
}

function isEmptyMacro(el: Element): boolean {
  return textOf(el) === '' && !el.querySelector(CONTENT_SELECTOR);
}

function macroNameOf(el: Element): string {
  return (el.getAttribute('data-macro-name') || '').trim().toLowerCase();
}

function scanStorage(storage: string, terms: string[], add: (s: string) => void): void {
  const macroRe = /<ac:(?:structured-)?macro\b[^>]*?\bac:name\s*=\s*(["'])(.*?)\1/gi;
  for (const m of storage.matchAll(macroRe)) {
    const name = (m[2] ?? '').toLowerCase();
    if (matchTerm(name, terms)) add(name);
  }
  // ADF extensions (Forge / Connect apps in the new editor) carry their key as an attribute.
  const extRe = /<ac:adf-attribute\b[^>]*\bkey\s*=\s*(["'])(?:extension-key|extension-type)\1[^>]*>([^<]*)</gi;
  for (const m of storage.matchAll(extRe)) {
    const t = matchTerm(m[2] ?? '', terms);
    if (t) add(t);
  }
}

function parseHtml(html: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

/**
 * Returns the names of client-rendered macros found in a page ([] = the page prints statically).
 * Storage-format markers are authoritative unless export_view shows that very macro already
 * rendered as an image. Empty macro/app placeholders count even when not in the configured list,
 * but an empty `macroNames` list disables detection entirely.
 */
export function detectLiveRenderMacros(
  exportHtml: string,
  storageHtml: string | null,
  macroNames: string[],
): string[] {
  const terms = normalizeTerms(macroNames);
  if (terms.length === 0) return [];

  const storageHits: string[] = [];
  if (storageHtml) scanStorage(storageHtml, terms, (s) => storageHits.includes(s) || storageHits.push(s));

  const found: string[] = [];
  const add = (s: string) => {
    if (s && !found.includes(s)) found.push(s);
  };

  const doc = exportHtml ? parseHtml(exportHtml) : null;
  if (!doc) {
    // No DOM available: fall back to attribute scanning.
    for (const m of (exportHtml || '').matchAll(/data-macro-name\s*=\s*(["'])(.*?)\1/gi)) {
      const name = (m[2] ?? '').toLowerCase();
      if (matchTerm(name, terms)) add(name);
    }
    storageHits.forEach(add);
    return found;
  }

  const body = doc.body;
  for (const name of storageHits) {
    const rendered = Array.from(body.querySelectorAll('[data-macro-name]')).filter((el) => macroNameOf(el) === name);
    if (rendered.length > 0 && rendered.every(hasStaticRendering)) continue;
    add(name);
  }

  for (const el of Array.from(body.querySelectorAll('[data-macro-name]'))) {
    const name = macroNameOf(el);
    if (!name) continue;
    if (matchTerm(name, terms)) {
      if (!hasStaticRendering(el)) add(name);
    } else if (isEmptyMacro(el) && !BENIGN_EMPTY_MACROS.has(name) && !ALWAYS_REPLACED_MACROS.has(name)) {
      add(name);
    }
  }

  for (const el of Array.from(body.querySelectorAll('[class]'))) {
    if (el.closest('[data-macro-name]')) continue;
    const cls = el.getAttribute('class') || '';
    for (const token of cls.split(/\s+/)) {
      const t = token ? matchTerm(token, terms) : null;
      if (t && !hasStaticRendering(el)) {
        add(t);
        break;
      }
    }
  }

  for (const el of Array.from(body.querySelectorAll('.conf-macro.output-block:not([data-macro-name])'))) {
    if (isEmptyMacro(el)) add('macro');
  }

  for (const frame of Array.from(body.querySelectorAll('iframe[src], embed[src], object[data]'))) {
    const src = (frame.getAttribute('src') || frame.getAttribute('data') || '').toLowerCase();
    let t = matchTerm(src, terms);
    if (!t && /diagrams\.net|draw\.io/.test(src) && terms.includes('drawio')) t = 'drawio';
    if (t) add(t);
  }

  return found;
}

// ───────────────────────────── placeholders ──────────────────────────────────────────────────

export function humanizeMacroName(name: string): string {
  const key = name.trim().toLowerCase();
  if (MACRO_LABELS[key]) return MACRO_LABELS[key];
  const words = key.split(/[-_:.\s/]+/).filter(Boolean);
  if (words.length === 0) return 'Macro';
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function httpUrl(raw: string | null | undefined, base?: string): string | null {
  if (!raw) return null;
  try {
    const u = base ? new URL(raw.trim(), base) : new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export interface PlaceholderSpec {
  /** Machine-readable kind, e.g. 'iframe', 'video', 'macro'. */
  kind: string;
  /** Short bold label, e.g. "Embedded content (youtube.com)". */
  label: string;
  /** Explanation sentence. */
  text?: string;
  /** Link to the original resource (iframe src, video file…). */
  url?: string | null;
  /** Link to the Confluence page the content lives on. */
  pageUrl?: string | null;
  inline?: boolean;
}

/** Builds a FR-9 placeholder box in `doc`. Uses spans internally so it is valid in any context. */
export function createPlaceholder(doc: Document, spec: PlaceholderSpec): HTMLElement {
  const box = doc.createElement(spec.inline ? 'span' : 'div');
  box.className = spec.inline ? 'cf-placeholder cf-placeholder-inline' : 'cf-placeholder';
  box.setAttribute('data-cf-kind', spec.kind);
  box.setAttribute('role', 'note');

  const label = doc.createElement('span');
  label.className = 'cf-placeholder-label';
  label.textContent = spec.label;
  box.appendChild(label);

  if (spec.text && !spec.inline) {
    const text = doc.createElement('span');
    text.className = 'cf-placeholder-text';
    text.textContent = spec.text;
    box.appendChild(text);
  }

  if (spec.url) {
    const wrap = doc.createElement('span');
    wrap.className = 'cf-placeholder-url';
    const a = doc.createElement('a');
    a.href = spec.url;
    a.textContent = spec.url;
    wrap.appendChild(a);
    box.appendChild(wrap);
  }

  if (spec.pageUrl && !spec.inline) {
    const wrap = doc.createElement('span');
    wrap.className = 'cf-placeholder-open';
    const a = doc.createElement('a');
    a.href = spec.pageUrl;
    a.textContent = 'View it in Confluence';
    wrap.appendChild(a);
    box.appendChild(wrap);
  }
  return box;
}

function isInlineContext(el: Element): boolean {
  const parent = el.parentElement;
  if (el.classList.contains('output-inline')) return true;
  return !!parent && INLINE_PARENTS.has(parent.tagName) && !parent.classList.contains('conf-macro');
}

function mediaSrc(el: Element, base: string): string | null {
  const direct = el.getAttribute('src') || el.getAttribute('data');
  const fromDirect = httpUrl(direct, base);
  if (fromDirect) return fromDirect;
  const source = el.querySelector('source[src]');
  return httpUrl(source?.getAttribute('src'), base);
}

const STATIC_TEXT = "This content can't be included in the PDF.";
const DYNAMIC_TEXT = 'This content is rendered dynamically by Confluence and is not included in the PDF.';

/**
 * Replaces unprintable content inside `root` with placeholders (FR-9). Jira static tables and other
 * statically rendered macros are left untouched. Returns the number of placeholders inserted.
 */
export function replaceUnsupportedContent(root: Element, ctx: { pageUrl: string }): number {
  const doc = root.ownerDocument;
  const base = httpUrl(ctx.pageUrl) ?? undefined;
  const pageUrl = base ?? null;
  let count = 0;

  const replace = (el: Element, spec: PlaceholderSpec) => {
    if (!el.parentNode || !root.contains(el)) return;
    el.replaceWith(createPlaceholder(doc, { ...spec, pageUrl, inline: spec.inline ?? isInlineContext(el) }));
    count++;
  };

  // 1. Interactive macros, replaced as a whole container.
  for (const el of Array.from(root.querySelectorAll('[data-macro-name]'))) {
    const name = macroNameOf(el);
    if (!ALWAYS_REPLACED_MACROS.has(name)) continue;
    const media = el.querySelector('iframe, embed, object, video, audio');
    const url =
      (media && mediaSrc(media, base ?? 'about:blank')) ||
      httpUrl(el.querySelector('a[href]')?.getAttribute('href'), base);
    const host = hostOf(url);
    replace(el, {
      kind: name,
      label: humanizeMacroName(name) + (host && !['livesearch', 'pagetreesearch'].includes(name) ? ` (${host})` : ''),
      text: STATIC_TEXT,
      url,
    });
  }

  // 2. Search forms that are not tagged with a macro name.
  for (const form of Array.from(root.querySelectorAll('form'))) {
    if (form.querySelector('input[type="search"], input[type="text"], input:not([type])')) {
      replace(form, { kind: 'search', label: 'Live search', text: STATIC_TEXT });
    }
  }

  // 3. Raw embedded media.
  for (const el of Array.from(root.querySelectorAll('iframe, embed, object, video, audio'))) {
    const tag = el.tagName.toLowerCase();
    const url = mediaSrc(el, base ?? 'about:blank');
    const host = hostOf(url);
    const title = (el.getAttribute('title') || '').trim();
    const label =
      tag === 'video' ? 'Video' : tag === 'audio' ? 'Audio' : tag === 'iframe' ? 'Embedded content' : 'Embedded object';
    replace(el, {
      kind: tag,
      label: label + (title ? `: ${title}` : host ? ` (${host})` : ''),
      text: STATIC_TEXT,
      url,
      inline: false,
    });
  }

  // 4. Empty macro / Connect / Forge app placeholders.
  for (const el of Array.from(root.querySelectorAll('[data-macro-name], .conf-macro.output-block'))) {
    if (!root.contains(el)) continue;
    const name = macroNameOf(el);
    if (BENIGN_EMPTY_MACROS.has(name)) continue;
    if (el.classList.contains('confluence-anchor-link')) continue;
    if (!isEmptyMacro(el)) continue;
    // Anchors (ids) inside an empty container are still link targets: keep them.
    if (el.id || el.querySelector('[id]')) {
      const ids = [el, ...Array.from(el.querySelectorAll('[id]'))].map((e) => e.id).filter(Boolean);
      const holder = doc.createElement('span');
      holder.className = 'cf-anchor';
      for (const id of ids) {
        const s = doc.createElement('span');
        s.id = id;
        holder.appendChild(s);
      }
      el.before(holder);
    }
    const jiraKey = (el.getAttribute('data-jira-key') || '').trim();
    const label = jiraKey ? `Jira issue ${jiraKey}` : name ? humanizeMacroName(name) : 'Macro';
    replace(el, { kind: name || 'macro', label, text: DYNAMIC_TEXT });
  }

  return count;
}
