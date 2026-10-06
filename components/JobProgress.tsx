import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { callSw } from '../lib/rpc';
import type { ExportJobState, JobError } from '../lib/types';
import { Button } from './Button';
import { errorMessage, openJobTab, showDownload } from './hooks';
import { Icon } from './Icon';
import { formatBytes, isJobActive, jobFraction, plural, statusLabel } from './logic';
import { Notice } from './Notice';
import { ProgressBar } from './ProgressBar';

export interface JobProgressProps {
  job: ExportJobState;
  /** Popup layout: no error table, link to the full view instead. */
  compact?: boolean;
  /** Shown on finished jobs (preview tab). */
  onExportAgain?: () => void;
}

/** Progress / result view for an export job (FR-12). */
export function JobProgress({ job, compact = false, onExportAgain }: JobProgressProps): JSX.Element {
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const active = isJobActive(job.status);
  const fraction = jobFraction(job);
  const { done, total, current } = job.progress;

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
    <div class={`job${compact ? ' job-compact' : ''}`} aria-live="polite">
      {active ? (
        <>
          <div class="job-head">
            <span class="job-status">{statusLabel(job)}</span>
            {total > 0 ? (
              <span class="job-count">
                {job.status === 'fetching' || job.status === 'rendering' ? 'Page ' : ''}
                {Math.min(done, total).toLocaleString()} of {total.toLocaleString()}
              </span>
            ) : null}
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
          {onExportAgain ? (
            <div class="job-actions">
              <Button variant="secondary" onClick={onExportAgain}>
                Try again
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {actionError ? <Notice tone="error" compact>{actionError}</Notice> : null}

      {job.errors.length > 0 ? (
        compact ? (
          <button type="button" class="link-btn job-errors-link" onClick={() => void openJobTab(job.id)}>
            <Icon name="alert" size={14} /> {plural(job.errors.length, 'page')} with problems — details
          </button>
        ) : (
          <ErrorTable errors={job.errors} />
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

export function ErrorTable({ errors }: { errors: readonly JobError[] }): JSX.Element {
  return (
    <section class="error-summary" aria-labelledby="error-summary-title">
      <h3 id="error-summary-title" class="section-title">
        {plural(errors.length, 'page')} with problems
      </h3>
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
    </section>
  );
}
