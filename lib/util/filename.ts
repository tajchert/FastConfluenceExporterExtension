/**
 * Download filename helpers (FR-14): `{spaceKey}_{title}_{YYYY-MM-DD}.{ext}` (pdf, md, txt or zip).
 *
 * The result must be accepted by chrome.downloads on every desktop OS, so we strip everything
 * Windows rejects (reserved characters, reserved device names, trailing dots/spaces), control and
 * bidi-override characters, and leading dots (hidden files). Unicode letters are kept.
 */

const MAX_FILENAME_LENGTH = 150;
const DEFAULT_PART_LENGTH = 100;
const FALLBACK_TITLE = 'Confluence export';

/** CON, PRN, AUX, NUL, COM0-9, LPT0-9 (also with superscript digits), case-insensitive. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and bidi formatting characters (can disguise extensions, e.g. "evil‮fdp.exe"). */
const INVISIBLE_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** Path separators and drive colon become a dash so "Q1/Q2 plan" stays readable. */
const SEPARATOR_CHARS = /[/\\:|]/g;
/** Other characters Windows rejects in filenames. */
const RESERVED_CHARS = /[<>"?*]/g;

function truncateCodePoints(s: string, maxLen: number): string {
  const chars = Array.from(s);
  return chars.length <= maxLen ? s : chars.slice(0, maxLen).join('');
}

function trimEdges(s: string): string {
  // No leading dots (hidden files / "..") and no trailing dots or spaces (Windows strips them).
  return s.replace(/^[\s._-]+/u, '').replace(/[\s._-]+$/u, '');
}

/**
 * Make an arbitrary string safe to use as (part of) a filename. Returns '' when nothing usable
 * is left. `maxLen` counts Unicode code points (surrogate pairs are never split).
 */
export function sanitizeFilenamePart(s: string, maxLen: number = DEFAULT_PART_LENGTH): string {
  if (!s) return '';
  let out = String(s).normalize('NFC');
  out = out.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '');
  out = out.replace(SEPARATOR_CHARS, '-').replace(RESERVED_CHARS, '');
  // Collapse runs of whitespace (incl. NBSP and other Unicode spaces) and of underscores/dashes.
  out = out.replace(/\s+/gu, ' ').replace(/_+/g, '_').replace(/-{2,}/g, '-');
  out = out.replace(/ ?_ ?/g, '_');
  out = trimEdges(out);
  if (maxLen > 0) out = trimEdges(truncateCodePoints(out, maxLen));
  // A part that is (or starts with, before an extension dot) a reserved device name is renamed.
  // The `_` goes after the stem so an extension stays last: `CON.png` → `CON_.png`.
  const dot = out.indexOf('.');
  const stem = dot < 0 ? out : out.slice(0, dot);
  if (WINDOWS_RESERVED_NAME.test(stem)) out = `${stem}_${out.slice(stem.length)}`;
  return out;
}

/** Extensions of downloaded exports: one PDF / Markdown / text document, or a ZIP bundle. */
export type FilenameExt = 'pdf' | 'zip' | 'md' | 'txt';

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `{spaceKey}_{title}_{YYYY-MM-DD}.{ext}`, at most 150 characters, local date. */
export function buildFilename(p: {
  spaceKey?: string;
  title: string;
  date?: Date;
  ext: FilenameExt;
}): string {
  const date = isoDate(p.date && !Number.isNaN(p.date.getTime()) ? p.date : new Date());
  const key = sanitizeFilenamePart(p.spaceKey ?? '', 32);
  const suffix = `_${date}.${p.ext}`;
  const prefix = key ? `${key}_` : '';
  const room = Math.max(10, MAX_FILENAME_LENGTH - prefix.length - suffix.length);
  const title = sanitizeFilenamePart(p.title, room) || FALLBACK_TITLE;
  return `${prefix}${title}${suffix}`.replace(/_+/g, '_');
}
