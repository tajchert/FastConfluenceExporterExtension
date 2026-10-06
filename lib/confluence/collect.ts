/**
 * Resolves the ordered, de-duplicated page list for an export request (FR-2 … FR-6).
 *
 *  current   → [root]
 *  subtree   → root + descendants (request.depth)
 *  folder    → folder (depth-0 section header, no body) + its descendants (request.depth)
 *  space     → every space root + its descendants (request.depth below each root)
 *  linked    → root + linked content, BFS by hop (request.linkDepth 1|2)
 *  selection → request.selectedIds in page-tree order
 *
 * Archived/draft content is excluded unless includeArchived (an excluded node hides its subtree).
 * Whiteboards/databases/embeds are kept as link-only refs.
 */
import type { ContentType, ExportRequest, PageRef } from '../types';
import { isAbortError, throwIfAborted } from '../util/abort';
import { mapPool } from '../util/pool';
import { compareSiblings, type ConfluenceClient, type ContentSummary } from './client';
import { extractLinksFromExportView, extractLinksFromStorage, type LinkTargets } from './links';

export interface CollectOptions {
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  includeArchived?: boolean;
}

const CONCURRENCY = 4;
const MAX_ANCESTRY = 50;

function errorMessage(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

function isExportableStatus(status: string | undefined, includeArchived: boolean): boolean {
  if (!status || status === 'current') return true;
  if (status === 'archived' || status === 'draft') return includeArchived;
  return false; // trashed, deleted, historical, ...
}

function hasBody(type: ContentType): boolean {
  return type === 'page' || type === 'blogpost';
}

class Collection {
  readonly pages: PageRef[] = [];
  readonly warnings: string[] = [];
  private readonly ids = new Set<string>();
  excluded = 0;

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(c: ContentSummary, depth: number, reason: PageRef['reason']): boolean {
    if (this.ids.has(c.id)) return false;
    this.ids.add(c.id);
    const ref: PageRef = { id: c.id, type: c.type, title: c.title, depth, url: c.url, reason };
    if (c.spaceKey) ref.spaceKey = c.spaceKey;
    if (c.spaceId) ref.spaceId = c.spaceId;
    if (c.parentId) ref.parentId = c.parentId;
    if (c.position !== undefined) ref.position = c.position;
    if (c.status) ref.status = c.status;
    this.pages.push(ref);
    return true;
  }
}

export async function collect(
  client: ConfluenceClient,
  request: ExportRequest,
  opts: CollectOptions = {},
): Promise<{ pages: PageRef[]; warnings: string[] }> {
  const { signal } = opts;
  const progress = (msg: string) => {
    try {
      opts.onProgress?.(msg);
    } catch {
      /* UI callback errors must not break collection */
    }
  };
  const includeArchived = opts.includeArchived ?? request.options?.includeArchived ?? false;
  const maxDepth =
    typeof request.depth === 'number' && Number.isFinite(request.depth) ? Math.max(0, Math.floor(request.depth)) : undefined;
  const out = new Collection();

  throwIfAborted(signal);

  const resolveRoot = async (): Promise<ContentSummary> => {
    progress('Reading the starting page…');
    const r = request.root;
    const c = await client.getContent(r.id, r.type);
    return { ...c, spaceKey: c.spaceKey ?? r.spaceKey, spaceId: c.spaceId ?? r.spaceId };
  };

  /** Adds tree-ordered descendants, skipping excluded nodes together with their subtrees. */
  const addTree = (items: ContentSummary[], baseDepth: number) => {
    let skipBelow: number | null = null;
    for (const it of items) {
      const d = baseDepth + (it.depth ?? 1);
      if (skipBelow !== null) {
        if (d > skipBelow) continue;
        skipBelow = null;
      }
      if (!isExportableStatus(it.status, includeArchived)) {
        out.excluded++;
        skipBelow = d;
        continue;
      }
      out.add(it, d, 'descendant');
    }
  };

  switch (request.mode) {
    case 'current': {
      out.add(await resolveRoot(), 0, 'root');
      break;
    }

    case 'subtree':
    case 'folder': {
      const root = await resolveRoot();
      out.add(root, 0, 'root');
      if (maxDepth !== 0) {
        throwIfAborted(signal);
        progress(request.mode === 'folder' ? 'Listing folder contents…' : 'Listing child pages…');
        addTree(await client.getDescendants({ id: root.id, type: root.type }, maxDepth), 0);
      }
      break;
    }

    case 'space': {
      let spaceKey = request.root.spaceKey;
      let spaceId = request.root.spaceId;
      if (!spaceKey) {
        const r = await resolveRoot();
        spaceKey = r.spaceKey;
        spaceId = spaceId ?? r.spaceId;
      }
      if (!spaceKey) throw new Error('Could not determine which space to export.');
      progress('Listing space pages…');
      let roots = await client.getSpaceRoots({ key: spaceKey, id: spaceId });
      if (roots.length === 0 && request.root.id) roots = [await resolveRoot()];
      roots = roots.filter((r) => {
        if (isExportableStatus(r.status, includeArchived)) return true;
        out.excluded++;
        return false;
      });
      const trees = await mapPool(
        roots,
        2,
        async (r) => {
          if (maxDepth === 0) return [];
          progress(`Listing pages under “${r.title}”…`);
          return client.getDescendants({ id: r.id, type: r.type }, maxDepth);
        },
        signal,
      );
      roots.forEach((r, i) => {
        out.add(r, 0, i === 0 ? 'root' : 'descendant');
        addTree(trees[i]!, 0);
      });
      break;
    }

    case 'linked': {
      const root = await resolveRoot();
      out.add(root, 0, 'root');
      await collectLinked(client, request, root, out, includeArchived, progress, signal);
      break;
    }

    case 'selection': {
      await collectSelection(client, request, out, progress, signal);
      break;
    }

    default: {
      const mode: never = request.mode;
      throw new Error(`Unsupported export mode: ${String(mode)}`);
    }
  }

  if (out.excluded > 0) {
    out.warnings.push(
      `${out.excluded} archived or draft item${out.excluded === 1 ? ' was' : 's were'} excluded (enable “Include archived” to export them).`,
    );
  }
  throwIfAborted(signal);
  return { pages: out.pages, warnings: out.warnings };
}

// ───────────────────────────── linked pages (FR-5) ─────────────────────────────

const EMPTY_TARGETS: LinkTargets = { ids: [], titles: [], tinyCodes: [] };

function isEmpty(t: LinkTargets): boolean {
  return t.ids.length === 0 && t.titles.length === 0 && t.tinyCodes.length === 0;
}

async function collectLinked(
  client: ConfluenceClient,
  request: ExportRequest,
  root: ContentSummary,
  out: Collection,
  includeArchived: boolean,
  progress: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const site = client.site;
  const hops = request.linkDepth === 2 ? 2 : 1;
  const visited = new Set<string>([root.id]);
  let frontier: ContentSummary[] = hasBody(root.type) ? [root] : [];

  const extract = async (src: ContentSummary): Promise<LinkTargets> => {
    let bodyError: unknown;
    try {
      const body = await client.getPageBody(src.id, src.type);
      const t = extractLinksFromExportView(body.html, site, src.id);
      if (!isEmpty(t)) return t;
    } catch (e) {
      if (isAbortError(e)) throw e;
      bodyError = e;
    }
    // Fallback: storage format (`ri:page` titles, raw hrefs).
    try {
      const storage = await client.getStorageBody(src.id, src.type);
      return extractLinksFromStorage(storage, site, src.id);
    } catch (e) {
      if (isAbortError(e)) throw e;
      out.warnings.push(`Could not read links from “${src.title}”: ${errorMessage(bodyError ?? e)}`);
      return EMPTY_TARGETS;
    }
  };

  const resolve = async (t: LinkTargets, src: ContentSummary): Promise<ContentSummary[]> => {
    const byId = await mapPool(
      t.ids.filter((id) => !visited.has(id)),
      CONCURRENCY,
      async (id) => {
        try {
          return await client.getContent(id);
        } catch (e) {
          if (isAbortError(e)) throw e;
          out.warnings.push(`Linked content ${id} (from “${src.title}”) was skipped: ${errorMessage(e)}`);
          return null;
        }
      },
      signal,
    );
    const byTitle = await mapPool(
      t.titles,
      CONCURRENCY,
      async ({ spaceKey, title }) => {
        const key = spaceKey ?? src.spaceKey;
        if (!key) {
          out.warnings.push(`Linked page “${title}” (from “${src.title}”) could not be resolved: unknown space.`);
          return null;
        }
        try {
          const hit = await client.findPageByTitle(key, title);
          if (!hit) out.warnings.push(`Linked page “${title}” in space ${key} (from “${src.title}”) was not found.`);
          return hit;
        } catch (e) {
          if (isAbortError(e)) throw e;
          out.warnings.push(`Linked page “${title}” (from “${src.title}”) could not be resolved: ${errorMessage(e)}`);
          return null;
        }
      },
      signal,
    );
    for (const code of t.tinyCodes) {
      out.warnings.push(`Short link /x/${code} (from “${src.title}”) could not be resolved.`);
    }
    return [...byId, ...byTitle].filter((c): c is ContentSummary => !!c);
  };

  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    throwIfAborted(signal);
    progress(hop === 1 ? 'Finding linked pages…' : 'Finding pages linked from linked pages…');
    const perSource = await mapPool(frontier, CONCURRENCY, async (src) => resolve(await extract(src), src), signal);
    const next: ContentSummary[] = [];
    for (const found of perSource) {
      for (const c of found) {
        if (visited.has(c.id)) continue;
        visited.add(c.id);
        if (c.type === 'folder') continue; // a folder link has no content of its own
        if (!isExportableStatus(c.status, includeArchived)) {
          out.excluded++;
          continue;
        }
        if (out.add(c, hop, 'linked') && hasBody(c.type)) next.push(c);
      }
    }
    frontier = next;
  }
}

// ───────────────────────────── manual selection (FR-6) ─────────────────────────────

interface TrieNode {
  c: ContentSummary | null; // null = virtual root
  children: string[];
  selected: boolean;
  /** Smallest selection index in this subtree (fallback ordering). */
  firstSel: number;
}

async function collectSelection(
  client: ConfluenceClient,
  request: ExportRequest,
  out: Collection,
  progress: (msg: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const ids = [...new Set((request.selectedIds ?? []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) {
    out.warnings.push('No pages were selected.');
    return;
  }
  progress('Reading selected pages…');
  const items = await mapPool(
    ids,
    CONCURRENCY,
    async (id) => {
      try {
        return await client.getContent(id);
      } catch (e) {
        if (isAbortError(e)) throw e;
        out.warnings.push(`Selected content ${id} was skipped: ${errorMessage(e)}`);
        return null;
      }
    },
    signal,
  );

  // Ancestor chains (root first). Lookups are cached by the client, so shared ancestors are cheap.
  progress('Ordering pages by the page tree…');
  const chains = await mapPool(
    items,
    CONCURRENCY,
    async (c) => {
      if (!c) return null;
      const chain: ContentSummary[] = [c];
      const seen = new Set<string>([c.id]);
      let parentId = c.parentId;
      let parentType = c.parentType;
      while (parentId && !seen.has(parentId) && chain.length < MAX_ANCESTRY) {
        seen.add(parentId);
        try {
          const p = await client.getContent(parentId, parentType);
          chain.unshift(p);
          parentId = p.parentId;
          parentType = p.parentType;
        } catch (e) {
          if (isAbortError(e)) throw e;
          break;
        }
      }
      return chain;
    },
    signal,
  );

  const nodes = new Map<string, TrieNode>();
  const ROOT = '\u0000root';
  nodes.set(ROOT, { c: null, children: [], selected: false, firstSel: Infinity });
  chains.forEach((chain, selIndex) => {
    if (!chain) return;
    let parentKey = ROOT;
    chain.forEach((c, i) => {
      let node = nodes.get(c.id);
      if (!node) {
        node = { c, children: [], selected: false, firstSel: Infinity };
        nodes.set(c.id, node);
        nodes.get(parentKey)!.children.push(c.id);
      }
      node.firstSel = Math.min(node.firstSel, selIndex);
      if (i === chain.length - 1) node.selected = true;
      parentKey = c.id;
    });
  });
  nodes.get(ROOT)!.firstSel = 0;

  // Real sidebar order for every node with more than one branch.
  const branching = [...nodes.entries()].filter(([, n]) => n.children.length > 1);
  await mapPool(
    branching,
    CONCURRENCY,
    async ([, node]) => {
      const order = new Map<string, number>();
      try {
        if (node.c) {
          const kids = await client.getChildren({ id: node.c.id, type: node.c.type });
          kids.forEach((k, i) => order.set(k.id, i));
        } else {
          const spaceKeys = [...new Set(node.children.map((id) => nodes.get(id)!.c!.spaceKey).filter((k): k is string => !!k))];
          if (spaceKeys.length === 1) {
            const roots = await client.getSpaceRoots({ key: spaceKeys[0]! });
            roots.forEach((r, i) => order.set(r.id, i));
          }
        }
      } catch (e) {
        if (isAbortError(e)) throw e;
        /* fall back below */
      }
      node.children.sort((a, b) => {
        const na = nodes.get(a)!;
        const nb = nodes.get(b)!;
        const ia = order.get(a);
        const ib = order.get(b);
        if (ia !== undefined && ib !== undefined) return ia - ib;
        if (ia !== undefined) return -1;
        if (ib !== undefined) return 1;
        if (na.c && nb.c && na.c.position !== undefined && nb.c.position !== undefined && na.c.spaceKey === nb.c.spaceKey) {
          return compareSiblings(na.c, nb.c);
        }
        return na.firstSel - nb.firstSel;
      });
    },
    signal,
  );

  const walk = (key: string, selectedAbove: number) => {
    const node = nodes.get(key)!;
    let depth = selectedAbove;
    if (node.selected && node.c) {
      out.add(node.c, selectedAbove, 'selected');
      depth = selectedAbove + 1;
    }
    for (const child of node.children) walk(child, depth);
  };
  walk(ROOT, 0);
}
