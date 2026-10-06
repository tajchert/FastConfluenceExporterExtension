/**
 * Confluence Cloud client: REST API v2 first (verified on a live site), with v1 / CQL fallbacks
 * for tenants or content where a v2 endpoint is missing (404/400/405/501).
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
import {
  assertHasBody,
  descendantsByChildren,
  pickByTitle,
  sortRoots,
  userName,
  v1Body,
  v1Summary,
  type V1Content,
  type V1Space,
  type V1User,
} from './server';
import { contentUrl } from './url';

type Id = string | number;

interface V2Content {
  id: Id;
  type?: string;
  title?: string;
  status?: string;
  spaceId?: Id;
  parentId?: Id | null;
  parentType?: string | null;
  position?: number | string | null;
  authorId?: string;
  version?: { number?: number; createdAt?: string; authorId?: string };
  body?: { export_view?: { value?: string }; storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}

interface V2TreeItem {
  id: Id;
  status?: string;
  title?: string;
  type?: string;
  parentId?: Id | null;
  depth?: number;
  childPosition?: number | string | null;
}

interface V2Space {
  id: Id;
  key: string;
  name?: string;
  homepageId?: Id | null;
}

const COLLECTION: Record<ContentType, string> = {
  page: 'pages',
  blogpost: 'blogposts',
  folder: 'folders',
  whiteboard: 'whiteboards',
  database: 'databases',
  embed: 'embeds',
};

/** Order in which content types are tried when the type of an id is unknown. */
const DISCOVERY_ORDER: ContentType[] = ['blogpost', 'folder', 'whiteboard', 'database', 'embed'];

/** v2 descendants API limit. */
const MAX_V2_DEPTH = 5;
const TREE_CONCURRENCY = 4;
const MAX_BREADCRUMB = 50;

/** The endpoint (or the content under that type) does not exist → try a fallback. */
function isMissing(e: unknown): boolean {
  return e instanceof HttpError && [400, 404, 405, 501].includes(e.status);
}

function str(v: Id | null | undefined): string | undefined {
  return v === null || v === undefined || v === '' ? undefined : String(v);
}

export class CloudClient implements ConfluenceClient {
  readonly site: SiteInfo;
  private readonly http: HttpOptions;
  private readonly v2: string;
  private readonly v1: string;
  private readonly contents = new Map<string, Promise<ContentSummary>>();
  private readonly spaceKeys = new Map<string, Promise<string | undefined>>();
  private readonly spaces = new Map<string, Promise<SpaceSummary>>();
  private readonly users = new Map<string, Promise<string | undefined>>();

  constructor(site: SiteInfo, http: HttpOptions = {}) {
    this.site = site;
    this.http = http;
    const base = site.baseUrl.replace(/\/+$/, '');
    this.v2 = `${base}/api/v2`;
    this.v1 = `${base}/rest/api`;
  }

  private getV2<T>(path: string): Promise<T> {
    return getJson<T>(this.v2 + path, this.http);
  }

  private getV1<T>(path: string): Promise<T> {
    return getJson<T>(this.v1 + path, this.http);
  }

  private listV2<T>(path: string): Promise<T[]> {
    return collectAll<T>(this.v2 + path, this.site, this.http);
  }

  private listV1<T>(path: string): Promise<T[]> {
    return collectAll<T>(this.v1 + path, this.site, this.http);
  }

  private cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
    let p = map.get(key);
    if (!p) {
      p = load();
      map.set(key, p);
      p.catch(() => map.delete(key));
    }
    return p;
  }

  // ───────────────────────────── lookups ─────────────────────────────

  private spaceKeyOf(spaceId: string | undefined): Promise<string | undefined> {
    if (!spaceId) return Promise.resolve(undefined);
    return this.cached(this.spaceKeys, spaceId, () =>
      this.getV2<V2Space>(`/spaces/${encodeURIComponent(spaceId)}`).then(
        (s) => s.key,
        () => undefined,
      ),
    );
  }

  private userDisplayName(accountId: string | undefined): Promise<string | undefined> {
    if (!accountId) return Promise.resolve(undefined);
    return this.cached(this.users, accountId, () =>
      this.getV1<V1User>(`/user${qs({ accountId })}`).then(
        (u) => userName(u),
        () => undefined,
      ),
    );
  }

  private async fromV2(raw: V2Content, type: ContentType, known?: { spaceKey?: string }): Promise<ContentSummary> {
    const id = String(raw.id);
    const spaceId = str(raw.spaceId);
    const spaceKey = known?.spaceKey ?? (await this.spaceKeyOf(spaceId));
    return {
      id,
      type: toContentType(raw.type) ?? type,
      title: raw.title ?? id,
      status: raw.status,
      spaceKey,
      spaceId,
      parentId: str(raw.parentId),
      parentType: toContentType(raw.parentType) ?? undefined,
      position: toPosition(raw.position),
      url: webUiUrl(this.site, raw._links?.webui) ?? contentUrl(this.site, { id, type, spaceKey }),
    };
  }

  private treeItem(
    item: V2TreeItem,
    fallbackParent: string,
    space: { spaceKey?: string; spaceId?: string },
  ): ContentSummary | null {
    const type = toContentType(item.type ?? 'page');
    if (!type) return null;
    const id = String(item.id);
    return {
      id,
      type,
      title: item.title ?? id,
      status: item.status,
      spaceKey: space.spaceKey,
      spaceId: space.spaceId,
      parentId: str(item.parentId) ?? fallbackParent,
      position: toPosition(item.childPosition),
      depth: item.depth,
      url: contentUrl(this.site, { id, type, spaceKey: space.spaceKey }),
    };
  }

  // ───────────────────────────── ConfluenceClient ─────────────────────────────

  getContent(id: string, type?: ContentType): Promise<ContentSummary> {
    return this.cached(this.contents, `${type ?? '*'}:${id}`, () =>
      type ? this.loadTyped(id, type) : this.discover(id),
    );
  }

  private async loadTyped(id: string, type: ContentType): Promise<ContentSummary> {
    try {
      const raw = await this.getV2<V2Content>(`/${COLLECTION[type]}/${encodeURIComponent(id)}`);
      return await this.fromV2(raw, type);
    } catch (e) {
      if (!isMissing(e) || (type !== 'page' && type !== 'blogpost')) throw e;
      try {
        const raw = await this.getV1<V1Content>(`/content/${encodeURIComponent(id)}${qs({ expand: 'space,ancestors' })}`);
        return v1Summary(raw, this.site, { type });
      } catch {
        throw e;
      }
    }
  }

  private async discover(id: string): Promise<ContentSummary> {
    let first: unknown;
    try {
      return await this.loadTyped(id, 'page');
    } catch (e) {
      if (!isMissing(e)) throw e;
      first = e;
    }
    for (const t of DISCOVERY_ORDER) {
      try {
        const raw = await this.getV2<V2Content>(`/${COLLECTION[t]}/${encodeURIComponent(id)}`);
        return await this.fromV2(raw, t);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    throw first;
  }

  async getChildren(parent: { id: string; type: ContentType }): Promise<ContentSummary[]> {
    if (parent.type === 'blogpost') return [];
    const info = await this.getContent(parent.id, parent.type).catch(() => null);
    const space = { spaceKey: info?.spaceKey, spaceId: info?.spaceId };
    const coll = COLLECTION[parent.type];
    const pid = encodeURIComponent(parent.id);

    let children: ContentSummary[];
    try {
      // depth=2 also tells us which children have children (for the lazy tree picker).
      const items = await this.listV2<V2TreeItem>(`/${coll}/${pid}/descendants${qs({ depth: 2, limit: 250 })}`);
      const all = items.map((i) => this.treeItem(i, parent.id, space)).filter((x): x is ContentSummary => !!x);
      const direct = all.filter((c) => (c.parentId ? c.parentId === parent.id : c.depth === 1));
      const parents = new Set(all.map((c) => c.parentId));
      children = direct.map((c) => ({ ...c, depth: undefined, hasChildren: parents.has(c.id) }));
    } catch (e) {
      if (!isMissing(e)) throw e;
      try {
        const items = await this.listV2<V2TreeItem>(`/${coll}/${pid}/direct-children${qs({ limit: 250 })}`);
        children = items
          .map((i) => this.treeItem(i, parent.id, space))
          .filter((x): x is ContentSummary => !!x)
          .map((c) => ({ ...c, parentId: parent.id, depth: undefined }));
      } catch (e2) {
        if (!isMissing(e2)) throw e2;
        if (parent.type !== 'page') return [];
        const items = await this.listV1<V1Content>(
          `/content/${pid}/child/page${qs({ expand: 'extensions.position,childTypes.page', limit: 200 })}`,
        );
        children = items.map((raw) => ({
          ...v1Summary(raw, this.site, { ...space, parentId: parent.id }),
          parentId: parent.id,
        }));
      }
    }
    return children.map((c) => ({ ...c, parentType: parent.type })).sort(compareSiblings);
  }

  async getDescendants(parent: { id: string; type: ContentType }, maxDepth?: number): Promise<ContentSummary[]> {
    const limit = maxDepth === undefined ? Infinity : maxDepth;
    if (limit < 1 || parent.type === 'blogpost') return [];
    const info = await this.getContent(parent.id, parent.type).catch(() => null);
    const space = { spaceKey: info?.spaceKey, spaceId: info?.spaceId };
    const pool = createPool(TREE_CONCURRENCY);
    const all: ContentSummary[] = [];
    const seen = new Set<string>([parent.id]);

    const fetchFrom = async (node: { id: string; type: ContentType }, remaining: number): Promise<void> => {
      const depth = Math.min(MAX_V2_DEPTH, remaining);
      let items: V2TreeItem[];
      try {
        items = await pool(() =>
          this.listV2<V2TreeItem>(
            `/${COLLECTION[node.type]}/${encodeURIComponent(node.id)}/descendants${qs({ depth, limit: 250 })}`,
          ),
        );
      } catch (e) {
        // Below the root, a type without a descendants endpoint simply has no listable children.
        if (node.id !== parent.id && isMissing(e)) return;
        throw e;
      }
      const batch = items.map((i) => this.treeItem(i, node.id, space)).filter((x): x is ContentSummary => !!x);
      // Depth relative to `node`, computed from parentIds (the API's own `depth` field is not relied on).
      const ids = new Map(batch.map((c) => [c.id, c]));
      const rel = new Map<string, number>();
      const relDepth = (c: ContentSummary, guard = 0): number => {
        const known = rel.get(c.id);
        if (known !== undefined) return known;
        const p = c.parentId ? ids.get(c.parentId) : undefined;
        const d = !p || c.parentId === node.id || guard > depth ? 1 : relDepth(p, guard + 1) + 1;
        rel.set(c.id, d);
        return d;
      };
      const frontier: { id: string; type: ContentType }[] = [];
      for (const c of batch) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        all.push(c);
        if (relDepth(c) >= depth && remaining > depth && c.type !== 'blogpost') frontier.push({ id: c.id, type: c.type });
      }
      await Promise.all(frontier.map((f) => fetchFrom(f, remaining - depth)));
    };

    try {
      await fetchFrom(parent, limit);
    } catch (e) {
      if (!isMissing(e)) throw e;
      // Descendants API unavailable for this content: walk children level by level.
      return descendantsByChildren(this, parent, maxDepth);
    }
    return buildTreeOrder(parent.id, all, maxDepth);
  }

  getSpace(spaceKey: string): Promise<SpaceSummary> {
    return this.cached(this.spaces, spaceKey, async () => {
      try {
        const res = await this.getV2<{ results?: V2Space[] }>(`/spaces${qs({ keys: spaceKey, limit: 1 })}`);
        const s = res.results?.find((r) => r.key === spaceKey) ?? res.results?.[0];
        if (s) {
          const id = String(s.id);
          if (!this.spaceKeys.has(id)) this.spaceKeys.set(id, Promise.resolve(s.key));
          return { id, key: s.key, name: s.name ?? s.key, homepageId: str(s.homepageId) };
        }
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      const s = await this.getV1<V1Space>(`/space/${encodeURIComponent(spaceKey)}${qs({ expand: 'homepage' })}`);
      return {
        id: str(s.id),
        key: s.key ?? spaceKey,
        name: s.name ?? spaceKey,
        homepageId: str(s.homepage?.id),
      };
    });
  }

  async getSpaceRoots(space: { key: string; id?: string }): Promise<ContentSummary[]> {
    const info = await this.getSpace(space.key).catch((e) => {
      if (space.id) return null;
      throw e;
    });
    const spaceId = space.id ?? info?.id;
    const homepageId = info?.homepageId;
    if (spaceId) {
      try {
        const items = await this.listV2<V2Content>(
          `/spaces/${encodeURIComponent(spaceId)}/pages${qs({ depth: 'root', limit: 250 })}`,
        );
        const roots = await Promise.all(items.map((raw) => this.fromV2(raw, 'page', { spaceKey: space.key })));
        return sortRoots(roots, homepageId);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    const items = await this.listV1<V1Content>(
      `/space/${encodeURIComponent(space.key)}/content/page${qs({
        depth: 'root',
        expand: 'extensions.position,childTypes.page',
        limit: 200,
      })}`,
    );
    return sortRoots(
      items.map((raw) => v1Summary(raw, this.site, { spaceKey: space.key, spaceId })),
      homepageId,
    );
  }

  async getPageBody(id: string, type: ContentType): Promise<PageBody> {
    assertHasBody(type);
    const enc = encodeURIComponent(id);
    // v1 gives space key, ancestor titles and the author name in one call; failures are tolerated.
    const metaP = this.getV1<V1Content>(`/content/${enc}${qs({ expand: 'space,ancestors,version' })}`).catch(
      () => null,
    );
    let raw: V2Content;
    try {
      raw = await this.getV2<V2Content>(`/${COLLECTION[type]}/${enc}${qs({ 'body-format': 'export_view' })}`);
    } catch (e) {
      if (!isMissing(e)) throw e;
      try {
        const full = await this.getV1<V1Content>(
          `/content/${enc}${qs({ expand: 'body.export_view,version,space,ancestors,history' })}`,
        );
        return v1Body(full, this.site);
      } catch {
        throw e;
      }
    }
    const meta = await metaP;
    const summary = await this.fromV2(raw, type, meta?.space?.key ? { spaceKey: meta.space.key } : undefined);
    const [breadcrumb, author] = await Promise.all([
      meta?.ancestors ? meta.ancestors.map((a) => a.title ?? String(a.id)) : this.breadcrumbFromParents(summary),
      userName(meta?.version?.by) ?? this.userDisplayName(raw.version?.authorId ?? raw.authorId),
    ]);
    return {
      id: summary.id,
      type: summary.type,
      title: summary.title,
      spaceKey: summary.spaceKey,
      spaceId: summary.spaceId,
      html: raw.body?.export_view?.value ?? '',
      version: raw.version?.number ?? meta?.version?.number,
      lastModified: raw.version?.createdAt ?? meta?.version?.when,
      authorDisplayName: author,
      breadcrumb,
      url: summary.url,
      status: summary.status,
    };
  }

  /** Ancestor titles by walking parentId/parentType (cached lookups); never throws. */
  private async breadcrumbFromParents(c: ContentSummary): Promise<string[]> {
    const titles: string[] = [];
    const seen = new Set<string>([c.id]);
    let parentId = c.parentId;
    let parentType: ContentType | undefined = c.parentType;
    try {
      while (parentId && !seen.has(parentId) && titles.length < MAX_BREADCRUMB) {
        seen.add(parentId);
        const p = await this.getContent(parentId, parentType);
        titles.unshift(p.title);
        parentId = p.parentId;
        parentType = p.parentType;
      }
    } catch {
      /* partial breadcrumb is better than none */
    }
    return titles;
  }

  async getStorageBody(id: string, type: ContentType): Promise<string> {
    assertHasBody(type);
    const enc = encodeURIComponent(id);
    try {
      const raw = await this.getV2<V2Content>(`/${COLLECTION[type]}/${enc}${qs({ 'body-format': 'storage' })}`);
      return raw.body?.storage?.value ?? '';
    } catch (e) {
      if (!isMissing(e)) throw e;
      try {
        const raw = await this.getV1<V1Content>(`/content/${enc}${qs({ expand: 'body.storage' })}`);
        return raw.body?.storage?.value ?? '';
      } catch {
        throw e;
      }
    }
  }

  async findPageByTitle(spaceKey: string, title: string): Promise<ContentSummary | null> {
    let space: SpaceSummary | null = null;
    try {
      space = await this.getSpace(spaceKey);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
    if (space.id) {
      try {
        const res = await this.getV2<{ results?: V2Content[] }>(
          `/pages${qs({ 'space-id': space.id, title, limit: 10 })}`,
        );
        const hit = pickByTitle(res.results ?? [], title);
        if (hit) return await this.fromV2(hit, 'page', { spaceKey: space.key });
        return null;
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    const res = await this.getV1<{ results?: V1Content[] }>(
      `/content${qs({ spaceKey, title, type: 'page', expand: 'space,ancestors', limit: 10 })}`,
    );
    const hit = pickByTitle(res.results ?? [], title);
    return hit ? v1Summary(hit, this.site) : null;
  }

  async getCurrentUser(): Promise<{ displayName: string } | null> {
    try {
      const name = userName(await this.getV1<V1User>('/user/current'));
      return name ? { displayName: name } : null;
    } catch {
      return null;
    }
  }
}
