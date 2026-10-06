/**
 * Flavour-independent Confluence client interface. `createClient()` picks the Cloud (REST v2 with
 * v1/CQL fallbacks) or Data Center / Server (REST v1) implementation.
 */
import type { ContentType, SiteInfo } from '../types';
import { CloudClient } from './cloud';
import type { HttpOptions } from './http';
import { ServerClient } from './server';

export interface ContentSummary {
  id: string;
  type: ContentType;
  title: string;
  status?: string;
  spaceKey?: string;
  spaceId?: string;
  parentId?: string;
  /** Type of the parent content when known (Cloud v2 reports it; pages can live in folders). */
  parentType?: ContentType;
  position?: number;
  /** depth relative to the queried parent (1 = direct child); set by getDescendants */
  depth?: number;
  hasChildren?: boolean;
  url: string;
}

export interface PageBody {
  id: string;
  type: ContentType;
  title: string;
  spaceKey?: string;
  spaceId?: string;
  /** export_view HTML */
  html: string;
  version?: number;
  lastModified?: string;
  authorDisplayName?: string;
  /** ancestor titles, space root first, excluding the page itself */
  breadcrumb: string[];
  url: string;
  status?: string;
}

export interface SpaceSummary {
  id?: string;
  key: string;
  name: string;
  homepageId?: string;
}

export interface DescendantsOptions {
  /**
   * Called for a branch below the root that could not be listed (429 after retries, 5xx, network).
   * That branch is skipped and the walk continues; failures of the root itself still reject.
   */
  onWarning?: (message: string) => void;
}

/** What the caller already knows about a page, so the client can skip lookups. */
export interface KnownPageInfo {
  /** Ancestor titles (space root first). Skips the breadcrumb lookups on Cloud. */
  breadcrumb?: string[];
}

export interface TitleLookup {
  /** 'page' (default) or 'blogpost'. */
  type?: 'page' | 'blogpost';
  /** Blog posts: posting day `YYYY-MM-DD` (from DC `/display/KEY/YYYY/MM/DD/Title` URLs). */
  postingDay?: string;
}

export interface ConfluenceClient {
  readonly site: SiteInfo;
  /** Metadata for one piece of content. Without `type`, the type is discovered. */
  getContent(id: string, type?: ContentType): Promise<ContentSummary>;
  /** Direct children in sidebar order. */
  getChildren(parent: { id: string; type: ContentType }): Promise<ContentSummary[]>;
  /** All descendants in DFS pre-order (tree order), depth >= 1. */
  getDescendants(
    parent: { id: string; type: ContentType; title?: string },
    maxDepth?: number,
    opts?: DescendantsOptions,
  ): Promise<ContentSummary[]>;
  getSpace(spaceKey: string): Promise<SpaceSummary>;
  /** Top-level content of a space in sidebar order (the homepage first). */
  getSpaceRoots(space: { key: string; id?: string }): Promise<ContentSummary[]>;
  getPageBody(id: string, type: ContentType, known?: KnownPageInfo): Promise<PageBody>;
  getStorageBody(id: string, type: ContentType): Promise<string>;
  /** Exact-title lookup of a page (default) or a blog post in a space. */
  findPageByTitle(spaceKey: string, title: string, lookup?: TitleLookup): Promise<ContentSummary | null>;
  getCurrentUser(): Promise<{ displayName: string } | null>;
}

export function createClient(site: SiteInfo, http?: HttpOptions): ConfluenceClient {
  return site.flavour === 'cloud' ? new CloudClient(site, http) : new ServerClient(site, http);
}

// ───────────────────────────── helpers shared by the implementations ─────────────────────

const CONTENT_TYPES = new Set<ContentType>(['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed', 'slides']);

/** Normalizes API type strings (`page`, `blogpost`, `blog_post`, `folder`, ...). */
export function toContentType(t: unknown): ContentType | null {
  if (typeof t !== 'string') return null;
  const s = t.toLowerCase().replace(/[_-]/g, '');
  if (s === 'blogpost') return 'blogpost';
  return CONTENT_TYPES.has(s as ContentType) ? (s as ContentType) : null;
}

export function toPosition(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Sidebar order: explicit position first (ascending), then title, then id. */
export function compareSiblings(
  a: { position?: number; title: string; id: string },
  b: { position?: number; title: string; id: string },
): number {
  const pa = a.position;
  const pb = b.position;
  if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
  if (pa !== undefined && pb === undefined) return -1;
  if (pa === undefined && pb !== undefined) return 1;
  return collator.compare(a.title, b.title) || collator.compare(a.id, b.id);
}

/**
 * Rebuilds tree order (DFS pre-order, siblings in sidebar order) from a flat list with parentIds.
 * Items whose parent is not in the list are attached under the root so nothing is lost.
 * `depth` is set relative to `rootId` (1 = direct child). Items deeper than `maxDepth` are dropped.
 */
export function buildTreeOrder<T extends ContentSummary>(rootId: string, items: T[], maxDepth?: number): T[] {
  const byId = new Map<string, T>();
  for (const it of items) if (it.id !== rootId && !byId.has(it.id)) byId.set(it.id, it);
  const children = new Map<string, T[]>();
  for (const it of byId.values()) {
    const parent = it.parentId && (it.parentId === rootId || byId.has(it.parentId)) ? it.parentId : rootId;
    let list = children.get(parent);
    if (!list) children.set(parent, (list = []));
    list.push(it);
  }
  for (const list of children.values()) list.sort(compareSiblings);

  const ordered: T[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string, depth: number) => {
    for (const child of children.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      ordered.push({ ...child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(rootId, 1);
  // Nodes caught in a parent cycle (should never happen) are unreachable: keep them at depth 1.
  for (const it of byId.values()) if (!visited.has(it.id)) ordered.push({ ...it, depth: 1 });
  const out = maxDepth === undefined ? ordered : ordered.filter((it) => (it.depth ?? 1) <= maxDepth);
  return out;
}

/** Joins `_links.webui` (relative to the base URL) with the site base URL. */
export function webUiUrl(site: { baseUrl: string; origin: string }, webui: unknown): string | null {
  if (typeof webui !== 'string' || !webui) return null;
  try {
    const u = /^https?:/i.test(webui) ? new URL(webui) : new URL(site.baseUrl.replace(/\/+$/, '') + (webui.startsWith('/') ? '' : '/') + webui);
    return u.origin === site.origin ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Builds a query string from defined values. */
export function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Short reason for a failed request, for warnings ("HTTP 503", "Network error: …"). */
export function failureReason(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status > 0) return `HTTP ${status}`;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : String(e);
}

/** CQL string literal. */
export function cqlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
