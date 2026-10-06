import type { JSX } from 'preact';

/** `value` in 0..1, or null for an indeterminate (animated) bar. */
export function ProgressBar({
  value,
  label,
  tone = 'accent',
}: {
  value: number | null;
  label: string;
  tone?: 'accent' | 'success' | 'danger' | 'muted';
}): JSX.Element {
  const pct = value === null ? null : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      class={`progress progress-${tone}${pct === null ? ' is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
    >
      <div class="progress-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
