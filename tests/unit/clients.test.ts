import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudClient } from '../../lib/confluence/cloud';
import { buildTreeOrder, createClient, type ContentSummary } from '../../lib/confluence/client';
import { ServerClient } from '../../lib/confluence/server';
import type { SiteInfo } from '../../lib/types';

const cloud: SiteInfo = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
};
const dc: SiteInfo = {
  origin: 'https://intranet.example.org',
  baseUrl: 'https://intranet.example.org/confluence',
  contextPath: '/confluence',
  flavour: 'server',
};

type Handler = (u: URL) => { status?: number; body: unknown } | undefined;

function route(handler: Handler) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      const r = handler(u) ?? { status: 404, body: { message: 'not found' } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createClient', () => {
  it('picks the implementation by flavour', () => {
    expect(createClient(cloud)).toBeInstanceOf(CloudClient);
    expect(createClient(dc)).toBeInstanceOf(ServerClient);
  });
});

describe('buildTreeOrder', () => {
  it('orders by position then title and attaches orphans to the root', () => {
    const mk = (id: string, parentId: string, position?: number, title = id): ContentSummary => ({
      id,
      parentId,
      position,
      title,
      type: 'page',
      url: '',
    });
    const out = buildTreeOrder('R', [mk('c', 'a', 1), mk('b', 'R', 2), mk('a', 'R', 1), mk('z', 'GONE'), mk('d', 'a', undefined, 'D')]);
    expect(out.map((x) => `${x.id}@${x.depth}`)).toEqual(['a@1', 'c@2', 'd@2', 'b@1', 'z@1']);
    expect(buildTreeOrder('R', [mk('a', 'R', 1), mk('c', 'a', 1)], 1).map((x) => x.id)).toEqual(['a']);
  });
});

describe('CloudClient', () => {
  // Chain 1 → 2 → … → 8 (each also has a sibling "Nb" with lower childPosition = first).
  const parentOf = new Map<string, string>();
  for (let i = 2; i <= 8; i++) {
    parentOf.set(String(i), String(i - 1));
    parentOf.set(`${i}b`, String(i - 1));
  }
  const childrenOf = (id: string) => [...parentOf.entries()].filter(([, p]) => p === id).map(([c]) => c);

  function descendantsHandler(u: URL) {
    const m = u.pathname.match(/^\/wiki\/api\/v2\/pages\/([^/]+)\/descendants$/);
    if (!m) return undefined;
    const depth = Number(u.searchParams.get('depth'));
    const items: unknown[] = [];
    const walk = (id: string, d: number) => {
      if (d > depth) return;
      for (const c of childrenOf(id)) {
        items.push({
          id: c,
          title: `T${c}`,
          type: 'page',
          status: 'current',
          parentId: id,
          depth: d,
          childPosition: c.endsWith('b') ? 10 : 20,
        });
        walk(c, d + 1);
      }
    };
    walk(m[1]!, 1);
    items.reverse(); // API order is not tree order
    return { body: { results: items, _links: {} } };
  }

  it('getDescendants recurses past the depth-5 API limit and rebuilds tree order', async () => {
    const seen = route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/1') return { body: { id: '1', title: 'Root', spaceId: '77', status: 'current' } };
      if (u.pathname === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'ENG' } };
      return descendantsHandler(u);
    });
    const c = new CloudClient(cloud);
    const all = await c.getDescendants({ id: '1', type: 'page' });
    expect(all.map((x) => `${x.id}@${x.depth}`)).toEqual([
      '2b@1', '2@1', '3b@2', '3@2', '4b@3', '4@3', '5b@4', '5@4', '6b@5', '6@5', '7b@6', '7@6', '8b@7', '8@7',
    ]);
    expect(all[0]!.spaceKey).toBe('ENG');
    expect(all[0]!.url).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/2b');
    expect(seen.some((s) => s.startsWith('/wiki/api/v2/pages/6/descendants'))).toBe(true);

    const limited = await new CloudClient(cloud).getDescendants({ id: '1', type: 'page' }, 2);
    expect(limited.map((x) => x.id)).toEqual(['2b', '2', '3b', '3']);
  });

  it('getChildren reports hasChildren from a depth-2 descendants call', async () => {
    route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/1') return { body: { id: '1', title: 'Root', spaceId: '77' } };
      if (u.pathname === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'ENG' } };
      return descendantsHandler(u);
    });
    const kids = await new CloudClient(cloud).getChildren({ id: '1', type: 'page' });
    expect(kids.map((k) => [k.id, k.hasChildren])).toEqual([
      ['2b', false],
      ['2', true],
    ]);
  });

  it('getPageBody combines v2 body with v1 metadata', async () => {
    route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/5')
        return {
          body: {
            id: '5',
            title: 'Five',
            status: 'current',
            spaceId: '77',
            parentId: '4',
            parentType: 'page',
            version: { number: 3, createdAt: '2026-09-30T10:00:00Z', authorId: 'acc-1' },
            body: { export_view: { value: '<p>hi</p>' } },
            _links: { webui: '/spaces/ENG/pages/5/Five' },
          },
        };
      if (u.pathname === '/wiki/rest/api/content/5')
        return {
          body: {
            id: '5',
            type: 'page',
            title: 'Five',
            space: { key: 'ENG', id: 77 },
            version: { number: 3, by: { displayName: 'Ada Lovelace' } },
            ancestors: [{ id: '1', title: 'Home' }, { id: '4', title: 'Four' }],
          },
        };
      return undefined;
    });
    const b = await new CloudClient(cloud).getPageBody('5', 'page');
    expect(b).toMatchObject({
      id: '5',
      title: 'Five',
      html: '<p>hi</p>',
      spaceKey: 'ENG',
      version: 3,
      lastModified: '2026-09-30T10:00:00Z',
      authorDisplayName: 'Ada Lovelace',
      breadcrumb: ['Home', 'Four'],
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/5/Five',
    });
  });

  it('getPageBody falls back to v2 lookups when v1 metadata is unavailable', async () => {
    route((u) => {
      const p = u.pathname;
      if (p === '/wiki/api/v2/blogposts/9')
        return {
          body: {
            id: '9',
            title: 'Blog',
            spaceId: '77',
            version: { number: 1, createdAt: '2026-01-01T00:00:00Z', authorId: 'acc-2' },
            body: { export_view: { value: '<p>b</p>' } },
          },
        };
      if (p === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'NEWS' } };
      if (p === '/wiki/rest/api/user' && u.searchParams.get('accountId') === 'acc-2')
        return { body: { displayName: 'Grace Hopper' } };
      return undefined;
    });
    const b = await new CloudClient(cloud).getPageBody('9', 'blogpost');
    expect(b).toMatchObject({ spaceKey: 'NEWS', authorDisplayName: 'Grace Hopper', breadcrumb: [], type: 'blogpost' });
    expect(b.url).toBe('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=9');
  });

  it('getContent falls back to v1 when the v2 endpoint 404s, and discovers types', async () => {
    route((u) => {
      if (u.pathname === '/wiki/rest/api/content/3')
        return { body: { id: '3', type: 'page', title: 'Three', status: 'current', space: { key: 'OPS' }, ancestors: [{ id: '2' }] } };
      if (u.pathname === '/wiki/api/v2/folders/8') return { body: { id: '8', title: 'Folder', spaceId: '77', parentId: '1', parentType: 'page' } };
      if (u.pathname === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'ENG' } };
      return undefined;
    });
    const c = new CloudClient(cloud);
    await expect(c.getContent('3', 'page')).resolves.toMatchObject({ id: '3', title: 'Three', spaceKey: 'OPS', parentId: '2' });
    await expect(c.getContent('8')).resolves.toMatchObject({
      id: '8',
      type: 'folder',
      spaceKey: 'ENG',
      url: 'https://acme.atlassian.net/wiki/spaces/ENG/folder/8',
    });
  });

  it('getSpaceRoots puts the homepage first; findPageByTitle resolves exact titles', async () => {
    route((u) => {
      if (u.pathname === '/wiki/api/v2/spaces' && u.searchParams.get('keys') === 'ENG')
        return { body: { results: [{ id: '77', key: 'ENG', name: 'Engineering', homepageId: '20' }] } };
      if (u.pathname === '/wiki/api/v2/spaces/77/pages')
        return {
          body: {
            results: [
              { id: '10', title: 'Orphan', spaceId: '77', position: 1 },
              { id: '20', title: 'Home', spaceId: '77', position: 5 },
            ],
          },
        };
      if (u.pathname === '/wiki/api/v2/pages' && u.searchParams.get('space-id') === '77')
        return { body: { results: [{ id: '30', title: u.searchParams.get('title'), spaceId: '77', status: 'current' }] } };
      return undefined;
    });
    const c = new CloudClient(cloud);
    expect((await c.getSpaceRoots({ key: 'ENG' })).map((r) => r.id)).toEqual(['20', '10']);
    await expect(c.findPageByTitle('ENG', 'Design Doc')).resolves.toMatchObject({ id: '30', spaceKey: 'ENG' });
  });
});

describe('ServerClient', () => {
  it('sorts children by position, then title; walks descendants in tree order', async () => {
    route((u) => {
      const m = u.pathname.match(/^\/confluence\/rest\/api\/content\/(\w+)\/child\/page$/);
      if (m) {
        const kids: Record<string, unknown[]> = {
          '1': [
            { id: 12, type: 'page', title: 'beta', extensions: { position: 'none' } },
            { id: 11, type: 'page', title: 'Zulu', extensions: { position: 0 } },
            { id: 13, type: 'page', title: 'Alpha', extensions: {} },
          ],
          '11': [{ id: 111, type: 'page', title: 'Child' }],
        };
        return { body: { results: kids[m[1]!] ?? [], start: 0, limit: 200, size: (kids[m[1]!] ?? []).length } };
      }
      if (u.pathname === '/confluence/rest/api/content/1')
        return { body: { id: 1, type: 'page', title: 'Root', space: { key: 'OPS', id: 5 } } };
      return undefined;
    });
    const c = new ServerClient(dc);
    expect((await c.getChildren({ id: '1', type: 'page' })).map((x) => x.title)).toEqual(['Zulu', 'Alpha', 'beta']);
    const all = await c.getDescendants({ id: '1', type: 'page' });
    expect(all.map((x) => `${x.id}@${x.depth}`)).toEqual(['11@1', '111@2', '13@1', '12@1']);
    expect(all[0]!.spaceKey).toBe('OPS');
    expect(all[0]!.url).toBe('https://intranet.example.org/confluence/pages/viewpage.action?pageId=11');
    expect(await c.getChildren({ id: '1', type: 'blogpost' })).toEqual([]);
  });

  it('maps page bodies and space roots', async () => {
    route((u) => {
      if (u.pathname === '/confluence/rest/api/content/7')
        return {
          body: {
            id: 7,
            type: 'page',
            status: 'current',
            title: 'Seven',
            space: { key: 'OPS', id: 5 },
            version: { number: 4, when: '2025-05-05T05:05:05.000Z', by: { displayName: 'Linus' } },
            ancestors: [{ id: 1, title: 'Root' }],
            body: { export_view: { value: '<p>7</p>' } },
            _links: { webui: '/display/OPS/Seven', base: 'https://intranet.example.org/confluence' },
          },
        };
      if (u.pathname === '/confluence/rest/api/space/OPS')
        return { body: { id: 5, key: 'OPS', name: 'Operations', homepage: { id: 2 } } };
      if (u.pathname === '/confluence/rest/api/space/OPS/content/page')
        return {
          body: {
            results: [
              { id: 3, type: 'page', title: 'Another root' },
              { id: 2, type: 'page', title: 'Home' },
            ],
            start: 0,
            limit: 200,
            size: 2,
          },
        };
      if (u.pathname === '/confluence/rest/api/user/current') return { body: { type: 'known', displayName: 'Linus', username: 'linus' } };
      return undefined;
    });
    const c = new ServerClient(dc);
    await expect(c.getPageBody('7', 'page')).resolves.toMatchObject({
      html: '<p>7</p>',
      spaceKey: 'OPS',
      breadcrumb: ['Root'],
      authorDisplayName: 'Linus',
      version: 4,
      url: 'https://intranet.example.org/confluence/display/OPS/Seven',
    });
    expect((await c.getSpaceRoots({ key: 'OPS' })).map((r) => r.id)).toEqual(['2', '3']);
    await expect(c.getSpace('OPS')).resolves.toEqual({ id: '5', key: 'OPS', name: 'Operations', homepageId: '2' });
    await expect(c.getCurrentUser()).resolves.toEqual({ displayName: 'Linus' });
    await expect(c.getPageBody('7', 'folder')).rejects.toThrow(/no exportable body/);
  });
});
