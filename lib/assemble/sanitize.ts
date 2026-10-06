/**
 * Turns one page's Confluence `export_view` HTML into a safe, print-ready DocumentFragment.
 *
 * Structural rewrites happen on an inert DOMParser document (no scripts run, no resources load),
 * then DOMPurify runs as the last step so that nothing we produced can bypass it.
 */
import DOMPurify from 'dompurify';
import type { SiteInfo } from '../types';
import { replaceUnsupportedContent } from './macros';

export interface SanitizeContext {
  pageId: string;
  site: SiteInfo;
  pageUrl: string;
  /** id → in-document anchor for every page in the export (`#p-{id}`) */
  exportedIds: Set<string>;
  includeComments: boolean;
}

const CONTENT_TYPES = new Set(['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed']);

/** Confluence UI chrome that has no place on paper. */
const CHROME_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'link',
  'meta',
  'base',
  'title',
  'button',
  '.aui-button',
  '.aui-icon',
  '.confluence-information-macro-icon',
  '.expand-control-icon',
  '.refresh-action-group',
  '.refresh-wiki',
  '.copy-heading-link-container',
  '.heading-anchor-wrapper',
].join(',');

const PURIFY_CONFIG = {
  RETURN_DOM_FRAGMENT: true as const,
  ALLOW_DATA_ATTR: true,
  FORBID_TAGS: [
    'style', 'form', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'datalist',
    'output', 'iframe', 'object', 'embed', 'video', 'audio', 'source', 'track', 'frame', 'frameset',
    'link', 'meta', 'base', 'dialog', 'template', 'slot', 'marquee', 'blink',
  ],
  FORBID_ATTR: [
    'autofocus', 'tabindex', 'contenteditable', 'draggable', 'popover', 'popovertarget', 'target',
    'formaction', 'action', 'srcset', 'sizes', 'loading', 'ping', 'inert',
  ],
};

const WRAPPER_ATTR = 'data-cf-sanitize-root';

/** Form controls that carry no printable content (checkboxes were already turned into glyphs). */
const CONTROL_SELECTOR = 'input, select, textarea, datalist, output, option, optgroup';
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background', 'cite']);

const DANGEROUS_POSITIONS = new Set(['fixed', 'absolute', 'sticky']);

/** Inline style properties that would clip or float content on paper. */
const STRIPPED_STYLE_PROPS = ['overflow', 'overflow-x', 'overflow-y', 'max-height'];

export function sanitizePageHtml(html: string, ctx: SanitizeContext): DocumentFragment {
  if (!DOMPurify.isSupported) throw new Error('HTML sanitizer is not available in this context');
  const parsed = new DOMParser().parseFromString(html || '', 'text/html');
  const body = parsed.body;
  const prefix = `p${ctx.pageId}-`;

  for (const el of Array.from(body.querySelectorAll(CHROME_SELECTOR))) el.remove();
  replaceUnsupportedContent(body, { pageUrl: ctx.pageUrl });

  convertCheckboxes(body);
  markTaskLists(body);
  openExpands(body);
  replaceEmojiImages(body);
  handleComments(body, ctx.includeComments);
  fixImages(body, ctx.site);
  fixMediaAttributes(body, ctx.site);
  rewriteLinks(body, ctx, prefix);
  prefixIds(body, prefix);
  demoteHeadings(body);
  promoteHeaderRows(body);
  cleanInlineStyles(body);
  stripActiveContent(body);

  // Sanitize a wrapper element (DOMPurify refuses a parentless <body> root) as a node, so the
  // rewritten tree is not re-serialized and re-parsed (which could restructure it).
  const wrapper = parsed.createElement('div');
  wrapper.setAttribute(WRAPPER_ATTR, '');
  while (body.firstChild) wrapper.appendChild(body.firstChild);
  const purified = DOMPurify.sanitize(wrapper, PURIFY_CONFIG);
  const kids = Array.from(purified.childNodes);
  const only = kids.length === 1 ? kids[0] : undefined;
  if (only && only.nodeType === 1 && (only as Element).hasAttribute(WRAPPER_ATTR)) {
    const out = purified.ownerDocument.createDocumentFragment();
    while (only.firstChild) out.appendChild(only.firstChild);
    return out;
  }
  return purified;
}

// ───────────────────────────── helpers ───────────────────────────────────────────────────────

function renameElement(el: Element, tag: string): Element {
  const doc = el.ownerDocument;
  const out = doc.createElement(tag);
  for (const attr of Array.from(el.attributes)) out.setAttribute(attr.name, attr.value);
  while (el.firstChild) out.appendChild(el.firstChild);
  el.replaceWith(out);
  return out;
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  el.remove();
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function absolutize(raw: string, site: SiteInfo): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^(data|blob):/i.test(v)) return v;
  try {
    return new URL(v, site.baseUrl.replace(/\/+$/, '') + '/').href;
  } catch {
    return null;
  }
}

function glyph(doc: Document, checked: boolean, radio = false): HTMLElement {
  const s = doc.createElement('span');
  s.className = checked ? 'cf-task-box cf-task-box-checked' : 'cf-task-box';
  s.setAttribute('aria-hidden', 'true');
  s.textContent = radio ? (checked ? '◉' : '○') : checked ? '☑' : '☐';
  return s;
}

function convertCheckboxes(root: Element): void {
  const doc = root.ownerDocument;
  for (const input of Array.from(root.querySelectorAll('input[type="checkbox"], input[type="radio"]'))) {
    const checked = input.hasAttribute('checked') || input.getAttribute('aria-checked') === 'true';
    input.replaceWith(glyph(doc, checked, input.getAttribute('type') === 'radio'));
  }
}

function markTaskLists(root: Element): void {
  const doc = root.ownerDocument;
  const items = root.querySelectorAll('ul.inline-task-list > li, li[data-inline-task-id], li[data-task-local-id]');
  for (const li of Array.from(items)) {
    if (li.classList.contains('cf-task')) continue;
    const checked =
      li.classList.contains('checked') ||
      li.getAttribute('aria-checked') === 'true' ||
      /^(complete|done|checked)$/i.test(li.getAttribute('data-inline-task-status') || li.getAttribute('data-task-state') || '');
    li.classList.add('cf-task');
    if (checked) li.classList.add('cf-task-done');
    li.parentElement?.classList.add('cf-task-list');
    const first = li.firstElementChild;
    if (first && first.classList.contains('cf-task-box')) continue;
    li.insertBefore(glyph(doc, checked), li.firstChild);
  }
}

function openExpands(root: Element): void {
  const doc = root.ownerDocument;
  for (const container of Array.from(root.querySelectorAll('.expand-container'))) {
    container.classList.add('cf-expand');
    for (const control of Array.from(container.children).filter((c) => c.classList.contains('expand-control'))) {
      const text = (control.querySelector('.expand-control-text')?.textContent || control.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        const title = doc.createElement('div');
        title.className = 'cf-expand-title';
        title.textContent = text;
        control.replaceWith(title);
      } else {
        control.remove();
      }
    }
  }
  for (const content of Array.from(root.querySelectorAll('.expand-content, .expand-hidden'))) {
    content.classList.remove('expand-hidden');
    content.classList.add('cf-expand-body');
    content.removeAttribute('aria-hidden');
    content.removeAttribute('hidden');
    (content as HTMLElement).style?.removeProperty('display');
  }
  for (const details of Array.from(root.querySelectorAll('details'))) details.setAttribute('open', '');
  // Any remaining leftover expand control (outside a container) is pure UI.
  for (const control of Array.from(root.querySelectorAll('.expand-control'))) control.remove();
}

function replaceEmojiImages(root: Element): void {
  const doc = root.ownerDocument;
  for (const img of Array.from(root.querySelectorAll('img[data-emoji-fallback], img.emoticon[data-emoji-id]'))) {
    const fallback = (img.getAttribute('data-emoji-fallback') || '').trim();
    // Custom emoji have a ":shortname:" fallback; keep their image.
    if (!fallback || fallback.startsWith(':') || fallback.length > 16) continue;
    const span = doc.createElement('span');
    span.className = 'cf-emoji';
    span.textContent = fallback;
    const label = img.getAttribute('data-emoji-shortname') || img.getAttribute('alt');
    if (label) span.setAttribute('title', label);
    img.replaceWith(span);
  }
}

function handleComments(root: Element, include: boolean): void {
  for (const marker of Array.from(root.querySelectorAll('.inline-comment-marker'))) {
    if (include) marker.classList.add('cf-comment');
    else unwrap(marker);
  }
}

function fixImages(root: Element, site: SiteInfo): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    // Confluence often serves a thumbnail in `src` and the original in `data-image-src`.
    const full = img.getAttribute('data-image-src');
    const src = (full && full.trim()) || img.getAttribute('src') || '';
    const abs = absolutize(src, site);
    if (abs) img.setAttribute('src', abs);
    else img.removeAttribute('src');
    img.removeAttribute('srcset');
    img.removeAttribute('sizes');
    img.removeAttribute('loading');
    img.setAttribute('decoding', 'sync');
  }
  for (const source of Array.from(root.querySelectorAll('picture > source'))) source.remove();
}

function fixMediaAttributes(root: Element, site: SiteInfo): void {
  for (const attr of ['poster', 'background', 'cite']) {
    for (const el of Array.from(root.querySelectorAll(`[${attr}]`))) {
      const abs = absolutize(el.getAttribute(attr) || '', site);
      if (abs) el.setAttribute(attr, abs);
      else el.removeAttribute(attr);
    }
  }
}

/** Extracts a content id from a same-site Confluence URL (Cloud and DC shapes). */
export function contentIdFromUrl(url: URL, site: SiteInfo): string | null {
  if (url.origin !== site.origin) return null;
  let path = url.pathname;
  const ctxPath = site.contextPath.replace(/\/+$/, '');
  if (ctxPath) {
    if (path !== ctxPath && !path.startsWith(ctxPath + '/')) return null;
    path = path.slice(ctxPath.length);
  }
  const pageId = url.searchParams.get('pageId');
  if (/\/pages\/(viewpage|viewpageattachments|editpage)\.action$/i.test(path) && pageId && /^\d+$/.test(pageId)) {
    return pageId;
  }
  const patterns = [
    /^\/spaces\/[^/]+\/pages\/(?:edit-v2\/|edit\/)?(\d+)(?:\/|$)/,
    /^\/spaces\/[^/]+\/blog\/(?:edit-v2\/)?(?:\d{4}\/\d{1,2}\/\d{1,2}\/)?(\d+)(?:\/|$)/,
    /^\/spaces\/[^/]+\/(?:folder|whiteboard|database|embed)\/(\d+)(?:\/|$)/,
  ];
  for (const re of patterns) {
    const m = re.exec(path);
    if (m?.[1]) return m[1];
  }
  const tiny = /^\/x\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (tiny?.[1]) return decodeTiny(tiny[1]);
  return null;
}

/** Tiny link code → content id (base64url, little-endian integer). */
function decodeTiny(code: string): string | null {
  try {
    let b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    let n = 0n;
    for (let i = bin.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bin.charCodeAt(i));
    return n > 0n ? n.toString() : null;
  } catch {
    return null;
  }
}

function linkedResourceId(a: Element): string | null {
  const id = (a.getAttribute('data-linked-resource-id') || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const type = (a.getAttribute('data-linked-resource-type') || '').trim().toLowerCase();
  return !type || CONTENT_TYPES.has(type) ? id : null;
}

function rewriteLinks(root: Element, ctx: SanitizeContext, prefix: string): void {
  for (const a of Array.from(root.querySelectorAll('a[href], area[href]'))) {
    // Placeholder links deliberately point at Confluence itself.
    if (a.closest('.cf-placeholder')) continue;
    const raw = (a.getAttribute('href') || '').trim();
    a.removeAttribute('target');
    if (!raw || raw === '#' || /^\s*(javascript|vbscript|data):/i.test(raw)) {
      a.removeAttribute('href');
      continue;
    }
    if (raw.startsWith('#')) {
      a.setAttribute('href', '#' + prefix + raw.slice(1));
      a.setAttribute('data-cf-fallback', `#p-${ctx.pageId}`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw, ctx.site.baseUrl.replace(/\/+$/, '') + '/');
    } catch {
      a.removeAttribute('href');
      continue;
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const targetId = url.origin === ctx.site.origin ? (linkedResourceId(a) ?? contentIdFromUrl(url, ctx.site)) : null;
      if (targetId && (targetId === ctx.pageId || ctx.exportedIds.has(targetId))) {
        const frag = url.hash ? safeDecode(url.hash.slice(1)) : '';
        if (frag) {
          a.setAttribute('href', `#p${targetId}-${frag}`);
          a.setAttribute('data-cf-fallback', `#p-${targetId}`);
        } else {
          a.setAttribute('href', `#p-${targetId}`);
        }
        a.classList.add('cf-internal-link');
        continue;
      }
    }
    a.setAttribute('href', url.href);
  }
}

const ID_REF_ATTRS = ['headers', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'for'];

function prefixIds(root: Element, prefix: string): void {
  for (const el of Array.from(root.querySelectorAll('[id]'))) {
    const id = el.getAttribute('id');
    if (id) el.setAttribute('id', prefix + id);
    else el.removeAttribute('id');
  }
  // Legacy named anchors become ids so in-document links still find them.
  for (const a of Array.from(root.querySelectorAll('a[name]'))) {
    const name = a.getAttribute('name');
    a.removeAttribute('name');
    if (name && !a.hasAttribute('id')) a.setAttribute('id', prefix + name);
  }
  for (const attr of ID_REF_ATTRS) {
    for (const el of Array.from(root.querySelectorAll(`[${attr}]`))) {
      const v = (el.getAttribute(attr) || '').trim();
      if (!v) continue;
      el.setAttribute(attr, v.split(/\s+/).map((t) => prefix + t).join(' '));
    }
  }
  for (const map of Array.from(root.querySelectorAll('map[name]'))) {
    map.setAttribute('name', prefix + map.getAttribute('name'));
  }
  for (const img of Array.from(root.querySelectorAll('[usemap]'))) {
    const v = (img.getAttribute('usemap') || '').replace(/^#/, '');
    if (v) img.setAttribute('usemap', '#' + prefix + v);
  }
}

function demoteHeadings(root: Element): void {
  // Collected up front so every heading is shifted exactly once.
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5'))) {
    const level = Number(h.tagName.charAt(1));
    renameElement(h, `h${level + 1}`);
  }
}

/** Confluence puts header rows in <tbody> as <th> cells; move them to <thead> so they repeat. */
function promoteHeaderRows(root: Element): void {
  const doc = root.ownerDocument;
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const children = Array.from(table.children);
    if (children.some((c) => c.tagName === 'THEAD')) continue;
    const tbody = children.find((c) => c.tagName === 'TBODY');
    if (!tbody) continue;
    const rows = Array.from(tbody.children).filter((r) => r.tagName === 'TR');
    const first = rows[0];
    if (!first || rows.length < 2) continue;
    const cells = Array.from(first.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    if (cells.length === 0 || !cells.every((c) => c.tagName === 'TH')) continue;
    // Row spans reaching into the body would break if the row moved to <thead>.
    if (cells.some((c) => Number(c.getAttribute('rowspan') || '1') > 1)) continue;
    const thead = doc.createElement('thead');
    thead.appendChild(first);
    table.insertBefore(thead, tbody);
  }
}

/**
 * Defense in depth before DOMPurify: drop event handlers, script URLs and form controls ourselves
 * so the result never depends on a single library's behaviour.
 */
function stripActiveContent(root: Element): void {
  for (const el of Array.from(root.querySelectorAll(CONTROL_SELECTOR))) el.remove();
  for (const form of Array.from(root.querySelectorAll('form'))) unwrap(form);
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.has(name)) {
        const compact = attr.value.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
        // data: URLs are only meaningful (and inert) as <img> sources.
        if (/^(javascript|vbscript):/.test(compact) || (compact.startsWith('data:') && el.tagName !== 'IMG')) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }
}

/** `url(javascript:…)` / `url(vbscript:…)` in inline styles (inert in Chrome, removed anyway). */
const SCRIPT_URL_IN_CSS = /url\(\s*(['"]?)\s*(java|vb)script:/i;

function cleanInlineStyles(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('[style]')) as HTMLElement[]) {
    const style = el.style;
    if (!style) continue;
    for (const p of Array.from(style)) {
      if (SCRIPT_URL_IN_CSS.test(style.getPropertyValue(p).replace(/[\u0000-\u0020]+/g, ' '))) style.removeProperty(p);
    }
    if (DANGEROUS_POSITIONS.has((style.getPropertyValue('position') || '').trim().toLowerCase())) {
      for (const p of ['position', 'top', 'right', 'bottom', 'left', 'z-index', 'inset']) style.removeProperty(p);
    }
    for (const p of STRIPPED_STYLE_PROPS) style.removeProperty(p);
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }
}
