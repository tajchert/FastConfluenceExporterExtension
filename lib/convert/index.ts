/**
 * Markdown / plain-text export (the non-PDF output formats). Runs in the worker tab: it needs a
 * DOM (DOMParser, DOMPurify, turndown) and never touches the network — image downloads for
 * Markdown bundles are done by the caller from `ConvertResult.assets`.
 *
 * Content handling matches the PDF: pages go through the same sanitizer and FR-9 placeholder
 * logic (lib/assemble/sanitize.ts, macros.ts) before they are converted.
 */
import { preparePages } from './prepare';
import { writeMarkdown } from './markdown';
import { writeText } from './text';
import { encodeRelPath, escapeHtml, mdUrl } from './shared';
import type { AssetRef, ConvertInput, ConvertResult, ConvertedFile } from './types';

export type { AssetRef, ConvertInput, ConvertResult, ConvertedFile } from './types';

export function convertPages(doc: Document, input: ConvertInput): ConvertResult {
  const format = input.options.format === 'text' ? 'text' : 'markdown';
  // Always work in an inert document (no browsing context): elements created or imported there
  // never load images or run anything, even when the caller passes the tab's live `document`.
  const work = doc.defaultView ? doc.implementation.createHTMLDocument('') : doc;
  const prep = preparePages(work, input, format);
  const files = format === 'text' ? writeText(prep, input) : writeMarkdown(prep, input);
  return {
    files,
    assets: format === 'markdown' && input.options.downloadImages ? prep.assets : [],
    placeholders: prep.placeholders,
  };
}

/**
 * Points the references of assets that could not be downloaded back at their absolute URLs
 * (Markdown image destinations and `src` attributes inside HTML tables).
 */
export function relinkFailedAssets(files: ConvertedFile[], failed: AssetRef[]): ConvertedFile[] {
  if (failed.length === 0) return files;
  return files.map((file) => {
    let text = file.text;
    for (const asset of failed) {
      const rel = encodeRelPath(asset.path);
      text = text
        .split(`](${rel})`)
        .join(`](${mdUrl(asset.url)})`)
        .split(`src="${rel}"`)
        .join(`src="${escapeHtml(asset.url)}"`);
    }
    return text === file.text ? file : { ...file, text };
  });
}
