import type { ButtonHTMLAttributes, ComponentChildren, JSX } from 'preact';
import { Icon, Spinner, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: IconName;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** For icon-only buttons: required accessible name. */
  label?: string;
  block?: boolean;
  children?: ComponentChildren;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  label,
  block = false,
  children,
  class: cls,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  const iconOnly = !children;
  const classes = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : '',
    iconOnly ? 'btn-icon' : '',
    block ? 'btn-block' : '',
    typeof cls === 'string' ? cls : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      {...rest}
      type={type}
      class={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={label}
      title={rest.title ?? (iconOnly ? label : undefined)}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}
