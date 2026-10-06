/**
 * Pure, DOM-free helpers shared by the popup, preview and options pages.
 * Kept free of chrome.* and Preact so they can be unit tested in isolation.
 */
import { jobPercent } from '../lib/job/progress';
import type {
  ContentType,
  ExportJobState,
  ExportOptions,
  JobError,
  JobStatus,
  PageRef,
  TreeNode,
} from '../lib/types';

export { jobPercent };

// ───────────────────────────── margins ─────────────────────────────

export type Margins = ExportOptions['marginsMm'];
export type MarginPreset = 'normal' | 'narrow' | 'wide' | 'custom';

export const MARGIN_PRESETS: Record<Exclude<MarginPreset, 'custom'>, { label: string; margins: Margins }> = {
  normal: { label: 'Normal', margins: { top: 18, right: 15, bottom: 18, left: 15 } },
  narrow: { label: 'Narrow', margins: { top: 10, right: 10, bottom: 10, left: 10 } },
  wide: { label: 'Wide', margins: { top: 25, right: 25, bottom: 25, left: 25 } },
};

export function marginPresetOf(m: Margins): MarginPreset {
  for (const key of Object.keys(MARGIN_PRESETS) as (keyof typeof MARGIN_PRESETS)[]) {
    const p = MARGIN_PRESETS[key].margins;
    if (p.top === m.top && p.right === m.right && p.bottom === m.bottom && p.left === m.left) return key;
  }
  return 'custom';
}

export function formatMargins(m: Margins): string {
  return `${m.top} / ${m.right} / ${m.bottom} / ${m.left} mm`;
}

// ───────────────────────────── input parsing ─────────────────────────────

/** Accepts `acme.atlassian.net`, `https://wiki.acme.corp/confluence/display/X` … → origin. */
export function parseSiteInput(input: string): { origin: string } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: 'Enter the address of your Confluence site.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'That does not look like a valid web address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'Only http:// and https:// sites are supported.' };
  }
  if (raw.includes('*') || url.hostname.includes('*')) {
    return { error: 'Wildcards are not allowed; add each site separately.' };
  }
  if (!url.hostname || /\s/.test(url.hostname)) return { error: 'That does not look like a valid host name.' };
  return { origin: url.origin };
}

/** Splits a comma / newline separated list, trims, lower-cases and de-duplicates. */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[\n,;]+/)) {
    const v = part.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ───────────────────────────── URLs & status ─────────────────────────────

/** Pages Chrome never lets extensions script (or that are certainly not Confluence). */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted|data|blob|javascript):/i.test(url)) {
    return true;
  }
  try {
    const u = new URL(url);
    if (u.hostname === 'chromewebstore.google.com') return true;
    if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
    if (u.hostname === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) return true;
  } catch {
    return true;
  }
  return false;
}

const ACTIVE: JobStatus[] = ['collecting', 'fetching', 'rendering', 'merging'];
export function isJobActive(status: JobStatus): boolean {
  return ACTIVE.includes(status);
}

export function statusLabel(job: Pick<ExportJobState, 'status' | 'message'>): string {
  if (job.message) return job.message;
  switch (job.status) {
    case 'collecting':
      return 'Collecting pages…';
    case 'fetching':
      return 'Fetching pages…';
    case 'rendering':
      return 'Rendering PDF…';
    case 'merging':
      return 'Finishing PDF…';
    case 'done':
      return 'Export complete';
    case 'cancelled':
      return 'Export cancelled';
    case 'error':
      return 'Export failed';
  }
}

/**
 * Overall progress 0..1 across all phases (never jumps back when a phase starts counting from 0),
 * or null while collecting (indeterminate).
 */
export function jobFraction(job: Pick<ExportJobState, 'status' | 'progress'>): number | null {
  if (job.status === 'done') return 1;
  if (job.status === 'collecting') return null;
  return jobPercent(job) / 100;
}

/** "Page 3 of 25" while pages are being counted; null for other work (print batches, saving). */
export function progressCount(job: Pick<ExportJobState, 'status' | 'progress'>): string | null {
  const { done, total, unit } = job.progress;
  if (!total || total <= 0) return null;
  const pages = unit ? unit === 'page' : job.status === 'fetching';
  if (!pages) return null;
  return `Page ${Math.min(done, total).toLocaleString()} of ${total.toLocaleString()}`;
}

/** Number of pages of a job (snapshots carry `pageCount` instead of the page list). */
export function jobPageCount(job: Pick<ExportJobState, 'pages' | 'pageCount'>): number {
  return job.pageCount ?? job.pages.length;
}

/**
 * Error summary rows: problems of individual pages (skipped / partial). Fatal errors are shown in
 * the error notice instead, and image failures as one line of their own.
 */
export function summarizeProblems(errors: readonly JobError[]): {
  rows: JobError[];
  pageCount: number;
  imageNote: string | null;
} {
  const rows = errors.filter((e) => e.severity !== 'fatal' && e.pageId);
  const imageNote = errors.find((e) => e.severity !== 'fatal' && !e.pageId)?.message ?? null;
  return { rows, pageCount: new Set(rows.map((e) => e.pageId)).size, imageNote };
}

// ───────────────────────────── formatting ─────────────────────────────

export function formatDate(iso: string | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export const TYPE_LABEL: Record<ContentType, string> = {
  page: 'Page',
  blogpost: 'Blog post',
  folder: 'Folder',
  whiteboard: 'Whiteboard',
  database: 'Database',
  embed: 'Smart link',
};

/** Types exported as a TOC entry with a link only (no content body). */
export function isLinkOnlyType(t: ContentType): boolean {
  return t === 'whiteboard' || t === 'database' || t === 'embed';
}

// ───────────────────────────── FR-16 large export guard ─────────────────────────────

export type GuardLevel = 'none' | 'empty' | 'warn' | 'confirm' | 'blocked';

/** Rows that count as pages for the FR-16 guard: folders are only section headers. */
export function exportableCount(pages: readonly Pick<PageRef, 'type'>[]): number {
  return pages.filter((p) => p.type !== 'folder').length;
}

export function largeExportGuard(
  count: number,
  limits: { warn: number; confirm: number; max?: number },
  /** Folders selected but no page: explain why there is nothing to export. */
  onlyFolders = false,
): { level: GuardLevel; message: string } {
  if (count <= 0) {
    return {
      level: 'empty',
      message: onlyFolders
        ? 'Only folders are selected, and they have no pages to export.'
        : 'Select at least one page to export.',
    };
  }
  if (limits.max !== undefined && limits.max > 0 && count > limits.max) {
    return {
      level: 'blocked',
      message: `Your administrator limits exports to ${limits.max.toLocaleString()} pages. Deselect ${(count - limits.max).toLocaleString()} or more pages to continue.`,
    };
  }
  if (count > limits.confirm) {
    return {
      level: 'confirm',
      message: `This is a very large export (${count.toLocaleString()} pages). It can take a long time and use a lot of memory. Consider "Separate PDFs (ZIP)" or a smaller selection.`,
    };
  }
  if (count > limits.warn) {
    return {
      level: 'warn',
      message: `Large export: ${count.toLocaleString()} pages. This may take several minutes; keep this tab open.`,
    };
  }
  return { level: 'none', message: '' };
}

// ───────────────────────────── page list helpers ─────────────────────────────

/**
 * For a list in DFS pre-order (tree order), returns the index just past the last descendant of
 * `pages[index]` (descendants are the contiguous following rows with a greater depth).
 */
export function branchEnd(pages: readonly Pick<PageRef, 'depth'>[], index: number): number {
  const base = pages[index]?.depth ?? 0;
  let i = index + 1;
  while (i < pages.length && pages[i].depth > base) i++;
  return i;
}

export function filterPages<T extends Pick<PageRef, 'title' | 'breadcrumb'>>(pages: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return pages.slice();
  return pages.filter(
    (p) => p.title.toLowerCase().includes(needle) || (p.breadcrumb ?? []).some((b) => b.toLowerCase().includes(needle)),
  );
}

// ───────────────────────────── tree selection model (FR-6) ─────────────────────────────

export interface TreeEntry {
  node: TreeNode;
  parentId: string | null;
  /** null = not loaded yet */
  childIds: string[] | null;
}

export interface TreeModel {
  nodes: Record<string, TreeEntry>;
  /** null = roots not loaded yet */
  rootIds: string[] | null;
  checked: Set<string>;
}

export type CheckState = 'checked' | 'unchecked' | 'indeterminate';

export function emptyTree(): TreeModel {
  return { nodes: {}, rootIds: null, checked: new Set() };
}

/**
 * Inserts loaded children (or roots when parentId is null). Children of a checked parent are
 * checked too; ids in `preselect` are checked. Nodes already present elsewhere are skipped so the
 * tree stays a tree even if the API returns the same item twice.
 */
export function addChildren(
  model: TreeModel,
  parentId: string | null,
  children: readonly TreeNode[],
  preselect?: ReadonlySet<string>,
): TreeModel {
  const nodes = { ...model.nodes };
  const checked = new Set(model.checked);
  const inherit = parentId !== null && checked.has(parentId);
  const ids: string[] = [];
  for (const node of children) {
    if (nodes[node.id] || ids.includes(node.id)) continue;
    nodes[node.id] = { node, parentId, childIds: node.hasChildren ? null : [] };
    ids.push(node.id);
    if (inherit || preselect?.has(node.id)) checked.add(node.id);
  }
  if (parentId === null) return { nodes, rootIds: ids, checked };
  const parent = nodes[parentId];
  if (parent) nodes[parentId] = { ...parent, childIds: ids };
  return { nodes, rootIds: model.rootIds, checked };
}

function forEachLoaded(model: TreeModel, id: string, fn: (id: string) => void): void {
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    fn(cur);
    const kids = model.nodes[cur]?.childIds;
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
}

/** Checks / unchecks a node together with all of its loaded descendants. */
export function setChecked(model: TreeModel, id: string, value: boolean): TreeModel {
  const checked = new Set(model.checked);
  forEachLoaded(model, id, (n) => (value ? checked.add(n) : checked.delete(n)));
  return { ...model, checked };
}

/** Click behaviour for a tri-state box: unchecked/indeterminate → check all, checked → uncheck all. */
export function toggleNode(model: TreeModel, id: string, states: Map<string, CheckState>): TreeModel {
  return setChecked(model, id, states.get(id) !== 'checked');
}

/** Tri-state for every loaded node, computed bottom-up in one pass. */
export function computeCheckStates(model: TreeModel): Map<string, CheckState> {
  const out = new Map<string, CheckState>();
  const visit = (id: string): CheckState => {
    const entry = model.nodes[id];
    const self = model.checked.has(id);
    const kids = entry?.childIds ?? [];
    let all = self;
    let any = self;
    for (const k of kids) {
      const s = visit(k);
      if (s !== 'checked') all = false;
      if (s !== 'unchecked') any = true;
    }
    const state: CheckState = all ? 'checked' : any ? 'indeterminate' : 'unchecked';
    out.set(id, state);
    return state;
  };
  for (const r of model.rootIds ?? []) visit(r);
  return out;
}

/** Checked ids in tree (DFS pre-order) order. */
export function selectedInTreeOrder(model: TreeModel): string[] {
  const out: string[] = [];
  for (const r of model.rootIds ?? []) forEachLoaded(model, r, (id) => model.checked.has(id) && out.push(id));
  return out;
}

export function selectAllLoaded(model: TreeModel): TreeModel {
  return { ...model, checked: new Set(Object.keys(model.nodes)) };
}

export function clearChecked(model: TreeModel): TreeModel {
  return { ...model, checked: new Set() };
}

/** Visible rows (roots + children of expanded nodes) in display order, with their level (1-based). */
export function visibleRows(model: TreeModel, expanded: ReadonlySet<string>): { id: string; level: number }[] {
  const out: { id: string; level: number }[] = [];
  const walk = (ids: readonly string[], level: number) => {
    for (const id of ids) {
      out.push({ id, level });
      const kids = model.nodes[id]?.childIds;
      if (expanded.has(id) && kids && kids.length) walk(kids, level + 1);
    }
  };
  walk(model.rootIds ?? [], 1);
  return out;
}
