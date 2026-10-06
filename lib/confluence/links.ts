/**
 * Finds links to other Confluence content in a page body (FR-5). Only same-site content links are
 * returned; attachments, Jira, people, external and mailto links are ignored.
 */
import type { SiteInfo } from '../types';
import { decodeTinyCode, isSameSite, parseConfluenceUrl } from './url';

export interface LinkTargets {
  ids: string[];
  titles: { spaceKey?: string; title: string }[];
  tinyCodes: string[];
}

const LINKABLE_RESOURCE_TYPES = new Set(['page', 'blogpost', 'blog_post', 'folder', 'whiteboard', 'database', 'embed']);
/** Paths (relative to the context path) that never point at exportable content. */
const IGNORED_PATH = /^\/(download|browse|people|images|s|plugins\/servlet|secure|rest|api)\//i;
const IGNORED_ACTION = /\/viewpageattachments\.action$/i;

class Collector {
  private readonly idSet = new Set<string>();
  private readonly titleSet = new Set<string>();
  private readonly codeSet = new Set<string>();
  readonly out: LinkTargets = { ids: [], titles: [], tinyCodes: [] };

  constructor(
    private readonly site: SiteInfo,
    private readonly selfId: string,
  ) {}

  addId(id: string | null | undefined): void {
    if (!id || !/^\d+$/.test(id) || id === this.selfId || this.idSet.has(id)) return;
    this.idSet.add(id);
    this.out.ids.push(id);
  }

  addTitle(title: string | null | undefined, spaceKey?: string | null): void {
    const t = (title ?? '').trim();
    if (!t) return;
    const key = `${spaceKey ?? ''}\u0000${t}`;
    if (this.titleSet.has(key)) return;
    this.titleSet.add(key);
    this.out.titles.push(spaceKey ? { spaceKey, title: t } : { title: t });
  }

  addTiny(code: string): void {
    const id = decodeTinyCode(code);
    if (id) {
      this.addId(id);
      return;
    }
    if (this.codeSet.has(code)) return;
    this.codeSet.add(code);
    this.out.tinyCodes.push(code);
  }

  addUrl(href: string | null | undefined): void {
    if (!href) return;
    const h = href.trim();
    if (!h || h.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(h)) return;
    let abs: URL;
    try {
      abs = new URL(h, this.site.baseUrl.replace(/\/+$/, '') + '/');
    } catch {
      return;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    if (!isSameSite(abs.toString(), this.site)) return;
    const path = abs.pathname.slice(this.site.contextPath.length);
    if (IGNORED_PATH.test(path + '/') || IGNORED_ACTION.test(path)) return;
    if (/^\/display\/~/.test(path)) return;
    const p = parseConfluenceUrl(abs.toString(), this.site.contextPath);
    switch (p.kind) {
      case 'page':
      case 'blogpost':
      case 'folder':
      case 'whiteboard':
      case 'database':
      case 'embed':
        if (p.id) this.addId(p.id);
        else if (p.title && p.kind === 'page') this.addTitle(p.title, p.spaceKey);
        break;
      case 'tiny':
        if (p.tinyCode) this.addTiny(p.tinyCode);
        break;
      default:
        break;
    }
  }
}

/** Links in rendered `export_view` HTML (uses DOMParser: worker tab / tests only). */
export function extractLinksFromExportView(html: string, site: SiteInfo, selfId: string): LinkTargets {
  const c = new Collector(site, selfId);
  if (!html) return c.out;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll<HTMLElement>('a[href], [data-linked-resource-id]');
  for (const el of Array.from(nodes)) {
    // Links inside user mentions / profile cards are never content links.
    if (el.closest('.confluence-userlink, .user-mention, [data-linked-resource-type="userinfo"]')) continue;
    const resType = el.getAttribute('data-linked-resource-type')?.toLowerCase();
    const resId = el.getAttribute('data-linked-resource-id');
    if (resType) {
      if (!LINKABLE_RESOURCE_TYPES.has(resType)) continue; // attachment, userinfo, space, ...
      if (resId && /^\d+$/.test(resId)) {
        c.addId(resId);
        continue;
      }
    }
    if (el.tagName === 'A') c.addUrl(el.getAttribute('href'));
  }
  return c.out;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    try {
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    } catch {
      return m;
    }
  });
}

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out.set(m[1]!.toLowerCase(), decodeXmlEntities(m[3] ?? m[4] ?? ''));
  return out;
}

/**
 * Links in the storage format (XHTML with `ac:`/`ri:` elements). Regex based so it also works
 * without a DOM. `ri:page` elements nested in `ri:attachment` (attachment on another page) are
 * not links to that page and are skipped.
 */
export function extractLinksFromStorage(storage: string, site: SiteInfo, selfId: string): LinkTargets {
  const c = new Collector(site, selfId);
  if (!storage) return c.out;
  const s = storage.replace(/<ri:attachment\b[^>]*?(\/>|>[\s\S]*?<\/ri:attachment>)/gi, '');

  const tagRe = /<(ri:page|ri:content-entity|ri:blog-post|ri:url|a)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(s))) {
    const name = m[1]!.toLowerCase();
    const a = attrs(m[2] ?? '');
    if (name === 'ri:page') {
      const id = a.get('ri:content-id');
      if (id) c.addId(id);
      else c.addTitle(a.get('ri:content-title'), a.get('ri:space-key'));
    } else if (name === 'ri:content-entity' || name === 'ri:blog-post') {
      // Blog posts referenced only by title + posting day cannot be resolved by findPageByTitle.
      c.addId(a.get('ri:content-id'));
    } else if (name === 'ri:url') {
      c.addUrl(a.get('ri:value'));
    } else {
      c.addUrl(a.get('href'));
    }
  }
  return c.out;
}
