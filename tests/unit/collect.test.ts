import { describe, expect, it } from 'vitest';
import type { ConfluenceClient, ContentSummary, PageBody, SpaceSummary } from '../../lib/confluence/client';
import { collect } from '../../lib/confluence/collect';
import { HttpError } from '../../lib/confluence/http';
import { DEFAULT_OPTIONS, type ContentType, type ExportRequest, type SiteInfo } from '../../lib/types';
import { isAbortError } from '../../lib/util/abort';

const site: SiteInfo = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
};

interface Node {
  id: string;
  type?: ContentType;
  title: string;
  parentId?: string;
  position?: number;
  status?: string;
  space?: string;
  html?: string;
  storage?: string;
}

const link = (id: string) =>
  `<a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/${id}" data-linked-resource-id="${id}" data-linked-resource-type="page">p${id}</a>`;

class FakeClient implements ConfluenceClient {
  readonly site = site;
  readonly nodes = new Map<string, Node>();
  calls: string[] = [];
  constructor(nodes: Node[]) {
    for (const n of nodes) this.nodes.set(n.id, n);
  }
  private sum(n: Node, depth?: number): ContentSummary {
    const parent = n.parentId ? this.nodes.get(n.parentId) : undefined;
    return {
      id: n.id,
      type: n.type ?? 'page',
      title: n.title,
      status: n.status ?? 'current',
      spaceKey: n.space ?? 'ENG',
      parentId: n.parentId,
      parentType: parent ? (parent.type ?? 'page') : undefined,
      position: n.position,
      url: `${site.baseUrl}/spaces/${n.space ?? 'ENG'}/pages/${n.id}`,
      ...(depth !== undefined ? { depth } : {}),
    };
  }
  private kids(id: string): Node[] {
    return [...this.nodes.values()]
      .filter((n) => n.parentId === id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }
  async getContent(id: string): Promise<ContentSummary> {
    this.calls.push(`content:${id}`);
    const n = this.nodes.get(id);
    if (!n) throw new HttpError(404, id, 'HTTP 404 (not found or no permission)');
    return this.sum(n);
  }
  async getChildren(parent: { id: string }): Promise<ContentSummary[]> {
    this.calls.push(`children:${parent.id}`);
    return this.kids(parent.id).map((n) => this.sum(n));
  }
  async getDescendants(parent: { id: string }, maxDepth?: number): Promise<ContentSummary[]> {
    const out: ContentSummary[] = [];
    const walk = (id: string, d: number) => {
      if (maxDepth !== undefined && d > maxDepth) return;
      for (const k of this.kids(id)) {
        out.push(this.sum(k, d));
        walk(k.id, d + 1);
      }
    };
    walk(parent.id, 1);
    return out;
  }
  async getSpace(key: string): Promise<SpaceSummary> {
    return { key, name: key, homepageId: 'home', id: '99' };
  }
  async getSpaceRoots(space: { key: string }): Promise<ContentSummary[]> {
    this.calls.push(`roots:${space.key}`);
    const roots = [...this.nodes.values()].filter((n) => !n.parentId && (n.space ?? 'ENG') === space.key);
    roots.sort((a, b) => (a.id === 'home' ? -1 : b.id === 'home' ? 1 : (a.position ?? 0) - (b.position ?? 0)));
    return roots.map((n) => this.sum(n));
  }
  async getPageBody(id: string): Promise<PageBody> {
    this.calls.push(`body:${id}`);
    const n = this.nodes.get(id);
    if (!n) throw new HttpError(404, id, 'missing');
    return { id, type: 'page', title: n.title, html: n.html ?? '', breadcrumb: [], url: '' };
  }
  async getStorageBody(id: string): Promise<string> {
    this.calls.push(`storage:${id}`);
    return this.nodes.get(id)?.storage ?? '';
  }
  async findPageByTitle(spaceKey: string, title: string): Promise<ContentSummary | null> {
    const n = [...this.nodes.values()].find((x) => x.title === title && (x.space ?? 'ENG') === spaceKey);
    return n ? this.sum(n) : null;
  }
  async getCurrentUser() {
    return { displayName: 'Tester' };
  }
}

function req(partial: Partial<ExportRequest> & Pick<ExportRequest, 'mode' | 'root'>): ExportRequest {
  return { site, options: { ...DEFAULT_OPTIONS }, ...partial };
}

// home
// ├─ a (pos 2)
// │  ├─ a2 (pos 2)
// │  └─ a1 (pos 1)
// │     └─ a1x (archived)
// │        └─ a1xc
// ├─ f (folder, pos 1)
// │  ├─ wb (whiteboard)
// │  └─ fp
// └─ b (pos 3)
function tree(): FakeClient {
  return new FakeClient([
    { id: 'home', title: 'Home' },
    { id: 'a', title: 'A', parentId: 'home', position: 2 },
    { id: 'a1', title: 'A1', parentId: 'a', position: 1 },
    { id: 'a2', title: 'A2', parentId: 'a', position: 2 },
    { id: 'a1x', title: 'A1 archived', parentId: 'a1', position: 1, status: 'archived' },
    { id: 'a1xc', title: 'A1 archived child', parentId: 'a1x', position: 1 },
    { id: 'f', title: 'Folder', type: 'folder', parentId: 'home', position: 1 },
    { id: 'wb', title: 'Board', type: 'whiteboard', parentId: 'f', position: 1 },
    { id: 'fp', title: 'Folder page', parentId: 'f', position: 2 },
    { id: 'b', title: 'B', parentId: 'home', position: 3 },
    { id: 'orphan', title: 'Orphan root', position: 5 },
  ]);
}

const summary = (pages: { id: string; depth: number }[]) => pages.map((p) => `${p.id}@${p.depth}`);

describe('collect', () => {
  it('current: just the root', async () => {
    const c = tree();
    const r = await collect(c, req({ mode: 'current', root: { id: 'a', type: 'page' } }));
    expect(summary(r.pages)).toEqual(['a@0']);
    expect(r.pages[0]).toMatchObject({ reason: 'root', title: 'A', spaceKey: 'ENG', type: 'page' });
  });

  it('current: propagates a missing root as an error', async () => {
    await expect(collect(tree(), req({ mode: 'current', root: { id: 'nope', type: 'page' } }))).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('subtree: tree order, archived subtree excluded with a warning', async () => {
    const r = await collect(tree(), req({ mode: 'subtree', root: { id: 'a', type: 'page' }, depth: 'all' }));
    expect(summary(r.pages)).toEqual(['a@0', 'a1@1', 'a2@1']);
    expect(r.pages[1]!.reason).toBe('descendant');
    expect(r.warnings.join(' ')).toMatch(/1 archived or draft item was excluded/);
  });

  it('subtree: includeArchived keeps archived content', async () => {
    const request = req({ mode: 'subtree', root: { id: 'a', type: 'page' } });
    request.options.includeArchived = true;
    const r = await collect(tree(), request);
    expect(summary(r.pages)).toEqual(['a@0', 'a1@1', 'a1x@2', 'a1xc@3', 'a2@1']);
    expect(r.warnings).toEqual([]);
  });

  it('subtree: honors depth', async () => {
    const r1 = await collect(tree(), req({ mode: 'subtree', root: { id: 'home', type: 'page' }, depth: 1 }));
    expect(summary(r1.pages)).toEqual(['home@0', 'f@1', 'a@1', 'b@1']);
    const r0 = await collect(tree(), req({ mode: 'subtree', root: { id: 'home', type: 'page' }, depth: 0 }));
    expect(summary(r0.pages)).toEqual(['home@0']);
  });

  it('folder: folder header at depth 0, link-only content kept', async () => {
    const r = await collect(tree(), req({ mode: 'folder', root: { id: 'f', type: 'folder' } }));
    expect(summary(r.pages)).toEqual(['f@0', 'wb@1', 'fp@1']);
    expect(r.pages.map((p) => p.type)).toEqual(['folder', 'whiteboard', 'page']);
  });

  it('space: homepage first, then other roots, each with descendants', async () => {
    const r = await collect(tree(), req({ mode: 'space', root: { id: 'home', type: 'page', spaceKey: 'ENG' } }));
    expect(summary(r.pages)).toEqual(['home@0', 'f@1', 'wb@2', 'fp@2', 'a@1', 'a1@2', 'a2@2', 'b@1', 'orphan@0']);
    expect(r.pages[0]!.reason).toBe('root');
  });

  it('space: resolves the space key from the root when missing', async () => {
    const c = tree();
    const r = await collect(c, req({ mode: 'space', root: { id: 'home', type: 'page' }, depth: 0 }));
    expect(summary(r.pages)).toEqual(['home@0', 'orphan@0']);
    expect(c.calls).toContain('roots:ENG');
  });

  describe('linked', () => {
    function linkedClient() {
      return new FakeClient([
        {
          id: 'r',
          title: 'Root',
          html: `${link('l1')} ${link('l1')} ${link('r')} <a href="/wiki/spaces/ENG/pages/l2">x</a>
                 <a href="https://acme.atlassian.net/wiki/x/phDOEg">tiny</a>
                 <a href="https://acme.atlassian.net/wiki/spaces/ENG/folder/fo">folder</a>
                 <a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/arch">archived</a>`,
        },
        { id: 'l1', title: 'Linked 1', html: `${link('h2')} ${link('r')}` },
        { id: 'l2', title: 'Linked 2', html: '<p>no links</p>', storage: '<ac:link><ri:page ri:content-title="By Title" /></ac:link>' },
        { id: 'h2', title: 'Hop 2', html: link('h3') },
        { id: 'h3', title: 'Hop 3' },
        { id: 'fo', title: 'Some folder', type: 'folder' },
        { id: 'arch', title: 'Old', status: 'archived' },
        { id: 'bt', title: 'By Title' },
      ]);
    }
    // ids in links are numeric in Confluence; the fake uses readable ids, so map them.
    function numeric(c: FakeClient): FakeClient {
      const ids = [...c.nodes.keys()];
      const num = new Map(ids.map((id, i) => [id, String(1000 + i)]));
      const re = new RegExp(`(?<=[/"])(${ids.join('|')})(?=["/<])`, 'g');
      const fix = (s?: string) => s?.replace(re, (m) => num.get(m)!);
      return new FakeClient(
        [...c.nodes.values()].map((n) => ({
          ...n,
          id: num.get(n.id)!,
          parentId: n.parentId ? num.get(n.parentId) : undefined,
          html: fix(n.html),
          storage: fix(n.storage),
          title: n.title,
        })),
      );
    }

    it('depth 1: direct links, deduplicated, folders skipped, archived excluded, unresolved warned', async () => {
      const c = numeric(linkedClient());
      const r = await collect(c, req({ mode: 'linked', root: { id: '1000', type: 'page' }, linkDepth: 1 }));
      expect(r.pages.map((p) => `${p.title}@${p.depth}`)).toEqual(['Root@0', 'Linked 1@1', 'Linked 2@1']);
      expect(r.pages.slice(1).every((p) => p.reason === 'linked')).toBe(true);
      expect(r.warnings.some((w) => w.includes('315494566'))).toBe(true);
      expect(r.warnings.some((w) => /archived/.test(w))).toBe(true);
      // Only the root's links are read at depth 1.
      expect(c.calls.filter((x) => x.startsWith('body:'))).toEqual(['body:1000']);
    });

    it('depth 2: follows links of linked pages, with storage fallback for title links', async () => {
      const c = numeric(linkedClient());
      const r = await collect(c, req({ mode: 'linked', root: { id: '1000', type: 'page' }, linkDepth: 2 }));
      expect(r.pages.map((p) => `${p.title}@${p.depth}`)).toEqual([
        'Root@0',
        'Linked 1@1',
        'Linked 2@1',
        'Hop 2@2',
        'By Title@2',
      ]);
      expect(c.calls).toContain('storage:1002');
      expect(r.pages.some((p) => p.title === 'Hop 3')).toBe(false);
    });
  });

  it('selection: ordered by page tree with nesting depth', async () => {
    const c = tree();
    const r = await collect(
      c,
      req({ mode: 'selection', root: { id: 'home', type: 'page' }, selectedIds: ['b', 'a2', 'fp', 'a', 'missing', 'a1'] }),
    );
    expect(summary(r.pages)).toEqual(['fp@0', 'a@0', 'a1@1', 'a2@1', 'b@0']);
    expect(r.pages.every((p) => p.reason === 'selected')).toBe(true);
    expect(r.warnings.some((w) => w.includes('missing'))).toBe(true);
  });

  it('selection: empty selection gives a warning', async () => {
    const r = await collect(tree(), req({ mode: 'selection', root: { id: 'home', type: 'page' }, selectedIds: [] }));
    expect(r.pages).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it('honors an aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      collect(tree(), req({ mode: 'subtree', root: { id: 'home', type: 'page' } }), { signal: ac.signal }),
    ).rejects.toSatisfy(isAbortError);
  });

  it('reports progress', async () => {
    const msgs: string[] = [];
    await collect(tree(), req({ mode: 'subtree', root: { id: 'a', type: 'page' } }), { onProgress: (m) => msgs.push(m) });
    expect(msgs.length).toBeGreaterThan(0);
  });
});
