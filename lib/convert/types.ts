/**
 * Contract of the Markdown / plain-text converter (runs in the worker tab, real DOM, no network).
 * Re-exported by ./index.ts, which is the module other code imports.
 */
import type { CoverInfo } from '../messages';
import type { PageBody } from '../confluence/client';
import type { ExportOptions, PageRef, SiteInfo } from '../types';

export interface ConvertInput {
  /** Export order; link-only refs (folder/whiteboard/database/embed/slides) have no body. */
  pages: { ref: PageRef; body?: PageBody }[];
  /** Same meaning as AssembleInput in lib/assemble/document.ts. */
  allPages: PageRef[];
  excludeIds?: string[];
  site: SiteInfo;
  /** `options.format` is 'markdown' | 'text'. */
  options: ExportOptions;
  cover: CoverInfo | null;
  toc: boolean;
  generatedBy: string;
  /** One file per page. */
  separate: boolean;
  /** Stem for the combined file, e.g. 'COC_Community Over Code Home_2026-10-06'. */
  baseName: string;
}

/** POSIX relative path, no leading slash. */
export interface ConvertedFile {
  path: string;
  text: string;
}

/** Absolute image URL → relative path in the output bundle. */
export interface AssetRef {
  url: string;
  path: string;
}

export interface ConvertResult {
  files: ConvertedFile[];
  assets: AssetRef[];
  /** FR-9 placeholders inserted for content that can't be exported statically. */
  placeholders: number;
}
