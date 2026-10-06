/// <reference types="node" />
/**
 * End-to-end: the built extension in a real Chromium against the mock Confluence
 * (tests/e2e/mock-confluence). Real `chrome.debugger` printToPDF, offscreen blob URLs,
 * chrome.downloads, worker-tab injection, pdf-lib post-processing.
 */
import path from 'node:path';
import type { Page, Request } from '@playwright/test';
import { unzipSync } from 'fflate';
import { PDFArray, PDFDict, PDFName } from 'pdf-lib';
import type { ExportJobState, ExportRequest } from '../../lib/types';
import { encodeRequestParam } from '../../lib/util/base64';
import { cloudSite, dcSite, expect, options, test, type ExtensionHarness } from './fixtures';
import type { MockConfluence } from './mock-confluence/server.mjs';
import { links, loadPdf, namedDestinations, pageTree, readOutline, type Outline, type PageTree } from './pdf';

const TITLES: Record<string, string> = {
  100: 'Test Home',
  101: 'Engineering Handbook',
  102: 'Getting Started',
  103: 'Architecture Overview',
  104: 'Secret Plans',
  105: 'Local Setup',
  106: 'Release Notes',
  500: 'Design Docs',
  501: 'API Design',
  502: 'UI Guidelines',
};

/** Local date, like the filenames (`buildFilename`); `toISOString()` is UTC and differs near midnight. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function cloudRequest(cloud: MockConfluence, over: Partial<ExportRequest> & Pick<ExportRequest, 'mode' | 'root'>): ExportRequest {
  return {
    site: cloudSite(cloud),
    options: options(),
    userDisplayName: 'Erin Example',
    ...over,
    root: { spaceKey: 'TEST', ...over.root },
  };
}

/** Every request the extension made is a GET, and every API/attachment request carried the session cookie. */
function expectReadOnlyWithCookies(mock: MockConfluence) {
  const methods = new Set(mock.log.map((r) => r.method));
  expect([...methods]).toEqual(['GET']);
  const api = mock.log.filter((r) => /\/(rest\/api|api\/v2|download)\//.test(r.path));
  expect(api.length).toBeGreaterThan(0);
  expect(api.filter((r) => !r.cookie)).toEqual([]);
}

function exportAndRead(ext: ExtensionHarness, request: ExportRequest, pages?: ExportJobState['pages']) {
  return ext.exportAndDownload(request, pages);
}

const outlineTitles = (o: { title: string }[]) => o.map((i) => i.title);

const flatTitles = (items: Outline[]): string[] => items.flatMap((i) => [i.title, ...flatTitles(i.children)]);

test('(a) current page → one PDF: metadata, outline, anchors, images, read-only same-origin traffic', async ({ ext, cloud }) => {
  const source = await ext.openPage(cloud.url('/spaces/TEST/pages/103/Architecture+Overview'));
  // Requests made by the extension (worker tab, extension pages), not by the user's own tab.
  const foreign: string[] = [];
  const onRequest = (r: Request) => {
    const u = r.url();
    let page: Page | null = null;
    try {
      page = r.frame().page();
    } catch {
      page = null; // service worker request
    }
    if (page === source) return;
    if (!u.startsWith(cloud.origin) && !/^(chrome-extension|data|blob):/.test(u)) foreign.push(u);
  };
  ext.context.on('request', onRequest);

  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, { mode: 'current', root: { id: '103', type: 'page', title: TITLES[103] }, sourceTabId: undefined }),
  );
  ext.context.off('request', onRequest);

  expect(job.errors).toEqual([]);
  expect(job.pages.map((p) => p.id)).toEqual(['103']);
  expect(job.result!.filename).toBe(`TEST_Architecture Overview_${today()}.pdf`);
  expect(path.basename(file.filename)).toBe(job.result!.filename);
  expect(file.mime).toBe('application/pdf');

  const pdf = await loadPdf(file.bytes);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2); // cover + TOC + content
  expect(pdf.getPageCount()).toBe(job.result!.sheetCount);
  expect(pdf.getTitle()).toBe('Architecture Overview');
  expect(pdf.getAuthor()).toBe('Erin Example');
  expect(pdf.getCreator()).toMatch(/^Fast Confluence Exporter v\d/);
  expect(pdf.getSubject()).toContain('TEST');
  expect(pdf.getKeywords()).toContain('Confluence');

  // Chrome's outline: the page title with its (demoted) headings nested below.
  const outline = readOutline(pdf);
  expect(outlineTitles(outline)).toEqual(['Architecture Overview']);
  expect(outlineTitles(outline[0].children)).toEqual(['Components', 'Data model']);

  // Section anchor + prefixed same-page anchors, and every internal link resolves.
  const dests = namedDestinations(pdf);
  expect(dests).toEqual(expect.arrayContaining(['p-103', 'p103-ArchitectureOverview-Components', 'p103-ArchitectureOverview-Datamodel']));
  const l = links(pdf);
  expect(l.dests.length).toBeGreaterThan(0);
  for (const d of l.dests) expect(dests).toContain(d);
  // Pages not in the export stay links to Confluence; the iframe became a link to its source.
  expect(l.uris).toContain(cloud.url('/spaces/TEST/pages/102/Getting+Started'));
  expect(l.uris).toContain('https://www.example.com/embed/video');

  // The image was fetched with the session cookie (no placeholder → no "degraded" image error).
  expect(cloud.log.some((r) => r.path.startsWith('/wiki/download/attachments/103/diagram.png') && r.cookie)).toBe(true);
  expectReadOnlyWithCookies(cloud);
  expect(foreign).toEqual([]);
  expect(await ext.workerTabUrls()).toEqual([]);
  await source.close();
});

test('(b) subtree → tree order, 403 page skipped, 429 retried, archived excluded, bookmarks per page', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, { mode: 'subtree', depth: 'all', root: { id: '101', type: 'page', title: TITLES[101] } }),
  );

  // Descendants arrive scrambled and paginated (page size 2): the job must be in sidebar tree order.
  expect(job.pages.map((p) => p.id)).toEqual(['101', '102', '105', '103', '104']);
  expect(job.pages.map((p) => p.depth)).toEqual([0, 1, 2, 1, 1]);
  expect(job.errors).toEqual([expect.objectContaining({ pageId: '104', severity: 'skipped' })]);
  expect(job.warnings?.join(' ')).toMatch(/1 archived item was excluded/);
  expect(job.message).toMatch(/1 page skipped/);
  // 429 + Retry-After on "Getting Started" was retried.
  const bodies102 = cloud.log.filter((r) => r.path.startsWith('/wiki/api/v2/pages/102?body-format=export_view'));
  expect(bodies102.length).toBe(2);
  expect(cloud.log.some((r) => r.path.includes('cursor=2'))).toBe(true);

  const pdf = await loadPdf(file.bytes);
  expect(pdf.getTitle()).toBe('Engineering Handbook');
  expect(pdf.getSubject()).toContain('4 pages');
  // Bookmarks follow the page tree (each page also keeps its own heading bookmarks).
  const outline = readOutline(pdf);
  expect(pageTree(outline, Object.values(TITLES))).toEqual([
    ['Engineering Handbook', [['Getting Started', [['Local Setup', []]]], ['Architecture Overview', []]]],
  ]);
  const arch = outline[0]!.children.find((c) => c.title === 'Architecture Overview')!;
  expect(outlineTitles(arch.children)).toEqual(['Components', 'Data model']);
  const dests = namedDestinations(pdf);
  for (const id of ['101', '102', '105', '103']) expect(dests).toContain(`p-${id}`);
  expect(dests).not.toContain('p-104');
  // Links between exported pages jump inside the PDF; every internal link resolves.
  const l = links(pdf);
  expect(l.dests).toContain('p-102');
  for (const d of l.dests) expect(dests).toContain(d);
  // The skipped page stays an external link.
  expect(l.uris).toContain(cloud.url('/spaces/TEST/pages/104/Secret+Plans'));
  expectReadOnlyWithCookies(cloud);
});

test('(c) folder → folder header + its pages in sidebar order', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/folder/500'));
  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, { mode: 'folder', depth: 'all', root: { id: '500', type: 'folder', title: TITLES[500] } }),
  );
  expect(job.pages.map((p) => [p.id, p.type, p.depth])).toEqual([
    ['500', 'folder', 0],
    ['501', 'page', 1],
    ['502', 'page', 1],
  ]);
  expect(job.errors).toEqual([]);
  expect(job.result!.filename).toBe(`TEST_Design Docs_${today()}.pdf`);
  const pdf = await loadPdf(file.bytes);
  expect(pageTree(readOutline(pdf), Object.values(TITLES))).toEqual([['Design Docs', [['API Design', []], ['UI Guidelines', []]]]]);
  expect(pdf.getSubject()).toContain('2 pages');
});

test('(d) linked pages, depth 1 → root + each linked page once, unreadable link reported', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/103/Architecture+Overview'));
  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, { mode: 'linked', linkDepth: 1, root: { id: '103', type: 'page', title: TITLES[103] } }),
  );
  // 102 is linked twice (smart link + plain URL), 106 via a tiny link, 501 lives in a folder;
  // external, attachment, Jira, people and mailto links are not followed.
  expect(job.pages.map((p) => p.id)).toEqual(['103', '102', '106', '501']);
  expect(job.pages.map((p) => p.reason)).toEqual(['root', 'linked', 'linked', 'linked']);
  expect(job.warnings?.join(' ')).toMatch(/104/);
  // "Release Notes" has an attachment that 404s: placeholder, reported as degraded (not fatal).
  expect(job.errors).toEqual([expect.objectContaining({ title: 'Images', severity: 'degraded', message: expect.stringMatching(/^1 image could not be loaded/) })]);
  const pdf = await loadPdf(file.bytes);
  expect(pageTree(readOutline(pdf), Object.values(TITLES))).toEqual([
    ['Architecture Overview', [['Getting Started', []], ['Release Notes', []], ['API Design', []]]],
  ]);
  // The preview could tell same-titled pages apart: linked pages carry their breadcrumb.
  expect(job.pages.find((p) => p.id === '102')?.breadcrumb).toEqual(['Test Home', 'Engineering Handbook']);
  const l = links(pdf);
  expect(l.dests).toEqual(expect.arrayContaining(['p-102', 'p-106', 'p-501']));
  const dests = namedDestinations(pdf);
  for (const d of l.dests) expect(dests).toContain(d);
});

test('(e) separate files → ZIP with one valid PDF per page', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, {
      mode: 'subtree',
      depth: 'all',
      root: { id: '101', type: 'page', title: TITLES[101] },
      options: options({ separateFiles: true }),
    }),
  );
  expect(job.result!.filename).toBe(`TEST_Engineering Handbook_${today()}.zip`);
  expect(file.mime).toBe('application/zip');
  const entries = unzipSync(file.bytes);
  const names = Object.keys(entries).sort();
  expect(names).toEqual(['1_Engineering Handbook.pdf', '2_Getting Started.pdf', '3_Local Setup.pdf', '4_Architecture Overview.pdf']);
  for (const name of names) {
    const pdf = await loadPdf(entries[name]);
    const title = name.replace(/^\d+_/, '').replace(/\.pdf$/, '');
    expect(pdf.getTitle()).toBe(title);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(outlineTitles(readOutline(pdf))[0]).toBe(title);
  }
  expect(job.errors).toEqual([expect.objectContaining({ pageId: '104', severity: 'skipped' })]);
});

test('(f) cancel while fetching → cancelled within 2.5 s, no worker tab, no debugger session; next export works', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  cloud.config.delayMs = 4000; // slow page bodies
  const jobId = await ext.startJob(
    cloudRequest(cloud, { mode: 'subtree', depth: 'all', root: { id: '101', type: 'page', title: TITLES[101] } }),
  );
  await ext.waitForJob(jobId, ['fetching'], 30_000);
  expect((await ext.workerTabUrls()).length).toBe(1);
  const t0 = Date.now();
  await ext.call({ type: 'job/cancel', jobId });
  const job = await ext.waitForJob(jobId, ['cancelled'], 5_000);
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(job.result).toBeUndefined();
  await expect.poll(() => ext.workerTabUrls(), { timeout: 3000 }).toEqual([]);
  expect(await ext.debuggerAttachedTabs()).toEqual([]);

  cloud.config.delayMs = 0;
  const again = await exportAndRead(ext, cloudRequest(cloud, { mode: 'current', root: { id: '106', type: 'page', title: TITLES[106] } }));
  expect((await loadPdf(again.file.bytes)).getTitle()).toBe('Release Notes');
});

test('(f2) cancel while assembling (images still loading) → cancelled, tabs closed, debugger free', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/103/Architecture+Overview'));
  cloud.config.imageDelayMs = 8000;
  const jobId = await ext.startJob(cloudRequest(cloud, { mode: 'current', root: { id: '103', type: 'page', title: TITLES[103] } }));
  await ext.waitForJob(jobId, ['rendering'], 30_000);
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  await ext.call({ type: 'job/cancel', jobId });
  await ext.waitForJob(jobId, ['cancelled'], 5_000);
  expect(Date.now() - t0).toBeLessThan(2500);
  await expect.poll(() => ext.workerTabUrls(), { timeout: 3000 }).toEqual([]);
  expect(await ext.debuggerAttachedTabs()).toEqual([]);
});

test('(g) preview page: lists the tree, unchecking a page leaves it out, Export produces the PDF', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const request = cloudRequest(cloud, { mode: 'subtree', depth: 'all', root: { id: '101', type: 'page', title: TITLES[101] } });
  const preview = await ext.context.newPage();
  await preview.goto(ext.url(`preview.html?req=${encodeRequestParam(request)}`));

  const rows = preview.locator('ul.rows .row-title');
  await expect(rows).toHaveText(['Engineering Handbook', 'Getting Started', 'Local Setup', 'Architecture Overview', 'Secret Plans']);
  await expect(preview.getByText(/archived item was excluded/)).toBeVisible();

  await preview.locator('li', { hasText: 'Local Setup' }).locator('input[type="checkbox"]').first().uncheck();
  await expect(preview.getByText('4 pages selected')).toBeVisible();
  await preview.getByRole('button', { name: 'Export PDF' }).click();

  await expect(preview).toHaveURL(/\?job=/);
  const jobId = new URL(preview.url()).searchParams.get('job')!;
  const job = await ext.waitForJob(jobId);
  expect(job.status).toBe('done');
  expect(job.pages.map((p) => p.id)).toEqual(['101', '102', '103', '104']);
  await expect(preview.getByText(job.result!.filename)).toBeVisible();

  const pdf = await loadPdf((await ext.download(job.result!.downloadId!)).bytes);
  expect(pageTree(readOutline(pdf), Object.values(TITLES))).toEqual([
    ['Engineering Handbook', [['Getting Started', []], ['Architecture Overview', []]]],
  ]);
});

test('(g2) popup: probes the active Confluence tab and exports "This page"', async ({ ext, cloud }) => {
  const source = await ext.openPage(cloud.url('/spaces/TEST/pages/106/Release+Notes'));
  const popup = await ext.context.newPage();
  // The popup reads the *active* tab of its window: keep the Confluence page in front and load
  // the popup document in a background tab of the same window.
  await source.bringToFront();
  await popup.goto(ext.url('popup.html'));
  await expect(popup.locator('.ctx-title')).toHaveText('Release Notes');
  await expect(popup.locator('.ctx-meta')).toContainText('Space TEST');
  await expect(popup.getByRole('radio', { name: 'This page', exact: true })).toBeChecked();
  await popup.getByRole('button', { name: 'Export PDF' }).click();
  await expect(popup.getByText(/Release Notes_\d{4}-\d{2}-\d{2}\.pdf/)).toBeVisible({ timeout: 30_000 });

  const [latest] = await ext.call<ExportJobState[]>({ type: 'job/list' });
  expect(latest.status).toBe('done');
  expect(latest.request.root.id).toBe('106');
  expect(latest.request.userDisplayName).toBe('Erin Example');
  expect(latest.request.site).toMatchObject({ origin: cloud.origin, baseUrl: cloud.baseUrl, contextPath: '/wiki', flavour: 'cloud' });
});

test('(h) Data Center (/confluence, v1 only): subtree export in sidebar order', async ({ ext, dc }) => {
  await ext.openPage(dc.url('/display/DOC/DC+Home'));
  const { job, file } = await exportAndRead(ext, {
    site: dcSite(dc),
    mode: 'subtree',
    depth: 'all',
    root: { id: '2001', type: 'page', title: 'DC Home', spaceKey: 'DOC' },
    options: options(),
    userDisplayName: 'Dana Datacenter',
  });
  expect(job.pages.map((p) => p.id)).toEqual(['2001', '2003', '2004', '2002']);
  expect(job.errors).toEqual([]);
  expect(job.result!.filename).toBe(`DOC_DC Home_${today()}.pdf`);
  const pdf = await loadPdf(file.bytes);
  expect(pageTree(readOutline(pdf), ['DC Home', 'DC Child B', 'DC Grandchild', 'DC Child A'])).toEqual([
    ['DC Home', [['DC Child B', [['DC Grandchild', []]]], ['DC Child A', []]]],
  ]);
  expect(pdf.getAuthor()).toBe('Dana Datacenter');
  // Link from the home page to an exported page (DC /display/ URL) became an internal link.
  expect(links(pdf).dests).toContain('p-2003');
  // v1 only, under the context path; nothing asked the v2 API.
  expect(dc.log.filter((r) => r.path.includes('/api/v2/'))).toEqual([]);
  expect(dc.log.some((r) => r.path.startsWith('/confluence/download/attachments/2001/logo.png') && r.cookie)).toBe(true);
  expectReadOnlyWithCookies(dc);
});

test('(h2) Data Center popup probe: detects flavour, context path and page from metas', async ({ ext, dc }) => {
  const source = await ext.openPage(dc.url('/pages/viewpage.action?pageId=2003'));
  const popup = await ext.context.newPage();
  await source.bringToFront();
  await popup.goto(ext.url('popup.html'));
  await expect(popup.locator('.ctx-title')).toHaveText('DC Child B');
  await expect(popup.locator('.ctx-meta')).toContainText('Space DOC');
  await popup.getByRole('radio', { name: 'This page', exact: true }).check();
  await popup.getByRole('button', { name: 'Export PDF' }).click();
  await expect(popup.getByText(/DOC_DC Child B_\d{4}-\d{2}-\d{2}\.pdf/)).toBeVisible({ timeout: 30_000 });
  const [latest] = await ext.call<ExportJobState[]>({ type: 'job/list' });
  expect(latest.request.site).toMatchObject({ origin: dc.origin, baseUrl: dc.baseUrl, contextPath: '/confluence', flavour: 'server' });
  expect(latest.request.userDisplayName).toBe('Dana Datacenter');
});

test('(i) logged out → clear error, no download, no tab left', async ({ ext, cloud }) => {
  await ext.context.clearCookies();
  const jobId = await ext.startJob(cloudRequest(cloud, { mode: 'current', root: { id: '103', type: 'page', title: TITLES[103] } }));
  const job = await ext.waitForJob(jobId);
  expect(job.status).toBe('error');
  expect(job.message).toMatch(/log in/i);
  expect(job.result).toBeUndefined();
  expect(await ext.workerTabUrls()).toEqual([]);
});

/** Bookmarks of a PDF page: the font resources prove pdf-lib stamped "n / N" (standard Helvetica). */
function hasStampFont(pdf: Awaited<ReturnType<typeof loadPdf>>, pageIndex: number): boolean {
  const page = pdf.getPage(pageIndex);
  const fonts = page.node.Resources()?.lookup(PDFName.of('Font'));
  if (!(fonts instanceof PDFDict)) return false;
  return fonts.values().some((ref) => {
    const f = pdf.context.lookup(ref);
    return f instanceof PDFDict && String(f.get(PDFName.of('BaseFont'))) === '/Helvetica';
  });
}

test('(j) live render: the real page is printed and inserted after its header, numbers stamped', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/108/System+Diagram'));
  const request = cloudRequest(cloud, {
    mode: 'current',
    root: { id: '108', type: 'page', title: 'System Diagram' },
    options: options({ liveRender: true }),
  });
  const live = await exportAndRead(ext, request);
  expect(live.job.errors).toEqual([]);
  const pdf = await loadPdf(live.file.bytes);
  expect(pdf.getPageCount()).toBe(live.job.result!.sheetCount);
  // The inserted sheets come from the real page after its script drew the diagram.
  expect(links(pdf).uris).toContain('https://live.example/rendered-diagram');
  expect(outlineTitles(readOutline(pdf))[0]).toBe('System Diagram');
  // Several prints were combined: Chrome's footer was off and pdf-lib stamped page numbers,
  // on every sheet but the cover.
  expect(hasStampFont(pdf, 0), 'cover not numbered').toBe(false);
  for (let i = 1; i < pdf.getPageCount(); i++) expect(hasStampFont(pdf, i), `sheet ${i + 1} stamped`).toBe(true);
  // No live-render tab left behind.
  const tabs = (await ext.driver.evaluate(() => chrome.tabs.query({}))) as chrome.tabs.Tab[];
  expect(tabs.filter((t) => t.url?.includes('/pages/108/')).length).toBe(1); // only the user's tab

  // Same page without live render: static placeholder, fewer sheets, no diagram link.
  const stat = await exportAndRead(ext, { ...request, options: options({ liveRender: false }) });
  const statPdf = await loadPdf(stat.file.bytes);
  expect(links(statPdf).uris).not.toContain('https://live.example/rendered-diagram');
});

test('(k) more pages than the print batch size → batches merged, bookmarks and anchors kept, numbers stamped', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/600/Big+Manual'));
  await ext.driver.evaluate(() => chrome.storage.sync.set({ settings: { printBatchSize: 10 } }));
  try {
    const { job, file } = await exportAndRead(
      ext,
      cloudRequest(cloud, { mode: 'subtree', depth: 'all', root: { id: '600', type: 'page', title: 'Big Manual' } }),
    );
    const titles = ['Big Manual', ...Array.from({ length: 12 }, (_, i) => `Chapter ${i + 1}`)];
    expect(job.pages.map((p) => p.title)).toEqual(titles);
    expect(job.errors).toEqual([]);
    const pdf = await loadPdf(file.bytes);
    expect(pdf.getPageCount()).toBe(job.result!.sheetCount);
    expect(pageTree(readOutline(pdf), titles)).toEqual([['Big Manual', titles.slice(1).map((t): PageTree => [t, []])]]);
    const dests = namedDestinations(pdf);
    for (let id = 600; id <= 612; id++) expect(dests).toContain(`p-${id}`);
    // TOC entries and links to pages printed in the second batch survive the merge, and every
    // internal link resolves to the real section (not to a placeholder in the first batch).
    const l = links(pdf);
    for (const id of [610, 611, 612]) expect(l.dests).toContain(`p-${id}`);
    for (const d of l.dests) expect(dests).toContain(d);
    const lastSheet = pdf.getPageCount() - 1;
    const destPage = (name: string) => {
      const arr = (pdf.catalog.lookup(PDFName.of('Dests')) as PDFDict).lookup(PDFName.of(name)) as PDFArray;
      return pdf.getPages().findIndex((p) => p.ref === arr.get(0));
    };
    expect(destPage('p-612')).toBe(lastSheet);
    expect(destPage('p-610')).toBeLessThan(destPage('p-611'));
    for (let i = 1; i < pdf.getPageCount(); i++) expect(hasStampFont(pdf, i), `sheet ${i + 1} stamped`).toBe(true);
  } finally {
    await ext.driver.evaluate(() => chrome.storage.sync.remove('settings'));
  }
});

test('(l) entire space → every root and descendant in sidebar order, titled after the space', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/overview'));
  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, { mode: 'space', depth: 'all', root: { id: '100', type: 'page', title: 'Test Home', spaceId: '9001' } }),
  );
  const ids = job.pages.map((p) => p.id);
  expect(ids.slice(0, 12)).toEqual(['100', '101', '102', '105', '103', '104', '106', '108', '109', '500', '501', '502']);
  expect(ids.slice(12)).toEqual(Array.from({ length: 13 }, (_, i) => String(600 + i)));
  expect(job.errors).toEqual([
    expect.objectContaining({ pageId: '104', severity: 'skipped' }),
    expect.objectContaining({ title: 'Images', severity: 'degraded' }),
  ]);
  expect(job.result!.filename).toBe(`TEST_Test Space_${today()}.pdf`);
  const pdf = await loadPdf(file.bytes);
  expect(pdf.getTitle()).toBe('Test Space');
  // One bookmark per exported page (the skipped one has none), nested under the space home.
  const exported = job.pages.filter((p) => p.id !== '104').map((p) => p.title);
  expect(flatTitles(readOutline(pdf)).filter((t) => exported.includes(t))).toEqual(exported);
  expect(outlineTitles(readOutline(pdf))).toEqual(['Test Home']);
});

test('(m) manual selection: pages from different branches come out in tree order', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/100/Test+Home'));
  const request = cloudRequest(cloud, {
    mode: 'selection',
    root: { id: '100', type: 'page', title: 'Test Home', spaceId: '9001' },
    selectedIds: ['502', '105', '106'],
  });
  const preview = await ext.context.newPage();
  await preview.goto(ext.url(`preview.html?req=${encodeRequestParam(request)}`));
  // Lazy tree: only the space root is loaded, yet the preselected (deeper) pages stay selected.
  const home = preview.getByRole('treeitem', { name: 'Test Home' });
  await expect(home).toHaveAttribute('aria-expanded', 'false');
  await expect(preview.locator('.action-bar .summary')).toHaveText('3 items selected');
  // Expanding loads the next level; a preselected child shows up checked.
  await home.locator('button.twisty').click();
  await expect(preview.getByRole('treeitem', { name: 'Release Notes' })).toHaveAttribute('aria-checked', 'true');
  await expect(preview.getByRole('treeitem', { name: 'Engineering Handbook' })).toHaveAttribute('aria-checked', 'false');
  await expect(preview.locator('.action-bar .summary')).toHaveText('3 items selected');
  await preview.getByRole('button', { name: 'Review selection' }).click();
  await expect(preview.locator('ul.rows .row-title')).toHaveText(['Local Setup', 'Release Notes', 'UI Guidelines']);
  await preview.getByRole('button', { name: 'Export PDF' }).click();
  await expect(preview).toHaveURL(/\?job=/);
  const job = await ext.waitForJob(new URL(preview.url()).searchParams.get('job')!);
  expect(job.status).toBe('done');
  expect(job.pages.map((p) => p.id)).toEqual(['105', '106', '502']);
});

test('(n) two exports at the same time → both finish with the right content', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const [a, b] = await Promise.all([
    ext.startJob(cloudRequest(cloud, { mode: 'subtree', depth: 'all', root: { id: '101', type: 'page', title: TITLES[101] } })),
    ext.startJob(cloudRequest(cloud, { mode: 'folder', depth: 'all', root: { id: '500', type: 'folder', title: TITLES[500] } })),
  ]);
  const [ja, jb] = await Promise.all([ext.waitForJob(a), ext.waitForJob(b)]);
  expect([ja.status, jb.status], `${ja.message} / ${jb.message}`).toEqual(['done', 'done']);
  const [fa, fb] = await Promise.all([ext.download(ja.result!.downloadId!), ext.download(jb.result!.downloadId!)]);
  expect(pageTree(readOutline(await loadPdf(fa.bytes)), Object.values(TITLES))).toEqual([
    ['Engineering Handbook', [['Getting Started', [['Local Setup', []]]], ['Architecture Overview', []]]],
  ]);
  expect(pageTree(readOutline(await loadPdf(fb.bytes)), Object.values(TITLES))).toEqual([['Design Docs', [['API Design', []], ['UI Guidelines', []]]]]);
  await expect.poll(() => ext.workerTabUrls(), { timeout: 3000 }).toEqual([]);
  expect(await ext.debuggerAttachedTabs()).toEqual([]);
});

test('(g3) popup multi-page mode → page count, then the preview tab opens with the list', async ({ ext, cloud }) => {
  const source = await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const popup = await ext.context.newPage();
  await source.bringToFront();
  await popup.goto(ext.url('popup.html'));
  await expect(popup.locator('.ctx-title')).toHaveText('Engineering Handbook');
  await popup.getByRole('radio', { name: 'This page + children' }).check();
  const previewButton = popup.getByRole('button', { name: /^Preview/ });
  await expect(previewButton).toHaveText(/Preview \(5 pages\)/);
  const listings = () => cloud.log.filter((r) => r.path.startsWith('/wiki/api/v2/pages/101/descendants')).length;
  const counted = listings();
  const [preview] = await Promise.all([ext.context.waitForEvent('page'), previewButton.click()]);
  await preview.waitForURL(/preview\.html\?req=/);
  await expect(preview.locator('ul.rows .row-title')).toHaveText(['Engineering Handbook', 'Getting Started', 'Local Setup', 'Architecture Overview', 'Secret Plans']);
  // The preview reused the popup's collection instead of listing the tree again.
  expect(listings()).toBe(counted);
  // FR-7: rows carry their breadcrumb (shown, and searchable, when the list is filtered).
  await preview.getByLabel('Filter pages by title').fill('Getting Started');
  await expect(preview.locator('ul.rows li', { hasText: 'Local Setup' }).locator('.row-crumb')).toHaveText(
    'Test Home › Engineering Handbook › Getting Started',
  );
});

test('(o) hostile export_view: no injection vector runs in the worker tab, no foreign requests', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/100/Test+Home'));
  const foreign: string[] = [];
  const onRequest = (r: Request) => {
    const u = r.url();
    if (!u.startsWith(cloud.origin) && !/^(chrome-extension|data|blob):/.test(u)) foreign.push(u);
  };
  ext.context.on('request', onRequest);
  const { job, file } = await exportAndRead(ext, cloudRequest(cloud, { mode: 'current', root: { id: '109', type: 'page', title: 'Hostile Page' } }));
  ext.context.off('request', onRequest);
  // Give any deferred payload (timers, focus, toggle events) a moment to fire.
  await new Promise((r) => setTimeout(r, 500));
  expect(cloud.log.filter((r) => r.path.includes('__pwned'))).toEqual([]);
  expect(foreign).toEqual([]);
  expect(job.status).toBe('done');
  const pdf = await loadPdf(file.bytes);
  expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  expect(links(pdf).uris.filter((u) => /^\s*(java\s*script|data):/i.test(u))).toEqual([]);
});

test('(p) session expires mid-export → clear sign-in error, no file', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/600/Big+Manual'));
  cloud.config.delayMs = 1500; // slow bodies: the first ones are in flight when the session ends
  const jobId = await ext.startJob(cloudRequest(cloud, { mode: 'subtree', depth: 'all', root: { id: '600', type: 'page', title: 'Big Manual' } }));
  await ext.waitForJob(jobId, ['fetching'], 30_000);
  await ext.context.clearCookies();
  const job = await ext.waitForJob(jobId);
  expect(job.status).toBe('error');
  expect(job.message).toMatch(/session has expired|sign in/i);
  expect(job.result).toBeUndefined();
  // Not reported as a pile of per-page "no permission" errors.
  expect(job.errors.filter((e) => /permission/i.test(e.message))).toEqual([]);
  await expect.poll(() => ext.workerTabUrls(), { timeout: 3000 }).toEqual([]);
});

test('(s) public site, not signed in: anonymous export works, a network failure skips one page instead of failing', async ({ ext, cloud }) => {
  await ext.context.clearCookies();
  cloud.config.publicAccess = true;
  // "Getting Started": every attempt of its body request fails at the network level (Chrome
  // itself retries a reset connection, so drop more than our own two attempts).
  cloud.config.dropPath = '/wiki/api/v2/pages/102?body-format=export_view';
  cloud.config.dropCount = 20;
  const { job, file } = await exportAndRead(
    ext,
    cloudRequest(cloud, { mode: 'subtree', depth: 'all', userDisplayName: undefined, root: { id: '101', type: 'page', title: TITLES[101] } }),
  );
  // 102 failed (network), 104 is not public: both skipped, the export finished.
  expect(job.errors.map((e) => e.pageId).sort()).toEqual(['102', '104']);
  expect(job.errors.find((e) => e.pageId === '104')?.message).toMatch(/isn't public/);
  expect(job.message).not.toMatch(/log in|sign in/i);
  const pdf = await loadPdf(file.bytes);
  expect(pdf.getAuthor()).toBeUndefined();
  // "Local Setup" takes the place of its skipped parent "Getting Started".
  expect(pageTree(readOutline(pdf), Object.values(TITLES))).toEqual([['Engineering Handbook', [['Local Setup', []], ['Architecture Overview', []]]]]);
  // Nothing was sent with a session cookie: this really was anonymous.
  expect(cloud.log.filter((r) => /\/(rest\/api|api\/v2)\//.test(r.path) && r.cookie)).toEqual([]);
});

test('(r) preview: collecting can be cancelled, and closing the preview closes its helper tab', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  cloud.config.delayMs = 1500;
  const request = cloudRequest(cloud, { mode: 'linked', linkDepth: 1, root: { id: '103', type: 'page', title: TITLES[103] } });
  const preview = await ext.context.newPage();
  await preview.goto(ext.url(`preview.html?req=${encodeRequestParam(request)}`));
  await preview.getByRole('button', { name: 'Cancel' }).click();
  await expect(preview.getByText('Collecting pages was cancelled.')).toBeVisible();
  cloud.config.delayMs = 0;
  await preview.getByRole('button', { name: 'Retry' }).click();
  await expect(preview.locator('ul.rows .row-title').first()).toHaveText('Architecture Overview');
  expect((await ext.workerTabUrls()).length).toBeGreaterThanOrEqual(1);
  await preview.close();
  await expect.poll(() => ext.workerTabUrls(), { timeout: 15_000 }).toEqual([]);
});
