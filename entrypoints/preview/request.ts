import type { ExportMode, ExportOptions, ExportRequest, ManagedPolicy } from '../../lib/types';
import { DEFAULT_OPTIONS } from '../../lib/types';

const MODES: readonly ExportMode[] = ['current', 'subtree', 'folder', 'linked', 'selection', 'space'];

/** Structural validation of a request decoded from the URL (it may have been edited by hand). */
export function validateRequest(x: unknown): ExportRequest | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Partial<ExportRequest>;
  const site = r.site;
  if (!site || typeof site.origin !== 'string' || typeof site.baseUrl !== 'string') return null;
  try {
    const u = new URL(site.origin);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== site.origin) return null;
    if (new URL(site.baseUrl).origin !== site.origin) return null;
  } catch {
    return null;
  }
  if (site.flavour !== 'cloud' && site.flavour !== 'server') return null;
  if (typeof site.contextPath !== 'string') return null;
  if (!r.mode || !MODES.includes(r.mode)) return null;
  if (!r.root || typeof r.root.id !== 'string' || typeof r.root.type !== 'string') return null;
  if (!r.root.id) return null;
  if ((r.mode === 'space' || r.mode === 'selection') && !r.root.spaceKey) return null;
  if (r.selectedIds !== undefined && (!Array.isArray(r.selectedIds) || r.selectedIds.some((s) => typeof s !== 'string'))) {
    return null;
  }
  const options: ExportOptions = {
    ...DEFAULT_OPTIONS,
    ...(r.options && typeof r.options === 'object' ? r.options : {}),
  };
  options.marginsMm = { ...DEFAULT_OPTIONS.marginsMm, ...(r.options?.marginsMm ?? {}) };
  return { ...(r as ExportRequest), options };
}

/**
 * Per-export policy enforcement. `defaultOptions` only seeds the defaults (the options page locks
 * them there); what is enforced for every export is `disableLiveRender`.
 */
export function applyPolicy(
  options: ExportOptions,
  policy: ManagedPolicy,
): { options: ExportOptions; locked: Set<keyof ExportOptions> } {
  const locked = new Set<keyof ExportOptions>();
  const out = { ...options, marginsMm: { ...options.marginsMm } };
  if (policy.disableLiveRender) {
    out.liveRender = false;
    locked.add('liveRender');
  }
  return { options: out, locked };
}

export function describeRequest(r: ExportRequest): string {
  const title = r.root.title ? `“${r.root.title}”` : 'this page';
  switch (r.mode) {
    case 'current':
      return title;
    case 'subtree':
      return `${title} and its sub-pages${r.depth && r.depth !== 'all' ? ` (${r.depth} level${r.depth === 1 ? '' : 's'} deep)` : ''}`;
    case 'folder':
      return `Everything in folder ${title}`;
    case 'linked':
      return `${title} and the pages it links to${r.linkDepth === 2 ? ' (2 hops)' : ''}`;
    case 'space':
      return `Entire space ${r.root.spaceKey ?? ''}`.trim();
    case 'selection':
      return `Pages chosen from space ${r.root.spaceKey ?? ''}`.trim();
  }
}
