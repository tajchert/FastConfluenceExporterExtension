/// <reference types="node" />
/**
 * Live: Confluence Data Center 9.2 at https://cwiki.apache.org/confluence, anonymous.
 * Pages are chosen to be small and stable; assertions check structure and ids, not text.
 */
import type { Request } from '@playwright/test';
import type { ExportJobState } from '../../lib/types';
import { links, loadPdf, namedDestinations, readOutline } from '../e2e/pdf';
import { APACHE, expect, expectTreeOrder, outlineHasTree, imageErrors, liveRequest, test, today, treeOfPages } from './fixtures';

const COC_HOME = { id: '315494566', title: 'Community Over Code Home', spaceKey: 'COC' };
const COC_HOME_URL = `${APACHE.baseUrl}/spaces/COC/pages/315494566/Community+Over+Code+Home`;

test.beforeEach(({ sites }) => {
  test.skip(!!sites.apache, `cwiki.apache.org is not reachable (${sites.apache})`);
});

test('popup detects the Community Over Code home page (DC, anonymous)', async ({ ext }) => {
  const source = await ext.openPage(COC_HOME_URL);
  const popup = await ext.context.newPage();
  await source.bringToFront();
  await popup.goto(ext.url('popup.html'));
  await expect(popup.locator('.ctx-title')).toHaveText(/Community Over Code/);
  await expect(popup.locator('.ctx-meta')).toContainText('Space COC');
  await expect(popup.getByRole('radio', { name: 'This page', exact: true })).toBeVisible();
  // Nothing about a sign-in is shown: anonymous access to a public site is a normal case.
  await expect(popup.getByText(/log in|sign in/i)).toHaveCount(0);
});

test('current page: COC home → valid PDF with title, outline and loaded images', async ({ ext }) => {
  const methods = new Set<string>();
  const onRequest = (r: Request) => {
    if (r.url().startsWith(APACHE.origin)) methods.add(r.method());
  };
  ext.context.on('request', onRequest);
  const { job, file } = await ext.exportAndDownload(
    liveRequest(APACHE, { mode: 'current', root: { id: COC_HOME.id, type: 'page', title: COC_HOME.title, spaceKey: 'COC' } }),
    undefined,
    180_000,
  );
  ext.context.off('request', onRequest);

  expect(job.pages.map((p) => p.id)).toEqual([COC_HOME.id]);
  expect(job.result!.filename).toBe(`COC_${COC_HOME.title}_${today()}.pdf`);
  expect(imageErrors(job), 'every image on the page loaded').toEqual([]);
  expect(job.errors).toEqual([]);

  const pdf = await loadPdf(file.bytes);
  expect(pdf.getPageCount()).toBe(job.result!.sheetCount);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3); // cover + TOC + content
  expect(pdf.getTitle()).toBe(COC_HOME.title);
  expect(pdf.getAuthor()).toBeUndefined(); // anonymous: no "exported by"
  expect(readOutline(pdf)[0]?.title).toBe(COC_HOME.title);
  // Read-only: the extension only ever GETs from Confluence.
  expect([...methods]).toEqual(['GET']);
});

test('subtree: a small, inactive tree comes out in page-tree order with matching bookmarks', async ({ ext }) => {
  // "White House Software Security Meeting" (COMDEV): 6 pages, 2 levels, not edited any more.
  const { job, file } = await ext.exportAndDownload(
    liveRequest(APACHE, {
      mode: 'subtree',
      depth: 'all',
      root: { id: '199529919', type: 'page', spaceKey: 'COMDEV' },
    }),
    undefined,
    240_000,
  );
  expect(job.pages.length).toBeGreaterThan(1);
  expect(job.pages.length).toBeLessThanOrEqual(15);
  expect(job.pages[0]!.id).toBe('199529919');
  expect(expectTreeOrder(job.pages)).toEqual([]);
  expect(job.errors.filter((e) => e.severity !== 'degraded')).toEqual([]);

  const pdf = await loadPdf(file.bytes);
  expect(outlineHasTree(readOutline(pdf), treeOfPages(job.pages)), JSON.stringify(treeOfPages(job.pages))).toBe(true);
  // Every page section is a named destination, and every internal link resolves to one.
  const dests = new Set(namedDestinations(pdf));
  for (const p of job.pages) expect(dests.has(`p-${p.id}`), `section of ${p.title}`).toBe(true);
  for (const d of links(pdf).dests) expect(dests.has(d), `link target ${d}`).toBe(true);
});

test('linked pages: tiny link and /display/ title link are both followed and become internal links', async ({ ext }) => {
  // KIP-1342 links KIP-801 via /x/h5KqCw and KIP-877 via /display/KAFKA/KIP-877%3A+….
  const { job, file } = await ext.exportAndDownload(
    liveRequest(APACHE, { mode: 'linked', linkDepth: 1, root: { id: '421958795', type: 'page', spaceKey: 'KAFKA' } }),
    undefined,
    240_000,
  );
  const ids = job.pages.map((p) => p.id);
  expect(ids[0]).toBe('421958795');
  expect(ids).toEqual(expect.arrayContaining(['195728007', '231116181']));
  expect(ids.length).toBeLessThanOrEqual(15);
  expect(job.pages.slice(1).every((p) => p.reason === 'linked')).toBe(true);

  const pdf = await loadPdf(file.bytes);
  const { dests, uris } = links(pdf);
  expect(dests).toEqual(expect.arrayContaining(['p-195728007', 'p-231116181']));
  // Both links inside KIP-1342 jump within the PDF (the /display/ one resolved by title): the
  // original web addresses are gone from the PDF.
  expect(uris.filter((u) => u.includes('/x/h5KqCw') || u.includes('/display/KAFKA/KIP-877'))).toEqual([]);
  const named = new Set(namedDestinations(pdf));
  for (const d of dests) expect(named.has(d), `link target ${d}`).toBe(true);
});

test('preview lists a subtree with breadcrumbs before exporting', async ({ ext }) => {
  const { encodeRequestParam } = await import('../../lib/util/base64');
  const request = liveRequest(APACHE, { mode: 'subtree', depth: 'all', root: { id: COC_HOME.id, type: 'page', spaceKey: 'COC' } });
  const preview = await ext.context.newPage();
  await preview.goto(ext.url(`preview.html?req=${encodeRequestParam(request)}`));
  const rows = preview.locator('ul.rows .row-title');
  await expect(rows.first()).toHaveText(COC_HOME.title, { timeout: 120_000 });
  const count = await rows.count();
  expect(count).toBeGreaterThan(1);
  expect(count).toBeLessThanOrEqual(15);
  // No export here: the list itself is what this test checks.
  const jobs = await ext.call<ExportJobState[]>({ type: 'job/list' });
  expect(jobs.filter((j) => j.request.root.id === COC_HOME.id && j.request.mode === 'subtree')).toEqual([]);
});
