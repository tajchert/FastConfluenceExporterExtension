import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { FORMAT_CHOICES, PDF_ONLY_OPTIONS, formatOf } from '../lib/format';
import type { ExportFormat, ExportOptions, Orientation, PaperSize } from '../lib/types';
import { MARGIN_PRESETS, formatMargins, marginPresetOf, type MarginPreset } from './logic';
import { NumberField } from './NumberField';
import { Select, type SelectOption } from './Select';
import { Toggle } from './Toggle';

export const PAPER_OPTIONS: SelectOption<PaperSize>[] = [
  { value: 'A4', label: 'A4' },
  { value: 'Letter', label: 'Letter' },
  { value: 'Legal', label: 'Legal' },
  { value: 'A3', label: 'A3' },
];

type BoolKey = {
  [K in keyof ExportOptions]: ExportOptions[K] extends boolean ? K : never;
}[keyof ExportOptions];

type Text = string | ((f: ExportFormat) => string);

const TOGGLES: { key: BoolKey; label: Text; desc: Text; group: 'content' | 'output' }[] = [
  {
    key: 'includeCover',
    label: 'Cover page',
    desc: (f) =>
      f === 'markdown'
        ? 'Front matter with title, source, date, author and page count'
        : f === 'text'
          ? 'Header with title, source, date, author and page count'
          : 'Title, source, date, author and page count',
    group: 'content',
  },
  {
    key: 'includeToc',
    label: 'Table of contents',
    desc: (f) => (f === 'pdf' ? 'Clickable entries for every page' : f === 'markdown' ? 'Linked list of every page' : 'List of every page'),
    group: 'content',
  },
  { key: 'includePageMeta', label: 'Page details', desc: 'Breadcrumb, last updated and a link to the original', group: 'content' },
  { key: 'pageNumbers', label: 'Page numbers', desc: 'Shown in the footer', group: 'content' },
  { key: 'includeComments', label: 'Comment highlights', desc: 'Keep inline comment markers in the text', group: 'content' },
  { key: 'shrinkWideTables', label: 'Fit wide tables', desc: 'Shrink tables that are wider than the page', group: 'content' },
  { key: 'liveRender', label: 'Live render (slow)', desc: 'Print pages with diagrams or charts from the real Confluence page', group: 'output' },
  {
    key: 'downloadImages',
    label: 'Include images (ZIP)',
    desc: 'Bundle page images with the Markdown in a ZIP. Off: images link to Confluence',
    group: 'output',
  },
  {
    key: 'separateFiles',
    label: (f) => (f === 'pdf' ? 'One PDF per page (ZIP)' : 'One file per page (ZIP)'),
    desc: (f) => `One ${f === 'pdf' ? 'PDF' : f === 'markdown' ? 'Markdown' : 'text'} file per page, bundled in a ZIP file`,
    group: 'output',
  },
  { key: 'includeArchived', label: 'Include archived pages', desc: 'Archived pages are skipped by default', group: 'output' },
];

const text = (t: Text, f: ExportFormat): string => (typeof t === 'string' ? t : t(f));

/** Radio group styled as a segmented control. */
export function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  disabled?: boolean;
}): JSX.Element {
  const name = useId();
  return (
    <fieldset class="field segmented-field" disabled={disabled}>
      <legend class="field-label">{label}</legend>
      <div class="segmented">
        {options.map((o) => (
          <label key={o.value} class={`segment${value === o.value ? ' is-active' : ''}`}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface OptionsFormProps {
  value: ExportOptions;
  onChange: (v: ExportOptions) => void;
  /** 'preview': margin presets and the per-export toggles; 'settings': exact margins too. */
  variant: 'preview' | 'settings';
  /** Fields fixed by managed policy. */
  locked?: ReadonlySet<keyof ExportOptions>;
  /** Hide toggles that do not apply in this context. */
  hide?: readonly (keyof ExportOptions)[];
}

export function OptionsForm({ value, onChange, variant, locked, hide = [] }: OptionsFormProps): JSX.Element {
  const set = <K extends keyof ExportOptions>(key: K, v: ExportOptions[K]) => onChange({ ...value, [key]: v });
  const isLocked = (k: keyof ExportOptions) => locked?.has(k) ?? false;
  const preset = marginPresetOf(value.marginsMm);
  const format = formatOf(value);
  const pdf = format === 'pdf';
  // Per export (preview): PDF-only controls are hidden for Markdown / text. In the settings they
  // stay editable (they are the defaults for PDF exports) under a "PDF layout" hint.
  const hidePdfOnly = !pdf && variant === 'preview';
  const hidden = (k: keyof ExportOptions) =>
    hide.includes(k) || (hidePdfOnly && PDF_ONLY_OPTIONS.includes(k)) || (k === 'downloadImages' && format !== 'markdown');
  // Settings with a Markdown / text default: the PDF-only toggles move into the "PDF layout" group.
  const pdfGroupToggles = !pdf && variant === 'settings';
  const inGroup = (group: 'content' | 'output') => (t: (typeof TOGGLES)[number]) =>
    t.group === group && !(pdfGroupToggles && PDF_ONLY_OPTIONS.includes(t.key));

  const presetOptions: SelectOption<MarginPreset>[] = [
    ...(Object.keys(MARGIN_PRESETS) as (keyof typeof MARGIN_PRESETS)[]).map((k) => ({
      value: k as MarginPreset,
      label: `${MARGIN_PRESETS[k].label} (${formatMargins(MARGIN_PRESETS[k].margins)})`,
    })),
    ...(preset === 'custom'
      ? [{ value: 'custom' as MarginPreset, label: `Custom (${formatMargins(value.marginsMm)})`, disabled: true }]
      : []),
  ];

  const toggle = (t: (typeof TOGGLES)[number]) => {
    if (hidden(t.key)) return null;
    // Separate PDFs have no cover and no TOC; a Markdown / text ZIP puts both into a contents file.
    const zipDisables = value.separateFiles && pdf && (t.key === 'includeCover' || t.key === 'includeToc');
    const zipToc = value.separateFiles && t.key === 'includeToc' && !pdf;
    const zipCover = value.separateFiles && t.key === 'includeCover' && !pdf;
    return (
      <Toggle
        key={t.key}
        label={text(t.label, format)}
        description={
          zipDisables
            ? 'Not used with separate PDFs'
            : zipToc
              ? 'A contents file that links to every page'
              : zipCover
                ? 'Export details at the top of the contents file'
                : text(t.desc, format)
        }
        checked={value[t.key]}
        locked={isLocked(t.key)}
        disabled={zipDisables}
        onChange={(v) => set(t.key, v)}
      />
    );
  };

  const layout = (
    <>
      <div class="form-row">
        <Select
          label="Paper size"
          value={value.paperSize}
          options={PAPER_OPTIONS}
          disabled={isLocked('paperSize')}
          onChange={(v) => set('paperSize', v)}
        />
        <Segmented<Orientation>
          label="Orientation"
          value={value.orientation}
          disabled={isLocked('orientation')}
          options={[
            { value: 'portrait', label: 'Portrait' },
            { value: 'landscape', label: 'Landscape' },
          ]}
          onChange={(v) => set('orientation', v)}
        />
      </div>

      {variant === 'preview' ? (
        <Select<MarginPreset>
          label="Margins"
          value={preset}
          options={presetOptions}
          disabled={isLocked('marginsMm')}
          onChange={(p) => {
            if (p !== 'custom') set('marginsMm', { ...MARGIN_PRESETS[p].margins });
          }}
        />
      ) : (
        <fieldset class="field margins" disabled={isLocked('marginsMm')}>
          <legend class="field-label">Margins (mm)</legend>
          <div class="margins-grid">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <NumberField
                key={side}
                label={side[0].toUpperCase() + side.slice(1)}
                value={value.marginsMm[side]}
                min={0}
                max={100}
                width="4.5em"
                onChange={(n) => set('marginsMm', { ...value.marginsMm, [side]: n })}
              />
            ))}
          </div>
          <div class="preset-row" role="group" aria-label="Margin presets">
            {(Object.keys(MARGIN_PRESETS) as (keyof typeof MARGIN_PRESETS)[]).map((k) => (
              <button
                key={k}
                type="button"
                class={`chip${preset === k ? ' is-active' : ''}`}
                aria-pressed={preset === k}
                onClick={() => set('marginsMm', { ...MARGIN_PRESETS[k].margins })}
              >
                {MARGIN_PRESETS[k].label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );

  return (
    <div class={`options-form options-${variant}`}>
      {hide.includes('format') ? null : (
        <Segmented<ExportFormat>
          label="Format"
          value={format}
          disabled={isLocked('format')}
          options={FORMAT_CHOICES}
          onChange={(v) => set('format', v)}
        />
      )}

      {hidePdfOnly ? (
        <p class="field-hint format-hint">
          Paper size, margins, page numbers and live render apply to PDF only.
        </p>
      ) : pdf ? (
        layout
      ) : (
        <div class="pdf-layout" role="group" aria-label="PDF layout">
          <div class="group-label">PDF layout</div>
          <p class="field-hint format-hint">Used when you export as PDF.</p>
          {layout}
          <div class="toggle-group" role="group" aria-label="PDF options">
            {TOGGLES.filter((t) => PDF_ONLY_OPTIONS.includes(t.key)).map(toggle)}
          </div>
        </div>
      )}

      <div class="toggle-group" role="group" aria-label="Content">
        <div class="group-label">Content</div>
        {TOGGLES.filter(inGroup('content')).map(toggle)}
      </div>
      <div class="toggle-group" role="group" aria-label="Output">
        <div class="group-label">Output</div>
        {TOGGLES.filter(inGroup('output')).map(toggle)}
      </div>
    </div>
  );
}
