/// <reference types="node" />
/**
 * Live: Confluence Cloud at https://uconn.atlassian.net/wiki, public "AI" space, anonymous.
 * The space is actively edited: assertions check ids and structure, never text or exact counts.
 */
import { links, loadPdf, namedDestinations, readOutline } from '../e2e/pdf';
import { expect, expectTreeOrder, imageErrors, outlineHasTree, liveRequest, test, treeOfPages, UCONN } from './fixtures';

test.beforeEach(({ sites }) => {
  test.skip(!!sites.uconn, `uconn.atlassian.net is not reachable (${sites.uconn})`);
});

test('popup detects the AI space overview as a space (Cloud SPA, anonymous)', async ({ ext }) => {
  const source = await ext.openPage(`${UCONN.baseUrl}/spaces/AI/overview`);
  const popup = await ext.context.newPage();
  await source.bringToFront();
  await popup.goto(ext.url('popup.html'));
  await expect(popup.locator('.ctx-title')).toHaveText('Artificial Intelligence');
  await expect(popup.locator('.ctx-meta')).toContainText('Space AI');
  await expect(popup.getByText(/log in|sign in/i)).toHaveCount(0);
});

test('current page with attachment images (media redirect) → valid PDF, images loaded', async ({ ext }) => {
  // "Copilot vs. ChatGPT": 3 attachment images that redirect to api.media.atlassian.com.
  const { job, file } = await ext.exportAndDownload(
    liveRequest(UCONN, { mode: 'current', root: { id: '29030154243', type: 'page', spaceKey: 'AI' } }),
    undefined,
    180_000,
  );
  expect(job.pages.map((p) => p.id)).toEqual(['29030154243']);
  expect(job.result!.filename).toMatch(/^AI_.+_\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(imageErrors(job), 'every image on the page loaded').toEqual([]);
  expect(job.errors).toEqual([]);

  const pdf = await loadPdf(file.bytes);
  expect(pdf.getPageCount()).toBe(job.result!.sheetCount);
  expect(pdf.getTitle()).toBe(job.pages[0]!.title);
  expect(pdf.getAuthor()).toBeUndefined();
  expect(readOutline(pdf)[0]?.title).toBe(job.pages[0]!.title);
  const named = new Set(namedDestinations(pdf));
  for (const d of links(pdf).dests) expect(named.has(d), `link target ${d}`).toBe(true);
});

test('subtree: "Microsoft Copilot" in page-tree order with matching bookmarks', async ({ ext }) => {
  const { job, file } = await ext.exportAndDownload(
    liveRequest(UCONN, { mode: 'subtree', depth: 2, root: { id: '29081927691', type: 'page', spaceKey: 'AI' } }),
    undefined,
    240_000,
  );
  expect(job.pages[0]!.id).toBe('29081927691');
  expect(job.pages.length).toBeGreaterThan(1);
  expect(job.pages.length).toBeLessThanOrEqual(15);
  expect(expectTreeOrder(job.pages)).toEqual([]);
  expect(job.errors.filter((e) => e.severity !== 'degraded')).toEqual([]);

  const pdf = await loadPdf(file.bytes);
  expect(outlineHasTree(readOutline(pdf), treeOfPages(job.pages)), JSON.stringify(treeOfPages(job.pages))).toBe(true);
});

test('folder: "OpenAI" → folder section followed by its pages', async ({ ext }) => {
  const { job, file } = await ext.exportAndDownload(
    liveRequest(UCONN, { mode: 'folder', depth: 'all', root: { id: '29156212770', type: 'folder', spaceKey: 'AI' } }),
    undefined,
    240_000,
  );
  expect(job.pages[0]).toMatchObject({ id: '29156212770', type: 'folder', depth: 0 });
  expect(job.pages.length).toBeGreaterThan(1);
  expect(job.pages.length).toBeLessThanOrEqual(15);
  expect(expectTreeOrder(job.pages)).toEqual([]);
  expect(job.errors.filter((e) => e.severity !== 'degraded')).toEqual([]);
  const pdf = await loadPdf(file.bytes);
  expect(readOutline(pdf)[0]?.title).toBe(job.pages[0]!.title);
});
