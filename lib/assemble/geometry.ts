/**
 * Sheet geometry shared by the print document (worker tab, @page rule) and the service worker
 * (Page.printToPDF parameters, live render), so both always agree. Pure: no DOM access.
 */
import type { ExportOptions, Orientation, PaperSize } from '../types';

const PAPER_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
  A3: { w: 297, h: 420 },
};

/** Minimum bottom margin that leaves room for Chrome's page-number footer template. */
export const FOOTER_MIN_MARGIN_MM = 12;

/** Sheet size in millimetres, orientation applied. */
export function paperSizeMm(paper: PaperSize, orientation: Orientation): { width: number; height: number } {
  const p = PAPER_MM[paper] ?? PAPER_MM.A4;
  return orientation === 'landscape' ? { width: p.h, height: p.w } : { width: p.w, height: p.h };
}

function clampMargin(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(60, Math.max(0, n));
}

/**
 * Margins actually used for printing: sanitized, and with the bottom margin raised to
 * FOOTER_MIN_MARGIN_MM when page numbers are on. `toPrintParams()` should use the same values.
 */
export function effectiveMarginsMm(options: ExportOptions): { top: number; right: number; bottom: number; left: number } {
  const m = options.marginsMm ?? { top: 18, right: 15, bottom: 18, left: 15 };
  const out = {
    top: clampMargin(m.top, 18),
    right: clampMargin(m.right, 15),
    bottom: clampMargin(m.bottom, 18),
    left: clampMargin(m.left, 15),
  };
  if (options.pageNumbers && out.bottom < FOOTER_MIN_MARGIN_MM) out.bottom = FOOTER_MIN_MARGIN_MM;
  return out;
}

