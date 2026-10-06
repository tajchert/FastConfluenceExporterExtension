/**
 * Finds links to other Confluence content in a page body (FR-5). Only same-site content links are
 * returned; attachments, Jira, people, external and mailto links are ignored.
 */
import type { ContentType, SiteInfo } from '../types';
import { decodeTinyCode, isSameSite, parseConfluenceUrl } from './url';

export interface TitleTarget {
  spaceKey?: string;
  title: string;
  /** Set for blog posts (DC dated URLs, `ri:blog-post`); pages otherwise. */
  type?: 'blogpost';
  /** Blog posts: `YYYY-MM-DD`. */
  postingDay?: string;
}

export interface LinkTargets {
  ids: string[];
  /**
   * Content type of an id when the link tells it (`data-linked-resource-type`, URL shape), so
   * resolving it needs no type discovery (up to 6 requests on Cloud for an unknown id).
   */
  types: Record<string, ContentType>;
  titles: TitleTarget[];
  tinyCodes: string[];
}

const RESOURCE_TYPES: Record<string, ContentType> = {
  page: 'page',
  blogpost: 'blogpost',
  blog_post: 'blogpost',
  folder: 'folder',
  whiteboard: 'whiteboard',
  database: 'database',
  embed: 'embed',
};
/** Paths (relative to the context path) that never point at exportable content. */
const IGNORED_PATH = /^\/(download|browse|people|images|s|plugins\/servlet|secure|rest|api)\//i;
const IGNORED_ACTION = /\/viewpageattachments\.action$/i;

class Collector {
  private readonly idSet = new Set<string>();
  private readonly titleSet = new Set<string>();
  private readonly codeSet = new Set<string>();
  readonly out: LinkTargets = { ids: [], types: {}, titles: [], tinyCodes: [] };

  constructor(
    private readonly site: SiteInfo,
    private readonly selfId: string,
  ) {}

  addId(id: string | null | undefined, type?: ContentType): void {
    if (!id || !/^\d+$/.test(id) || id === this.selfId) return;
    if (type && !this.out.types[id]) this.out.types[id] = type;
    if (this.idSet.has(id)) return;
    this.idSet.add(id);
    this.out.ids.push(id);
  }

  addTitle(
    title: string | null | undefined,
    spaceKey?: string | null,
    blog?: { postingDay?: string },
  ): void {
    const t = (title ?? '').trim();
    if (!t) return;
    const key = `${spaceKey ?? ''}\u0000${t}\u0000${blog ? `blog:${blog.postingDay ?? ''}` : ''}`;
    if (this.titleSet.has(key)) return;
    this.titleSet.add(key);
    const target: TitleTarget = { title: t };
    if (spaceKey) target.spaceKey = spaceKey;
    if (blog) {
      target.type = 'blogpost';
      if (blog.postingDay) target.postingDay = blog.postingDay;
    }
    this.out.titles.push(target);
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
    // A personal space's profile (`/display/~user`), not a page in it (`/display/~user/Title`).
    if (/^\/display\/~[^/]+\/?$/.test(path)) return;
    const p = parseConfluenceUrl(abs.toString(), this.site.contextPath);
    switch (p.kind) {
      case 'page':
      case 'blogpost':
      case 'folder':
      case 'whiteboard':
      case 'database':
      case 'embed':
        if (p.id) this.addId(p.id, p.kind);
        else if (p.title && p.kind === 'page') this.addTitle(p.title, p.spaceKey);
        else if (p.title && p.kind === 'blogpost') this.addTitle(p.title, p.spaceKey, { postingDay: p.postingDay });
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
      const type = RESOURCE_TYPES[resType];
      if (!type) continue; // attachment, userinfo, space, ...
      if (resId && /^\d+$/.test(resId)) {
        c.addId(resId, type);
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
      if (id) c.addId(id, 'page');
      else c.addTitle(a.get('ri:content-title'), a.get('ri:space-key'));
    } else if (name === 'ri:blog-post') {
      const id = a.get('ri:content-id');
      if (id) c.addId(id, 'blogpost');
      else {
        // Storage writes the posting day as YYYY/MM/DD.
        const day = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(a.get('ri:posting-day') ?? '');
        const postingDay = day ? `${day[1]}-${day[2]!.padStart(2, '0')}-${day[3]!.padStart(2, '0')}` : undefined;
        c.addTitle(a.get('ri:content-title'), a.get('ri:space-key'), { postingDay });
      }
    } else if (name === 'ri:content-entity') {
      c.addId(a.get('ri:content-id'));
    } else if (name === 'ri:url') {
      c.addUrl(a.get('ri:value'));
    } else {
      c.addUrl(a.get('href'));
    }
  }
  return c.out;
}
