/**
 * Small pure helpers shared by the Markdown and plain-text writers.
 */
import type { PageBody } from '../confluence/client';
import type { ContentType, PageRef } from '../types';
import { tocLevels } from '../assemble/document';

export const LINK_ONLY_TYPES = new Set<ContentType>(['folder', 'whiteboard', 'database', 'embed', 'slides']);

export const TYPE_LABELS: Record<ContentType, string> = {
  page: 'Page',
  blogpost: 'Blog post',
  folder: 'Folder',
  whiteboard: 'Whiteboard',
  database: 'Database',
  embed: 'Smart link',
  slides: 'Slides',
};

export function safeHttpUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).host : undefined;
  } catch {
    return undefined;
  }
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** `2026-09-30` (UTC) — deterministic, locale-independent. */
export function isoDay(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** `2026-09-30 10:00 UTC` */
export function isoMinute(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Percent-encodes the characters that would break a Markdown link destination or an HTML
 * attribute (space, parentheses, angle brackets, quotes, `%`, `#`, `?`, `&`, `|`, brackets).
 * Unicode letters are kept readable. `/` is kept (path separator).
 */
export function encodeRelPath(path: string): string {
  return path.replace(/[\s%()<>"'#?&|[\]\\^`{}]/g, (c) =>
    Array.from(new TextEncoder().encode(c))
      .map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
      .join(''),
  );
}

/** A URL made safe as a Markdown inline link destination. */
export function mdUrl(url: string): string {
  return url.replace(/[\s()<>|]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** In-document fragment, encoded like a link destination. */
export function encodeFragment(id: string): string {
  return encodeRelPath(id);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A YAML double-quoted scalar (JSON strings are valid YAML). */
export function yamlString(s: string): string {
  return JSON.stringify(s);
}

// ───────────────────────────── display width (plain-text tables, underlines) ─────────────────

const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function graphemes(s: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  for (const [a, b] of WIDE_RANGES) {
    if (cp < a) return false;
    if (cp <= b) return true;
  }
  return false;
}

function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (/^[\p{M}\u200b-\u200f\u2060\ufeff]+$/u.test(g)) return 0;
  // Emoji presentation sequences (e.g. ❤\ufe0f) are drawn double width.
  if (g.includes('\ufe0f') && /\p{Extended_Pictographic}/u.test(g)) return 2;
  return isWide(cp) ? 2 : 1;
}

/** Columns a string occupies in a monospace terminal / editor (CJK and emoji count 2). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const g of graphemes(s)) w += graphemeWidth(g);
  return w;
}

export function padEnd(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

// ───────────────────────────── pages, TOC, meta ─────────────────────────────────────────────

export interface TocEntry {
  ref: PageRef;
  level: number;
}

/**
 * TOC entries in tree order with their nesting level — the same rules as the PDF TOC
 * (lib/assemble/document.ts buildToc): excluded pages are left out and their children take
 * their place; never nest more than one level below the previous entry.
 */
export function tocEntries(allPages: PageRef[], fallback: PageRef[], excluded: Set<string>): TocEntry[] {
  const inDocument = allPages.filter((p) => !excluded.has(p.id));
  const source = inDocument.length > 0 ? allPages : fallback;
  const included = inDocument.length > 0 ? (id: string) => !excluded.has(id) : () => true;
  const levels = tocLevels(source, included);
  const seen = new Set<string>();
  const out: TocEntry[] = [];
  let prev = -1;
  for (const ref of source) {
    if (!levels.has(ref.id) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    const level = Math.min(levels.get(ref.id)!, prev + 1);
    out.push({ ref, level });
    prev = level;
  }
  return out;
}

export interface PageMeta {
  breadcrumb: string[];
  updated?: string;
  updatedIso?: string;
  author?: string;
  version?: number;
  url?: string;
}

export function pageMeta(ref: PageRef, body: PageBody | undefined): PageMeta {
  const breadcrumb = (body?.breadcrumb?.length ? body.breadcrumb : ref.breadcrumb ?? []).filter((c) => c && c.trim());
  return {
    breadcrumb,
    updated: isoDay(body?.lastModified),
    updatedIso: body?.lastModified,
    author: body?.authorDisplayName || undefined,
    version: body?.version,
    url: safeHttpUrl(body?.url || ref.url),
  };
}

export function pageTitle(ref: PageRef, body?: PageBody): string {
  return (body?.title || ref.title || 'Untitled').replace(/\s+/g, ' ').trim() || 'Untitled';
}
