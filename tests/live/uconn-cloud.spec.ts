/// <reference types="node" />
/**
 * Live: Confluence Cloud at https://uconn.atlassian.net/wiki, public "AI" space, anonymous.
 * The space is actively edited: assertions check ids and structure, never text or exact counts.
 */
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import { links, loadPdf, namedDestinations, readOutline } from '../e2e/pdf';
import { expect, expectTreeOrder, imageErrors, options, outlineHasTree, liveRequest, test, today, treeOfPages, UCONN } from './fixtures';

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

test('Markdown with images: attachments behind the media redirect are bundled (anonymous)', async ({ ext }, testInfo) => {
  // Same page as above: its 3 attachments answer 302 → api.media.atlassian.com (CORS `*`, token URL).
  const { job, file } = await ext.exportAndDownload(
    liveRequest(UCONN, {
      mode: 'current',
      root: { id: '29030154243', type: 'page', spaceKey: 'AI' },
      options: options({ format: 'markdown', downloadImages: true }),
    }),
    undefined,
    120_000,
  );
  fs.writeFileSync(testInfo.outputPath(job.result!.filename), file.bytes);
  expect(job.errors, 'every image downloaded').toEqual([]);
  expect(job.result!.filename).toMatch(new RegExp(`^AI_.+_${today()}\\.zip$`));
  const entries = unzipSync(file.bytes);
  const names = Object.keys(entries);
  const md = names.filter((n) => n.endsWith('.md'));
  expect(md).toHaveLength(1);
  const assets = names.filter((n) => n.startsWith('assets/29030154243/'));
  expect(assets.length).toBeGreaterThanOrEqual(1);
  for (const a of assets) expect([...entries[a].slice(0, 4)], a).toEqual([0x89, 0x50, 0x4e, 0x47]); // real PNGs, not HTML
  const text = new TextDecoder().decode(entries[md[0]]);
  expect(text).toMatch(/^# .+/m);
  // Every relative image reference resolves to a file in the ZIP.
  const refs = [...text.matchAll(/!\[[^\]]*\]\((<[^>]+>|[^)\s]+)/g)]
    .map((m) => (m[1].startsWith('<') ? m[1].slice(1, -1) : m[1]))
    .filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t))
    .map((t) => decodeURIComponent(t));
  expect(refs.length).toBeGreaterThanOrEqual(assets.length);
  for (const r of refs) expect(names, r).toContain(r);
});

test('plain text: "Copilot vs. ChatGPT" → one readable .txt, no HTML, no debugger needed', async ({ ext }, testInfo) => {
  const { job, file } = await ext.exportAndDownload(
    liveRequest(UCONN, {
      mode: 'current',
      root: { id: '29030154243', type: 'page', spaceKey: 'AI' },
      options: options({ format: 'text' }),
    }),
    undefined,
    120_000,
  );
  fs.writeFileSync(testInfo.outputPath(job.result!.filename), file.bytes);
  expect(job.errors).toEqual([]);
  expect(job.result!.filename).toMatch(new RegExp(`^AI_.+_${today()}\\.txt$`));
  expect(file.mime).toMatch(/^text\/plain/);
  expect(await ext.debuggerAttachedTabs()).toEqual([]);

  const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  const title = job.pages[0]!.title;
  // The page title is underlined with '=' of the same width; the cover and TOC come first.
  const at = text.indexOf(`\n${title}\n${'='.repeat([...title].length)}\n`);
  expect(at, 'underlined page title').toBeGreaterThan(0);
  expect(text.slice(0, at)).toContain(title);
  // Images are named, never embedded or linked as markup; no HTML at all.
  expect(text).toMatch(/\[Image: [^\]\n]+\]/);
  expect(text).not.toMatch(/<\/?(p|div|span|table|img|a|br|script)\b[^>]*>/i);
  expect(text).not.toMatch(/!\[|\]\(/);
  // Plain UTF-8 text with \n line endings, no trailing spaces, one final newline.
  expect(text).not.toContain('\r');
  expect(text).not.toMatch(/[ \t]+\n/);
  expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
});
