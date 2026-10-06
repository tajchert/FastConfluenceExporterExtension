import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Icon } from './Icon';

export interface ToggleProps {
  label: ComponentChildren;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: ComponentChildren;
  disabled?: boolean;
  /** Locked by an administrator policy: disabled with a lock icon and tooltip. */
  locked?: boolean;
  /** 'switch' (default) or a compact checkbox look for dense rows. */
  appearance?: 'switch' | 'checkbox';
}

/** Accessible on/off control rendered as a native checkbox (role=switch) with a styled track. */
export function Toggle({
  label,
  checked,
  onChange,
  description,
  disabled,
  locked,
  appearance = 'switch',
}: ToggleProps): JSX.Element {
  const id = useId();
  const descId = description ? `${id}-desc` : undefined;
  const off = disabled || locked;
  return (
    <div class={`toggle toggle-${appearance}${off ? ' is-disabled' : ''}`}>
      <input
        id={id}
        type="checkbox"
        role={appearance === 'switch' ? 'switch' : undefined}
        class={appearance === 'switch' ? 'switch-input' : 'checkbox'}
        checked={checked}
        disabled={off}
        aria-describedby={descId}
        onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
      />
      <label for={id} class="toggle-label">
        <span class="toggle-text">
          {label}
          {locked ? (
            <span class="lock" title="Set by your administrator">
              <Icon name="lock" size={12} label="Set by your administrator" />
            </span>
          ) : null}
        </span>
        {description ? (
          <span id={descId} class="toggle-desc">
            {description}
          </span>
        ) : null}
      </label>
    </div>
  );
}

/** Plain checkbox with optional tri-state; used by lists and trees. */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled,
  tabIndex,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name (visually hidden). */
  label: string;
  disabled?: boolean;
  tabIndex?: number;
}): JSX.Element {
  return (
    <input
      type="checkbox"
      class="checkbox"
      checked={checked && !indeterminate}
      indeterminate={indeterminate}
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
    />
  );
}
