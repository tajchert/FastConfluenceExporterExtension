import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudClient } from '../../lib/confluence/cloud';
import { buildTreeOrder, createClient, type ContentSummary } from '../../lib/confluence/client';
import { ServerClient } from '../../lib/confluence/server';
import type { SiteInfo } from '../../lib/types';
import { CLOUD_DIRECT_CHILD, CLOUD_USER_PROFILE_FORBIDDEN, cqlNonPageHits } from './fixtures/publicSites';

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

  it('getChildren lists one level with direct-children (no grandchildren listing)', async () => {
    const seen = route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/1') return { body: { id: '1', title: 'Root', spaceId: '77' } };
      if (u.pathname === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'ENG' } };
      if (u.pathname === '/wiki/api/v2/pages/1/direct-children')
        return {
          body: {
            results: [
              { id: '2', title: 'T2', type: 'page', status: 'current', childPosition: 20 },
              { id: '2b', title: 'T2b', type: 'page', status: 'current', childPosition: 10 },
            ],
            _links: {},
          },
        };
      return undefined;
    });
    const c = new CloudClient(cloud);
    const kids = await c.getChildren({ id: '1', type: 'page' });
    expect(kids.map((k) => [k.id, k.hasChildren, k.spaceKey, k.parentId])).toEqual([
      ['2b', undefined, 'ENG', '1'],
      ['2', undefined, 'ENG', '1'],
    ]);
    expect(seen.some((s) => s.includes('/descendants'))).toBe(false);
    // Children are remembered: looking one up again costs no request.
    const before = seen.length;
    await expect(c.getContent('2', 'page')).resolves.toMatchObject({ id: '2', title: 'T2', parentId: '1' });
    expect(seen.length).toBe(before);
  });

  it('getPageBody: one v2 request per page, breadcrumb/author/space from cached lookups', async () => {
    const seen = route((u) => {
      const p = u.pathname;
      if (p === '/wiki/api/v2/pages/5')
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
      if (p === '/wiki/api/v2/pages/4') return { body: { id: '4', title: 'Four', spaceId: '77', parentId: '1', parentType: 'page' } };
      if (p === '/wiki/api/v2/pages/1') return { body: { id: '1', title: 'Home', spaceId: '77' } };
      if (p === '/wiki/api/v2/pages/6')
        return {
          body: {
            id: '6',
            title: 'Six',
            spaceId: '77',
            parentId: '4',
            parentType: 'page',
            version: { number: 1, authorId: 'acc-1' },
            body: { export_view: { value: '<p>6</p>' } },
          },
        };
      if (p === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'ENG' } };
      if (p === '/wiki/rest/api/user' && u.searchParams.get('accountId') === 'acc-1') return { body: { displayName: 'Ada Lovelace' } };
      return undefined;
    });
    const c = new CloudClient(cloud);
    const b = await c.getPageBody('5', 'page');
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
    expect(seen.filter((s) => s.startsWith('/wiki/rest/api/content'))).toEqual([]);
    // A sibling shares the space, author and ancestors: only its own body is requested.
    const before = seen.length;
    await expect(c.getPageBody('6', 'page')).resolves.toMatchObject({ breadcrumb: ['Home', 'Four'], authorDisplayName: 'Ada Lovelace', spaceKey: 'ENG' });
    expect(seen.slice(before)).toEqual(['/wiki/api/v2/pages/6?body-format=export_view']);
    // A known breadcrumb skips the ancestor walk entirely.
    const c2 = new CloudClient(cloud);
    await expect(c2.getPageBody('5', 'page', { breadcrumb: ['X'] })).resolves.toMatchObject({ breadcrumb: ['X'] });
  });

  it('does not remember a transient space-key failure, but remembers a 404', async () => {
    let spaceCalls = 0;
    let fail = true;
    route((u) => {
      const p = u.pathname;
      const m = /^\/wiki\/api\/v2\/pages\/(\d+)$/.exec(p);
      if (m) return { body: { id: m[1], title: `P${m[1]}`, spaceId: m[1] === '9' ? '99' : '77' } };
      if (p === '/wiki/api/v2/spaces/77') {
        spaceCalls++;
        return fail ? { status: 503, body: { message: 'busy' } } : { body: { id: '77', key: 'ENG' } };
      }
      return undefined; // space 99: 404
    });
    const c = new CloudClient(cloud, { maxRetries: 0 });
    await expect(c.getContent('1', 'page')).resolves.toMatchObject({ spaceKey: undefined });
    fail = false;
    await expect(c.getContent('2', 'page')).resolves.toMatchObject({ spaceKey: 'ENG' });
    await expect(c.getContent('3', 'page')).resolves.toMatchObject({ spaceKey: 'ENG' });
    expect(spaceCalls).toBe(2);
    await expect(c.getContent('9', 'page')).resolves.toMatchObject({ spaceKey: undefined });
  });

  it('getDescendants skips a branch whose listing fails and reports it', async () => {
    const seen = route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/1') return { body: { id: '1', title: 'Root', spaceId: '77' } };
      if (u.pathname === '/wiki/api/v2/spaces/77') return { body: { id: '77', key: 'ENG' } };
      if (u.pathname === '/wiki/api/v2/pages/6/descendants') return { status: 500, body: { message: 'boom' } };
      return descendantsHandler(u);
    });
    const warnings: string[] = [];
    const all = await new CloudClient(cloud, { maxRetries: 0 }).getDescendants({ id: '1', type: 'page' }, undefined, {
      onWarning: (w) => warnings.push(w),
    });
    expect(all.map((x) => x.id)).toContain('6');
    expect(all.map((x) => x.id)).not.toContain('7');
    expect(warnings).toEqual(['Could not list the pages under “T6” (HTTP 500); that branch was skipped.']);
    expect(seen.some((s) => s.startsWith('/wiki/api/v2/pages/6b/descendants'))).toBe(true);
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
      if (u.pathname === '/wiki/rest/api/content' && u.searchParams.get('type') === 'blogpost')
        return {
          body: {
            results: [{ id: '40', type: 'blogpost', title: u.searchParams.get('title'), space: { key: 'ENG' } }],
            start: 0,
            limit: 10,
            size: 1,
          },
        };
      return undefined;
    });
    const c = new CloudClient(cloud);
    expect((await c.getSpaceRoots({ key: 'ENG' })).map((r) => r.id)).toEqual(['20', '10']);
    await expect(c.findPageByTitle('ENG', 'Design Doc')).resolves.toMatchObject({ id: '30', spaceKey: 'ENG' });
    await expect(c.findPageByTitle('ENG', 'Launch', { type: 'blogpost', postingDay: '2026-10-01' })).resolves.toMatchObject({
      id: '40',
      type: 'blogpost',
    });
  });

  it('anonymous: a 403 on user profiles stops further author lookups', async () => {
    const seen = route((u) => {
      const m = u.pathname.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/);
      if (m) return { body: { id: m[1], title: `P${m[1]}`, spaceId: '7', version: { number: 1, authorId: `acct-${m[1]}` }, body: { export_view: { value: '<p/>' } } } };
      if (u.pathname === '/wiki/api/v2/spaces/7') return { body: { id: '7', key: 'AI' } };
      if (u.pathname === '/wiki/rest/api/user') return { status: 403, body: CLOUD_USER_PROFILE_FORBIDDEN };
      return undefined;
    });
    const c = new CloudClient(cloud);
    await expect(c.getPageBody('1', 'page', { breadcrumb: [] })).resolves.toMatchObject({ authorDisplayName: undefined, spaceKey: 'AI' });
    await c.getPageBody('2', 'page', { breadcrumb: [] });
    await c.getPageBody('3', 'page', { breadcrumb: [] });
    expect(seen.filter((s) => s.startsWith('/wiki/rest/api/user'))).toHaveLength(1);
  });

  it('getSpaceRoots also lists non-page content at the space root (CQL), and keeps slides in the tree', async () => {
    route((u) => {
      if (u.pathname === '/wiki/api/v2/spaces') return { body: { results: [{ id: '77', key: 'AI', name: 'AI', homepageId: '20' }] } };
      if (u.pathname === '/wiki/api/v2/spaces/77/pages') return { body: { results: [{ id: '20', title: 'Home', spaceId: '77', position: 5 }] } };
      if (u.pathname === '/wiki/rest/api/search') {
        expect(u.searchParams.get('cql')).toBe('space = "AI" and type in (folder, whiteboard, database, embed)');
        expect(u.searchParams.get('expand')).toBe('content.ancestors');
        return { body: cqlNonPageHits('900') };
      }
      if (u.pathname === '/wiki/api/v2/folders/900') return { body: { id: '900', type: 'folder', title: 'Archive', spaceId: '77', parentId: null, position: 1 } };
      if (u.pathname === '/wiki/api/v2/pages/20/direct-children')
        return { body: { results: [CLOUD_DIRECT_CHILD, { id: '31', status: 'current', title: 'Deck', type: 'slides', childPosition: 5 }] } };
      if (u.pathname === '/wiki/api/v2/pages/20') return { body: { id: '20', title: 'Home', spaceId: '77' } };
      return undefined;
    });
    const c = new CloudClient(cloud);
    const roots = await c.getSpaceRoots({ key: 'AI' });
    expect(roots.map((r) => `${r.id}:${r.type}`)).toEqual(['20:page', '900:folder']);
    const kids = await c.getChildren({ id: '20', type: 'page' });
    expect(kids.map((k) => `${k.id}:${k.type}`)).toEqual(['31:slides', '29156212770:folder']);
  });

  it('discovers an untyped id without asking the v2 blog post endpoint', async () => {
    const seen = route((u) => {
      if (u.pathname === '/wiki/rest/api/content/12') return { body: { id: '12', type: 'blogpost', title: 'News', space: { key: 'ENG' } } };
      return undefined;
    });
    await expect(new CloudClient(cloud).getContent('12')).resolves.toMatchObject({ id: '12', type: 'blogpost' });
    expect(seen.some((s) => s.includes('/blogposts/'))).toBe(false);
    const seen2 = route(() => undefined);
    await expect(new CloudClient(cloud).getContent('13')).rejects.toThrow();
    expect(seen2.filter((s) => s.includes('/blogposts/'))).toEqual([]);
  });
});

describe('ServerClient', () => {
  it('sorts children by position, then title; walks descendants in tree order', async () => {
    route((u) => {
      const m = u.pathname.match(/^\/confluence\/rest\/api\/content\/(\w+)\/child\/page$/);
      if (m) {
        const kids: Record<string, unknown[]> = {
          '1': [
            { id: 12, type: 'page', title: 'beta', extensions: { position: 'none' }, space: { key: 'OPS', id: 5 } },
            { id: 11, type: 'page', title: 'Zulu', extensions: { position: 0 }, space: { key: 'OPS', id: 5 } },
            { id: 13, type: 'page', title: 'Alpha', extensions: {}, space: { key: 'OPS', id: 5 } },
          ],
          '11': [{ id: 111, type: 'page', title: 'Child', space: { key: 'OPS', id: 5 } }],
        };
        if (m[1] === '13') return { status: 500, body: { message: 'boom' } };
        return { body: { results: kids[m[1]!] ?? [], start: 0, limit: 200, size: (kids[m[1]!] ?? []).length } };
      }
      return undefined;
    });
    const c = new ServerClient(dc, { maxRetries: 0 });
    expect((await c.getChildren({ id: '1', type: 'page' })).map((x) => x.title)).toEqual(['Zulu', 'Alpha', 'beta']);
    const warnings: string[] = [];
    const all = await c.getDescendants({ id: '1', type: 'page' }, undefined, { onWarning: (w) => warnings.push(w) });
    expect(all.map((x) => `${x.id}@${x.depth}`)).toEqual(['11@1', '111@2', '13@1', '12@1']);
    // "Alpha" (13) could not be listed: its branch is skipped, the walk goes on.
    expect(warnings).toEqual(['Could not list the pages under “Alpha” (HTTP 500); that branch was skipped.']);
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

  it('remembers the ancestor chain of a content, so walking up costs no requests', async () => {
    const seen = route((u) => {
      if (u.pathname === '/confluence/rest/api/content/7')
        return {
          body: {
            id: 7,
            type: 'page',
            title: 'Seven',
            space: { key: 'OPS', id: 5 },
            ancestors: [
              { id: 1, type: 'page', title: 'Root' },
              { id: 3, type: 'page', title: 'Three' },
            ],
          },
        };
      return undefined;
    });
    const c = new ServerClient(dc);
    await expect(c.getContent('7')).resolves.toMatchObject({ parentId: '3' });
    await expect(c.getContent('3')).resolves.toMatchObject({ title: 'Three', parentId: '1', spaceKey: 'OPS' });
    await expect(c.getContent('1')).resolves.toMatchObject({ title: 'Root', parentId: undefined });
    expect(seen).toHaveLength(1);
  });

  it('children inherit the parent space instead of expanding it on every child', async () => {
    const seen = route((u) => {
      if (u.pathname === '/confluence/rest/api/content/1') return { body: { id: 1, type: 'page', title: 'Root', space: { key: 'COC', id: 5 }, ancestors: [] } };
      if (u.pathname === '/confluence/rest/api/content/1/child/page')
        return { body: { results: [{ id: 2, type: 'page', title: 'Denver 2024', extensions: { position: 'none' } }], start: 0, limit: 200, size: 1 } };
      return undefined;
    });
    const kids = await new ServerClient(dc).getChildren({ id: '1', type: 'page' });
    expect(kids[0]).toMatchObject({ id: '2', spaceKey: 'COC', spaceId: '5', parentId: '1' });
    const listing = seen.find((s) => s.includes('/child/page'))!;
    expect(new URL(listing, 'https://x').searchParams.get('expand')).toBe('extensions.position,childTypes.page');
  });

  it('looks up blog posts by title and posting day', async () => {
    const seen = route((u) => {
      if (u.pathname === '/confluence/rest/api/content')
        return { body: { results: [{ id: 9, type: 'blogpost', title: 'Launch' }], start: 0, limit: 10, size: 1 } };
      return undefined;
    });
    await expect(new ServerClient(dc).findPageByTitle('OPS', 'Launch', { type: 'blogpost', postingDay: '2026-10-01' })).resolves.toMatchObject({
      id: '9',
      type: 'blogpost',
    });
    expect(seen[0]).toContain('type=blogpost');
    expect(seen[0]).toContain('postingDay=2026-10-01');
  });
});
