import type { ContentType, ExportMode, ExportOptions, ExportRequest, PageContext } from '../../lib/types';

export type DepthChoice = number | 'all';

export const SUBTREE_DEPTHS: { value: DepthChoice; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 5, label: '5' },
];

export const LINK_DEPTHS: { value: 1 | 2; label: string }[] = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];

/** Modes that produce more than one page and therefore go through the preview tab. */
export function isMultiMode(mode: ExportMode): boolean {
  return mode !== 'current';
}

const CONTENT_KINDS: readonly string[] = ['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed'];

/**
 * Modes offered for the detected context, in display order; the first one is the default.
 * Every export needs a root content id (the service worker validates it), so nothing is offered
 * without one.
 */
export function availableModes(ctx: Pick<PageContext, 'kind' | 'id' | 'spaceKey'>): ExportMode[] {
  if (!ctx.id) return [];
  const spaceModes: ExportMode[] = ctx.spaceKey ? ['selection', 'space'] : [];
  switch (ctx.kind) {
    case 'page':
    case 'space': // `id` is the space home page
      return ['current', 'subtree', 'linked', ...spaceModes];
    case 'blogpost':
      // Blog posts have no children.
      return ['current', 'linked', ...spaceModes];
    case 'folder':
      return ['folder', ...spaceModes];
    default:
      // Whiteboards, databases, smart links: only exportable as part of the space.
      return spaceModes;
  }
}

export function modeLabel(mode: ExportMode, kind: PageContext['kind']): string {
  switch (mode) {
    case 'current':
      return kind === 'space' ? 'Space home page' : kind === 'blogpost' ? 'This blog post' : 'This page';
    case 'subtree':
      return kind === 'space' ? 'Home page + children' : 'This page + children';
    case 'linked':
      return 'Pages linked from this page';
    case 'selection':
      return 'Choose pages from tree…';
    case 'folder':
      return 'This folder';
    case 'space':
      return 'Entire space';
  }
}

export interface BuildRequestInput {
  mode: ExportMode;
  depth: DepthChoice;
  linkDepth: 1 | 2;
  options: ExportOptions;
  sourceTabId?: number;
}

/** Turns the probed context and popup choices into an ExportRequest. */
export function buildRequest(ctx: PageContext, input: BuildRequestInput): ExportRequest {
  const { mode } = input;
  const type: ContentType = CONTENT_KINDS.includes(ctx.kind) ? (ctx.kind as ContentType) : 'page';
  const spaceTitle = ctx.kind === 'space' && ctx.title ? ctx.title : ctx.spaceKey;
  // The space export still carries the current content as root (used to resolve the space and as
  // a fallback); its title names the document.
  const root: ExportRequest['root'] = {
    id: ctx.id ?? '',
    type,
    title: mode === 'space' ? spaceTitle : ctx.title,
    spaceKey: ctx.spaceKey,
    spaceId: ctx.spaceId,
  };

  const req: ExportRequest = {
    site: ctx.site,
    mode,
    root,
    options: { ...input.options, marginsMm: { ...input.options.marginsMm } },
    sourceTabId: input.sourceTabId,
    userDisplayName: ctx.userDisplayName,
  };
  if (mode === 'subtree') req.depth = input.depth;
  if (mode === 'folder' || mode === 'space') req.depth = 'all';
  if (mode === 'linked') req.linkDepth = input.linkDepth;
  // The preview pre-checks the page the user started from.
  if (mode === 'selection') req.selectedIds = ctx.id && ctx.kind !== 'space' ? [ctx.id] : [];
  return req;
}

export function isSpaceBlocked(spaceKey: string | undefined, blocked: readonly string[] | undefined): boolean {
  if (!spaceKey || !blocked?.length) return false;
  const k = spaceKey.toUpperCase();
  return blocked.some((b) => b.trim().toUpperCase() === k);
}
