/**
 * Overall progress of an export across its phases (badge, progress bar, tab title). Pure: shared
 * by the service worker and the extension pages.
 */
import type { ExportJobState } from '../types';

/**
 * 0..100. Each phase covers a fixed range so the bar never jumps back when the next phase
 * starts counting from 0 (fetching 5–60 %, rendering 60–90 %, merging/saving 90–99 %).
 */
export function jobPercent(job: Pick<ExportJobState, 'status' | 'progress'>): number {
  const { done, total } = job.progress;
  const frac = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  switch (job.status) {
    case 'collecting':
      return 2;
    case 'fetching':
      return Math.round(5 + 55 * frac);
    case 'rendering':
      return Math.round(60 + 30 * frac);
    case 'merging':
      return Math.round(90 + 9 * frac);
    default:
      return 100;
  }
}
