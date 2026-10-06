/**
 * Confluence Data Center / Server client (REST API v1). Also provides the v1 response mappers
 * used by the Cloud client's fallbacks.
 */
import type { ContentType, SiteInfo } from '../types';
import { createPool } from '../util/pool';
import {
  buildTreeOrder,
  compareSiblings,
  qs,
  toContentType,
  toPosition,
  webUiUrl,
  type ConfluenceClient,
  type ContentSummary,
  type PageBody,
  type SpaceSummary,
} from './client';
import { collectAll, getJson, HttpError, type HttpOptions } from './http';
import { contentUrl } from './url';

type Id = string | number;

export interface V1User {
  type?: string;
  displayName?: string;
  publicName?: string;
  username?: string;
  accountId?: string;
}

export interface V1Content {
  id: Id;
  type?: string;
  status?: string;
  title?: string;
  space?: { id?: Id; key?: string; name?: string };
  version?: { number?: number; when?: string; by?: V1User };
  history?: { createdBy?: V1User; lastUpdated?: { when?: string; by?: V1User } };
  ancestors?: { id: Id; title?: string; type?: string }[];
  body?: {
    export_view?: { value?: string };
    view?: { value?: string };
    storage?: { value?: string };
  };
  extensions?: { position?: unknown };
  childTypes?: { page?: { value?: boolean } };
  _links?: { webui?: string; base?: string };
}

export interface V1Space {
  id?: Id;
  key: string;
  name?: string;
  homepage?: { id?: Id };
}

export function userName(u: V1User | undefined): string | undefined {
  if (!u || u.type === 'anonymous') return undefined;
  const n = u.displayName || u.publicName || u.username;
  return n ? String(n) : undefined;
}

export function v1Summary(raw: V1Content, site: SiteInfo, fallback?: Partial<ContentSummary>): ContentSummary {
  const id = String(raw.id);
  const type = toContentType(raw.type) ?? fallback?.type ?? 'page';
  const spaceKey = raw.space?.key ?? fallback?.spaceKey;
  const ancestors = raw.ancestors ?? [];
  const parent = ancestors[ancestors.length - 1];
  const hasChildren = raw.childTypes?.page?.value;
  return {
    id,
    type,
    title: raw.title ?? fallback?.title ?? id,
    status: raw.status,
    spaceKey,
    spaceId: raw.space?.id !== undefined ? String(raw.space.id) : fallback?.spaceId,
    parentId: parent ? String(parent.id) : fallback?.parentId,
    parentType: parent ? (toContentType(parent.type) ?? 'page') : fallback?.parentType,
    position: toPosition(raw.extensions?.position) ?? fallback?.position,
    ...(typeof hasChildren === 'boolean' ? { hasChildren } : {}),
    url: webUiUrl(site, raw._links?.webui) ?? contentUrl(site, { id, type, spaceKey }),
  };
}

export function v1Body(raw: V1Content, site: SiteInfo): PageBody {
  const s = v1Summary(raw, site);
  return {
    id: s.id,
    type: s.type,
    title: s.title,
    spaceKey: s.spaceKey,
    spaceId: s.spaceId,
    html: raw.body?.export_view?.value ?? raw.body?.view?.value ?? '',
    version: raw.version?.number,
    lastModified: raw.version?.when ?? raw.history?.lastUpdated?.when,
    authorDisplayName:
      userName(raw.version?.by) ?? userName(raw.history?.lastUpdated?.by) ?? userName(raw.history?.createdBy),
    breadcrumb: (raw.ancestors ?? []).map((a) => a.title ?? String(a.id)),
    url: s.url,
    status: s.status,
  };
}

/** Best match for an exact-title lookup: exact case first, current status first. */
export function pickByTitle<T extends { title?: string; status?: string }>(items: T[], title: string): T | null {
  const want = title.trim();
  const exact = items.filter((i) => (i.title ?? '').trim() === want);
  const loose = exact.length ? exact : items.filter((i) => (i.title ?? '').trim().toLowerCase() === want.toLowerCase());
  return loose.find((i) => !i.status || i.status === 'current') ?? loose[0] ?? null;
}

/** Concurrent requests used while walking a tree. */
const TREE_CONCURRENCY = 4;
const CHILD_EXPAND = 'extensions.position,childTypes.page';

export class ServerClient implements ConfluenceClient {
  readonly site: SiteInfo;
  private readonly http: HttpOptions;
  private readonly api: string;
  private readonly contents = new Map<string, Promise<ContentSummary>>();
  private readonly spaces = new Map<string, Promise<SpaceSummary>>();

  constructor(site: SiteInfo, http: HttpOptions = {}) {
    this.site = site;
    this.http = http;
    this.api = `${site.baseUrl.replace(/\/+$/, '')}/rest/api`;
  }

  private get<T>(path: string): Promise<T> {
    return getJson<T>(this.api + path, this.http);
  }

  private list<T>(path: string): Promise<T[]> {
    return collectAll<T>(this.api + path, this.site, this.http);
  }

  getContent(id: string, type?: ContentType): Promise<ContentSummary> {
    let p = this.contents.get(id);
    if (!p) {
      p = this.get<V1Content>(`/content/${encodeURIComponent(id)}${qs({ expand: 'space,ancestors' })}`).then((raw) =>
        v1Summary(raw, this.site, type ? { type } : undefined),
      );
      this.contents.set(id, p);
      p.catch(() => this.contents.delete(id));
    }
    return p;
  }

  async getChildren(parent: { id: string; type: ContentType }): Promise<ContentSummary[]> {
    // Only pages have child pages on DC/Server (no folders, whiteboards, ...).
    if (parent.type !== 'page') return [];
    const [items, parentInfo] = await Promise.all([
      this.list<V1Content>(
        `/content/${encodeURIComponent(parent.id)}/child/page${qs({ expand: CHILD_EXPAND, limit: 200 })}`,
      ),
      this.getContent(parent.id, parent.type).catch(() => null),
    ]);
    return items
      .map((raw) =>
        v1Summary(raw, this.site, {
          spaceKey: parentInfo?.spaceKey,
          spaceId: parentInfo?.spaceId,
          parentId: parent.id,
          parentType: 'page',
        }),
      )
      .map((s) => ({ ...s, parentId: parent.id, parentType: 'page' as const }))
      .sort(compareSiblings);
  }

  async getDescendants(parent: { id: string; type: ContentType }, maxDepth?: number): Promise<ContentSummary[]> {
    return descendantsByChildren(this, parent, maxDepth);
  }

  getSpace(spaceKey: string): Promise<SpaceSummary> {
    let p = this.spaces.get(spaceKey);
    if (!p) {
      p = this.get<V1Space>(`/space/${encodeURIComponent(spaceKey)}${qs({ expand: 'homepage' })}`).then((s) => ({
        id: s.id !== undefined ? String(s.id) : undefined,
        key: s.key ?? spaceKey,
        name: s.name ?? spaceKey,
        homepageId: s.homepage?.id !== undefined ? String(s.homepage.id) : undefined,
      }));
      this.spaces.set(spaceKey, p);
      p.catch(() => this.spaces.delete(spaceKey));
    }
    return p;
  }

  async getSpaceRoots(space: { key: string; id?: string }): Promise<ContentSummary[]> {
    const [items, info] = await Promise.all([
      this.list<V1Content>(
        `/space/${encodeURIComponent(space.key)}/content/page${qs({ depth: 'root', expand: CHILD_EXPAND, limit: 200 })}`,
      ),
      this.getSpace(space.key).catch(() => null),
    ]);
    const roots = items.map((raw) => v1Summary(raw, this.site, { spaceKey: space.key, spaceId: info?.id ?? space.id }));
    return sortRoots(roots, info?.homepageId);
  }

  async getPageBody(id: string, type: ContentType): Promise<PageBody> {
    assertHasBody(type);
    const raw = await this.get<V1Content>(
      `/content/${encodeURIComponent(id)}${qs({ expand: 'body.export_view,version,space,ancestors,history' })}`,
    );
    return v1Body(raw, this.site);
  }

  async getStorageBody(id: string, type: ContentType): Promise<string> {
    assertHasBody(type);
    const raw = await this.get<V1Content>(`/content/${encodeURIComponent(id)}${qs({ expand: 'body.storage' })}`);
    return raw.body?.storage?.value ?? '';
  }

  async findPageByTitle(spaceKey: string, title: string): Promise<ContentSummary | null> {
    const res = await this.get<{ results?: V1Content[] }>(
      `/content${qs({ spaceKey, title, type: 'page', expand: 'space,ancestors', limit: 10 })}`,
    );
    const hit = pickByTitle(res.results ?? [], title);
    return hit ? v1Summary(hit, this.site) : null;
  }

  async getCurrentUser(): Promise<{ displayName: string } | null> {
    try {
      const name = userName(await this.get<V1User>('/user/current'));
      return name ? { displayName: name } : null;
    } catch {
      return null;
    }
  }
}

export function assertHasBody(type: ContentType): void {
  if (type !== 'page' && type !== 'blogpost') {
    throw new HttpError(400, '', `Content of type "${type}" has no exportable body`);
  }
}

export function sortRoots(roots: ContentSummary[], homepageId?: string): ContentSummary[] {
  return [...roots].sort((a, b) => {
    if (homepageId && a.id === homepageId) return -1;
    if (homepageId && b.id === homepageId) return 1;
    return compareSiblings(a, b);
  });
}

/**
 * Tree walk via repeated `getChildren` calls (level by level, bounded concurrency), returned in
 * tree order. Used by DC/Server and as the Cloud fallback when the descendants API is unavailable.
 */
export async function descendantsByChildren(
  client: Pick<ConfluenceClient, 'getChildren'>,
  parent: { id: string; type: ContentType },
  maxDepth?: number,
): Promise<ContentSummary[]> {
  const limit = maxDepth === undefined ? Infinity : maxDepth;
  if (limit < 1) return [];
  const pool = createPool(TREE_CONCURRENCY);
  const all: ContentSummary[] = [];
  const seen = new Set<string>([parent.id]);
  let level: { id: string; type: ContentType }[] = [parent];
  for (let depth = 1; depth <= limit && level.length > 0; depth++) {
    const results = await Promise.all(level.map((node) => pool(() => client.getChildren(node))));
    const next: { id: string; type: ContentType }[] = [];
    results.forEach((children, i) => {
      for (const c of children) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        all.push({ ...c, parentId: level[i]!.id });
        if (c.hasChildren !== false) next.push({ id: c.id, type: c.type });
      }
    });
    level = next;
  }
  return buildTreeOrder(parent.id, all, maxDepth);
}
