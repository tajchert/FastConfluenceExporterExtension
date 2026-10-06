import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { callSw } from '../lib/rpc';
import type { ExportJobState, JobError } from '../lib/types';
import { Button } from './Button';
import { errorMessage, openJobTab, showDownload } from './hooks';
import { Icon } from './Icon';
import { formatBytes, isJobActive, jobFraction, plural, progressCount, statusLabel, summarizeProblems } from './logic';
import { Notice } from './Notice';
import { ProgressBar } from './ProgressBar';

export interface JobProgressProps {
  job: ExportJobState;
  /** Popup layout: no error table, link to the full view instead. */
  compact?: boolean;
  /** Shown on finished jobs (preview tab). */
  onExportAgain?: () => void;
  /** An interrupted export was started again with its stored page list (new job id). */
  onRetried?: (jobId: string) => void;
}

const PHASE: Record<string, string> = {
  collecting: 'Collecting pages',
  fetching: 'Fetching pages',
  rendering: 'Rendering the PDF',
  merging: 'Building the file',
};

/**
 * What the screen-reader live region says: only phase changes and the outcome, not the counter
 * and page titles that change several times a second.
 */
function announcement(job: ExportJobState): string {
  if (isJobActive(job.status)) return `${PHASE[job.status] ?? 'Exporting'}…`;
  if (job.status === 'done') return job.result ? 'Export complete. The file was saved to your downloads.' : 'Export complete.';
  if (job.status === 'cancelled') return 'Export cancelled.';
  return `Export failed. ${job.message ?? ''}`.trim();
}

/** Progress / result view for an export job (FR-12). */
export function JobProgress({ job, compact = false, onExportAgain, onRetried }: JobProgressProps): JSX.Element {
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = isJobActive(job.status);
  const fraction = jobFraction(job);
  const count = progressCount(job);
  const { current } = job.progress;
  const problems = summarizeProblems(job.errors);

  const retry = async () => {
    setRetrying(true);
    setActionError(null);
    try {
      const { jobId } = await callSw({ type: 'job/retry', jobId: job.id });
      onRetried?.(jobId);
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setRetrying(false);
    }
  };

  const cancel = async () => {
    setCancelling(true);
    setActionError(null);
    try {
      await callSw({ type: 'job/cancel', jobId: job.id });
    } catch (e) {
      setActionError(errorMessage(e));
      setCancelling(false);
    }
  };

  const reveal = async () => {
    setActionError(null);
    const ok = await showDownload(job.result?.downloadId);
    if (!ok) setActionError('The file is no longer in your downloads list. Check your Downloads folder.');
  };

  return (
    <div class={`job${compact ? ' job-compact' : ''}`}>
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement(job)}
      </div>
      {active ? (
        <>
          <div class="job-head">
            <span class="job-status">{statusLabel(job)}</span>
            {count ? <span class="job-count">{count}</span> : null}
          </div>
          <ProgressBar value={fraction} label="Export progress" />
          {current ? (
            <div class="job-current" title={current}>
              {current}
            </div>
          ) : null}
          {job.throttled ? (
            <Notice tone="warn" compact>
              Throttled by Confluence, retrying…
            </Notice>
          ) : null}
          <div class="job-actions">
            <Button variant="secondary" size={compact ? 'sm' : 'md'} icon="x" loading={cancelling} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : null}

      {job.status === 'done' && job.result ? (
        <>
          <Notice tone="success" title="Export complete">
            <span class="filename">Saved {job.result.filename}</span>
            <span class="muted">
              {' '}
              · {formatBytes(job.result.bytes)}
              {job.result.pageCount ? ` · ${plural(job.result.pageCount, 'page')}` : ''}
              {job.result.sheetCount ? ` · ${plural(job.result.sheetCount, 'PDF sheet')}` : ''}
            </span>
          </Notice>
          <div class="job-actions">
            {job.result.downloadId !== undefined ? (
              <Button variant="primary" size={compact ? 'sm' : 'md'} icon="folderOpen" onClick={reveal}>
                Show in folder
              </Button>
            ) : null}
            {onExportAgain ? (
              <Button variant="secondary" size={compact ? 'sm' : 'md'} icon="download" onClick={onExportAgain}>
                Export again
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {job.status === 'done' && !job.result ? <Notice tone="success" title="Export complete" /> : null}

      {job.status === 'cancelled' ? (
        <>
          <Notice tone="info" title="Export cancelled" icon="x">
            Nothing was saved.
          </Notice>
          {onExportAgain ? (
            <div class="job-actions">
              <Button variant="secondary" onClick={onExportAgain}>
                Start over
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {job.status === 'error' ? (
        <>
          <Notice tone="error" title="Export failed">
            {job.message || 'Something went wrong while exporting.'}
          </Notice>
          {job.interrupted && onRetried ? (
            <div class="job-actions">
              <Button variant="secondary" loading={retrying} onClick={() => void retry()}>
                Try again
              </Button>
            </div>
          ) : onExportAgain ? (
            <div class="job-actions">
              <Button variant="secondary" onClick={onExportAgain}>
                Try again
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {actionError ? <Notice tone="error" compact>{actionError}</Notice> : null}

      {problems.rows.length > 0 || problems.imageNote ? (
        compact ? (
          <button type="button" class="link-btn job-errors-link" onClick={() => void openJobTab(job.id)}>
            <Icon name="alert" size={14} />{' '}
            {problems.pageCount ? `${plural(problems.pageCount, 'page')} with problems` : 'Some images were replaced'} — details
          </button>
        ) : (
          <ErrorTable errors={problems.rows} imageNote={problems.imageNote} />
        )
      ) : null}
    </div>
  );
}

const SEVERITY_LABEL: Record<JobError['severity'], string> = {
  skipped: 'Skipped',
  degraded: 'Partial',
  fatal: 'Failed',
};

/** Problems of individual pages (fatal errors are in the error notice instead). */
export function ErrorTable({ errors, imageNote }: { errors: readonly JobError[]; imageNote?: string | null }): JSX.Element {
  const pages = new Set(errors.map((e) => e.pageId)).size;
  return (
    <section class="error-summary" aria-labelledby="error-summary-title">
      <h3 id="error-summary-title" class="section-title">
        {pages ? `${plural(pages, 'page')} with problems` : 'Problems'}
      </h3>
      {imageNote ? <p class="hint">{imageNote}</p> : null}
      {errors.length ? (
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Page</th>
              <th scope="col">Result</th>
              <th scope="col">Reason</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e, i) => (
              <tr key={`${e.pageId}-${i}`}>
                <td class="cell-title">{e.title || e.pageId}</td>
                <td>
                  <span class={`badge badge-${e.severity}`}>{SEVERITY_LABEL[e.severity]}</span>
                </td>
                <td class="cell-reason">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      ) : null}
    </section>
  );
}
