import type { ComponentChildren, JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { Icon, type IconName } from './Icon';

export type NoticeTone = 'info' | 'warn' | 'error' | 'success';

const ICONS: Record<NoticeTone, IconName> = {
  info: 'info',
  warn: 'alert',
  error: 'alert',
  success: 'checkCircle',
};

export function Notice({
  tone = 'info',
  title,
  children,
  icon,
  compact,
}: {
  tone?: NoticeTone;
  title?: ComponentChildren;
  children?: ComponentChildren;
  icon?: IconName;
  compact?: boolean;
}): JSX.Element {
  return (
    <div
      class={`notice notice-${tone}${compact ? ' notice-compact' : ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon name={icon ?? ICONS[tone]} class="notice-icon" />
      <div class="notice-body">
        {title ? <div class="notice-title">{title}</div> : null}
        {children ? <div class="notice-text">{children}</div> : null}
      </div>
    </div>
  );
}

/** Transient confirmation ("Saved"). Announced politely to screen readers. */
export function Toast({
  message,
  onDone,
  timeoutMs = 2500,
}: {
  message: string | null;
  onDone: () => void;
  timeoutMs?: number;
}): JSX.Element {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, timeoutMs);
    return () => clearTimeout(t);
  }, [message, onDone, timeoutMs]);
  return (
    <div class={`toast${message ? ' is-visible' : ''}`} role="status" aria-live="polite">
      {message ? (
        <>
          <Icon name="check" size={14} />
          <span>{message}</span>
        </>
      ) : null}
    </div>
  );
}
