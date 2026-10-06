/// <reference types="node" />
/**
 * Fixtures for the opt-in live suite (playwright.live.config.ts): the live build of the
 * extension in Playwright's Chromium, talking to two public Confluence sites as an anonymous
 * visitor. Reuses the E2E harness (tests/e2e/fixtures.ts) and PDF helpers (tests/e2e/pdf.ts).
 *
 * Politeness: one browser for the whole run, API concurrency 2, live render off, small exports.
 */
import { test as base } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportJobState, ExportRequest, PageRef, SiteInfo } from '../../lib/types';
import { launchExtension, options, type ExtensionHarness } from '../e2e/fixtures';
import type { PageTree } from '../e2e/pdf';

export { outlineHasTree } from '../e2e/pdf';

export { options };

export const LIVE_EXTENSION_DIR = path.resolve(process.cwd(), '.output/chrome-mv3-live');

/** Confluence Data Center 9.2, anonymous read access. */
export const APACHE: SiteInfo = {
  origin: 'https://cwiki.apache.org',
  baseUrl: 'https://cwiki.apache.org/confluence',
  contextPath: '/confluence',
  flavour: 'server',
  siteTitle: 'Apache Software Foundation',
};

/** Confluence Cloud, public "AI" space. */
export const UCONN: SiteInfo = {
  origin: 'https://uconn.atlassian.net',
  baseUrl: 'https://uconn.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
  siteTitle: 'Confluence',
};

/** Local date, like the filenames (`buildFilename`); `toISOString()` is UTC and differs near midnight. */
export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** null = reachable; otherwise why not (the tests for that site skip with this reason). */
async function unreachable(site: SiteInfo): Promise<string | null> {
  if (process.env.LIVE_SKIP?.split(',').includes(new URL(site.origin).hostname)) return 'skipped by LIVE_SKIP';
  try {
    const res = await fetch(`${site.baseUrl}/rest/api/space?limit=1`, {
      headers: { Accept: 'application/json', 'User-Agent': 'fast-confluence-exporter live tests' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = (await res.json()) as { results?: unknown };
    return Array.isArray(body.results) ? null : 'unexpected response';
  } catch (e) {
    return (e as Error)?.message ?? String(e);
  }
}

export interface LiveSites {
  apache: string | null;
  uconn: string | null;
}

/** Export request for a live site, anonymous (no "exported by"), default options. */
export function liveRequest(site: SiteInfo, over: Partial<ExportRequest> & Pick<ExportRequest, 'mode' | 'root'>): ExportRequest {
  return { site, options: options(), ...over };
}

/**
 * Tree-order invariants of an exported page list: the root first, every other page after its
 * parent, one level deeper than it.
 */
export function expectTreeOrder(pages: PageRef[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, PageRef>();
  pages.forEach((p, i) => {
    if (i === 0) {
      if (p.depth !== 0) problems.push(`root ${p.id} has depth ${p.depth}`);
    } else {
      const parent = p.parentId ? seen.get(p.parentId) : undefined;
      if (!parent) problems.push(`${p.id} comes before its parent ${p.parentId}`);
      else if (p.depth !== parent.depth + 1) problems.push(`${p.id} has depth ${p.depth}, parent ${parent.depth}`);
    }
    seen.set(p.id, p);
  });
  return problems;
}

/** The page tree (titles) of an exported page list, for comparison with the PDF bookmarks. */
export function treeOfPages(pages: PageRef[]): PageTree[] {
  const kids = new Map<string | undefined, PageRef[]>();
  const ids = new Set(pages.map((p) => p.id));
  for (const p of pages) {
    const key = p.parentId && ids.has(p.parentId) ? p.parentId : undefined;
    let list = kids.get(key);
    if (!list) kids.set(key, (list = []));
    list.push(p);
  }
  const walk = (parent: string | undefined): PageTree[] => (kids.get(parent) ?? []).map((p) => [p.title, walk(p.id)]);
  return walk(undefined);
}

/** The degraded "N images could not be loaded" entry of a job, if any. */
export function imageErrors(job: ExportJobState): string[] {
  return job.errors.filter((e) => e.title === 'Images').map((e) => e.message);
}

export const test = base.extend<{ cleanup: void }, { ext: ExtensionHarness; sites: LiveSites; downloadsDir: string }>({
  sites: [
    async ({}, use) => {
      const [apache, uconn] = await Promise.all([unreachable(APACHE), unreachable(UCONN)]);
      await use({ apache, uconn });
    },
    { scope: 'worker' },
  ],
  downloadsDir: [
    async ({}, use) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-live-downloads-'));
      await use(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
  ext: [
    async ({ downloadsDir }, use) => {
      const ext = await launchExtension(downloadsDir, LIVE_EXTENSION_DIR, 'npm run build:live');
      // Be gentle with community infrastructure: at most 2 concurrent API requests per export.
      await ext.driver.evaluate(() => chrome.storage.sync.set({ settings: { apiConcurrency: 2, liveRenderConcurrency: 1 } }));
      await use(ext);
      await ext.context.close();
    },
    { scope: 'worker', timeout: 90_000 },
  ],
  cleanup: [
    async ({ ext }, use) => {
      await use();
      await ext.closeOtherPages();
    },
    { auto: true },
  ],
});

export const expect = test.expect;
