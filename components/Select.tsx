import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface SelectOption<V extends string | number> {
  value: V;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<V extends string | number> {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  /** Visible label. When `inline`, it is rendered before the control on one line. */
  label?: ComponentChildren;
  /** Accessible name when no visible label is shown. */
  ariaLabel?: string;
  disabled?: boolean;
  inline?: boolean;
  hint?: ComponentChildren;
  compact?: boolean;
}

/** Native <select> (keyboard + screen-reader friendly) mapped back to typed values. */
export function Select<V extends string | number>({
  value,
  options,
  onChange,
  label,
  ariaLabel,
  disabled,
  inline,
  hint,
  compact,
}: SelectProps<V>): JSX.Element {
  const id = useId();
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div class={`field${inline ? ' field-inline' : ''}`}>
      {label ? (
        <label class="field-label" for={id}>
          {label}
        </label>
      ) : null}
      <div class={`select-wrap${compact ? ' select-compact' : ''}`}>
        <select
          id={id}
          class="select"
          value={String(idx)}
          disabled={disabled}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => {
            const opt = options[Number((e.currentTarget as HTMLSelectElement).value)];
            if (opt) onChange(opt.value);
          }}
        >
          {idx < 0 ? <option value="-1">—</option> : null}
          {options.map((o, i) => (
            <option key={String(o.value)} value={String(i)} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {hint ? (
        <div class="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
