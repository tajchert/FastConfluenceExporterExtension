import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import { clampInt } from './logic';

/**
 * Integer input that keeps the user's in-progress text while typing and commits a clamped value
 * on blur / Enter, so partially typed numbers never reach settings.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  suffix,
  hint,
  disabled,
  ariaLabel,
  width = '5.5em',
}: {
  label?: ComponentChildren;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  suffix?: string;
  hint?: ComponentChildren;
  disabled?: boolean;
  ariaLabel?: string;
  width?: string;
}): JSX.Element {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const v = clampInt(text, min, max, value);
    setText(String(v));
    if (v !== value) onChange(v);
  };

  return (
    <div class="field">
      {label ? (
        <label class="field-label" for={id}>
          {label}
        </label>
      ) : null}
      <div class="number-wrap">
        <input
          id={id}
          class="input input-number"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          disabled={disabled}
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={hint ? `${id}-hint` : undefined}
          style={{ width }}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        {suffix ? <span class="suffix">{suffix}</span> : null}
      </div>
      {hint ? (
        <div class="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
