/**
 * Output formats (PDF, Markdown, plain text): labels, file extensions and MIME types shared by the
 * service worker and the extension pages. No runtime dependencies (safe in every context).
 */
import type { ExportFormat, ExportOptions } from './types';

export interface FormatInfo {
  /** Display name: "PDF", "Markdown", "Text". */
  label: string;
  /** File extension of one exported document. */
  ext: 'pdf' | 'md' | 'txt';
  /** MIME type of one exported document (text formats are UTF-8). */
  mime: string;
}

export const FORMATS: Readonly<Record<ExportFormat, FormatInfo>> = {
  pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
  markdown: { label: 'Markdown', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  text: { label: 'Text', ext: 'txt', mime: 'text/plain;charset=utf-8' },
};

export const FORMAT_CHOICES: readonly { value: ExportFormat; label: string }[] = [
  { value: 'pdf', label: 'PDF' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'text', label: 'Text' },
];

/** Options that only affect PDF output (hidden or ignored for Markdown and text). */
export const PDF_ONLY_OPTIONS: readonly (keyof ExportOptions)[] = [
  'paperSize',
  'orientation',
  'marginsMm',
  'pageNumbers',
  'liveRender',
  'shrinkWideTables',
  'customCss',
];

/** The format of `options`, defaulting to PDF for options stored before formats existed. */
export function formatOf(options: Partial<Pick<ExportOptions, 'format'>> | undefined): ExportFormat {
  const f = options?.format;
  return f === 'markdown' || f === 'text' ? f : 'pdf';
}

export function isTextFormat(options: Partial<Pick<ExportOptions, 'format'>> | undefined): boolean {
  return formatOf(options) !== 'pdf';
}

/** Primary button label: "Export PDF", "Export Markdown", "Export text", or "Export ZIP" for separate files. */
export function exportButtonLabel(options: Pick<ExportOptions, 'format' | 'separateFiles'>): string {
  if (options.separateFiles) return 'Export ZIP';
  const f = formatOf(options);
  return f === 'pdf' ? 'Export PDF' : f === 'markdown' ? 'Export Markdown' : 'Export text';
}

/** "Converting to Markdown…" / "Converting to text…" (runner status message). */
export function convertingMessage(format: ExportFormat): string {
  return format === 'markdown' ? 'Converting to Markdown…' : 'Converting to text…';
}

/** File extensions that compress well inside a ZIP (everything else is stored as is). */
const COMPRESSIBLE = /\.(md|markdown|txt|svg|json|csv|html?|xml|css|js)$/i;
export function isCompressible(path: string): boolean {
  return COMPRESSIBLE.test(path);
}
