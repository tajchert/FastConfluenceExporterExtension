/**
 * Confluence URL parsing for Cloud (`/wiki/...`, custom domains) and Data Center / Server
 * (any context path such as `/confluence` or none at all).
 *
 * NOTE: lib/confluence/detect.ts contains a self-contained copy of this logic because it is
 * serialized into the page by chrome.scripting.executeScript. Keep the two in sync.
 */
import type { ContentType, SiteInfo } from '../types';

export interface ParsedConfluenceUrl {
  kind: 'page' | 'blogpost' | 'folder' | 'whiteboard' | 'database' | 'embed' | 'space' | 'tiny' | 'unknown';
  id?: string;
  spaceKey?: string;
  tinyCode?: string;
  /** DC `/display/KEY/Page+Title` URLs carry a title instead of an id. */
  title?: string;
  /** DC blog post URLs `/display/KEY/YYYY/MM/DD/Title`: the posting day as `YYYY-MM-DD`. */
  postingDay?: string;
  editor?: boolean;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes a Confluence tiny-link code (`/x/{code}`) to a content id, offline.
 * The code is the content id as little-endian bytes, base64url-encoded with trailing
 * zero bytes (`A`s) and padding removed. `phDOEg` → `315494566`.
 */
export function decodeTinyCode(code: string): string | null {
  let s = (code ?? '').trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!s || s.length > 24) return null;
  for (const ch of s) if (B64.indexOf(ch) < 0) return null;
  // Pad with 'A' (zero bits): extra zero bytes are the high-order bytes in little-endian.
  while (s.length % 4 !== 0) s += 'A';
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const n =
      (B64.indexOf(s[i]!) << 18) | (B64.indexOf(s[i + 1]!) << 12) | (B64.indexOf(s[i + 2]!) << 6) | B64.indexOf(s[i + 3]!);
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]!);
  return value > 0n ? value.toString() : null;
}

const NUMERIC = /^\d+$/;
const EDIT_SEGMENTS = new Set(['edit', 'edit-v2', 'edit-embed']);
const EDITOR_ACTIONS = new Set(['editpage.action', 'editblogpost.action', 'resumedraft.action']);
const LINK_ONLY_SEGMENTS: Record<string, ParsedConfluenceUrl['kind']> = {
  folder: 'folder',
  whiteboard: 'whiteboard',
  database: 'database',
  embed: 'embed',
};

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** DC `/display/KEY/Page+Title`: `+` is a space, then percent-decoding. */
function decodeDisplayTitle(raw: string): string {
  return safeDecode(raw.replace(/\+/g, ' ')).trim();
}

function isDatePath(y?: string, m?: string, d?: string): boolean {
  return !!y && !!m && !!d && /^\d{4}$/.test(y) && /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d);
}

function parseAction(raw: string[], q: URLSearchParams): ParsedConfluenceUrl | null {
  const last = raw[raw.length - 1];
  if (!last || !last.toLowerCase().endsWith('.action')) return null;
  const action = last.toLowerCase();
  const editor = EDITOR_ACTIONS.has(action) || undefined;
  // Cloud redirects `/x/{code}` to `/pages/tinyurl.action?urlIdentifier={code}` (then the SPA
  // rewrites the address on the client).
  if (action === 'tinyurl.action') {
    const code = (q.get('urlIdentifier') ?? '').trim();
    if (!code) return { kind: 'unknown' };
    const id = decodeTinyCode(code);
    return { kind: 'tiny', tinyCode: code, ...(id ? { id } : {}) };
  }
  const pageId = q.get('pageId') ?? q.get('contentId') ?? (action === 'resumedraft.action' ? q.get('draftId') : null);
  if (pageId && NUMERIC.test(pageId)) return { kind: 'page', id: pageId, ...(editor ? { editor } : {}) };
  const spaceKey = q.get('spaceKey') ?? q.get('key') ?? undefined;
  const title = q.get('title');
  if (spaceKey && title && (action === 'viewpage.action' || action === 'display.action')) {
    return { kind: 'page', spaceKey, title: title.trim() };
  }
  if (spaceKey) return { kind: 'space', spaceKey };
  return { kind: 'unknown' };
}

function parseSegments(raw: string[], q: URLSearchParams): ParsedConfluenceUrl | null {
  const action = parseAction(raw, q);
  if (action) return action;
  const seg = raw.map(safeDecode);
  const [s0, s1, s2, s3, s4] = seg;

  if (s0 === 'x' && s1) {
    const id = decodeTinyCode(raw[1]!);
    return { kind: 'tiny', tinyCode: raw[1]!, ...(id ? { id } : {}) };
  }

  if (s0 === 'spaces') {
    if (!s1) return { kind: 'unknown' };
    const spaceKey = s1;
    if (!s2 || s2 === 'overview') return { kind: 'space', spaceKey };
    if (s2 === 'pages') {
      if (s3 && NUMERIC.test(s3)) {
        const editor = seg.slice(4).some((s) => EDIT_SEGMENTS.has(s));
        return { kind: 'page', id: s3, spaceKey, ...(editor ? { editor } : {}) };
      }
      if (s3 && s4 && NUMERIC.test(s4)) return { kind: 'page', id: s4, spaceKey, editor: true };
      return { kind: 'space', spaceKey };
    }
    if (s2 === 'blog') {
      if (isDatePath(s3, s4, seg[5]) && seg[6] && NUMERIC.test(seg[6])) {
        return { kind: 'blogpost', id: seg[6], spaceKey };
      }
      if (s3 && NUMERIC.test(s3)) {
        const editor = seg.slice(4).some((s) => EDIT_SEGMENTS.has(s));
        return { kind: 'blogpost', id: s3, spaceKey, ...(editor ? { editor } : {}) };
      }
      if (s3 && s4 && NUMERIC.test(s4)) return { kind: 'blogpost', id: s4, spaceKey, editor: true };
      return { kind: 'space', spaceKey };
    }
    const linkOnly = LINK_ONLY_SEGMENTS[s2];
    if (linkOnly) {
      if (s3 && NUMERIC.test(s3)) return { kind: linkOnly, id: s3, spaceKey };
      if (s3 && s4 && NUMERIC.test(s4)) return { kind: linkOnly, id: s4, spaceKey, editor: true };
    }
    return { kind: 'space', spaceKey };
  }

  if (s0 === 'display') {
    if (!s1) return { kind: 'unknown' };
    const spaceKey = s1;
    if (!raw[2]) return { kind: 'space', spaceKey };
    if (isDatePath(s2, s3, s4) && raw[5]) {
      const title = decodeDisplayTitle(raw[5]);
      const postingDay = `${s2}-${s3!.padStart(2, '0')}-${s4!.padStart(2, '0')}`;
      return title ? { kind: 'blogpost', spaceKey, title, postingDay } : { kind: 'space', spaceKey };
    }
    const title = decodeDisplayTitle(raw[2]);
    return title ? { kind: 'page', spaceKey, title } : { kind: 'space', spaceKey };
  }

  return null;
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0);
}

/**
 * Parses a Confluence URL. `contextPath` ('' | '/wiki' | '/confluence' ...) is stripped when
 * given; without it, up to two leading path segments are tried as a context path.
 */
export function parseConfluenceUrl(url: string, contextPath?: string): ParsedConfluenceUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'unknown' };
  }
  const segments = splitPath(u.pathname);
  const candidates: string[][] = [];
  const ctx = contextPath === undefined ? undefined : contextPath.replace(/\/+$/, '');
  if (ctx !== undefined && (ctx === '' || u.pathname === ctx || u.pathname.startsWith(ctx + '/'))) {
    candidates.push(segments.slice(splitPath(ctx).length));
  } else {
    for (let skip = 0; skip <= Math.min(2, segments.length); skip++) candidates.push(segments.slice(skip));
  }
  for (const c of candidates) {
    const parsed = parseSegments(c, u.searchParams);
    if (parsed) return parsed;
  }
  return { kind: 'unknown' };
}

const LINK_ONLY_TYPES = new Set<ContentType>(['folder', 'whiteboard', 'database', 'embed']);

/** Canonical absolute URL that opens the content in Confluence. */
export function contentUrl(site: SiteInfo, c: { id: string; type: ContentType; spaceKey?: string }): string {
  const base = site.baseUrl.replace(/\/+$/, '');
  const id = encodeURIComponent(c.id);
  if (site.flavour === 'cloud' && c.spaceKey) {
    const key = encodeURIComponent(c.spaceKey);
    if (c.type === 'page') return `${base}/spaces/${key}/pages/${id}`;
    if (LINK_ONLY_TYPES.has(c.type)) return `${base}/spaces/${key}/${c.type}/${id}`;
  }
  // viewpage.action works for pages and blog posts on every Cloud and DC/Server version.
  return `${base}/pages/viewpage.action?pageId=${id}`;
}

/** True when `url` is on the same origin and under the site's context path. */
export function isSameSite(url: string, site: SiteInfo): boolean {
  let u: URL;
  try {
    u = new URL(url, site.baseUrl + '/');
  } catch {
    return false;
  }
  if (u.origin !== site.origin) return false;
  const ctx = site.contextPath.replace(/\/+$/, '');
  return !ctx || u.pathname === ctx || u.pathname.startsWith(ctx + '/');
}
