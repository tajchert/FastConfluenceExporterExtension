/// <reference types="node" />
/**
 * End-to-end: Markdown and plain-text exports (options.format) against the mock Confluence.
 * Same pipeline up to the fetch; then the worker tab converts (lib/convert), downloads images
 * for Markdown, and the service worker saves one document or a ZIP. Nothing is printed, so the
 * debugger must never be attached.
 */
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { ExportRequest } from '../../lib/types';
import { cloudSite, expect, options, test, type ExtensionHarness } from './fixtures';
import type { MockConfluence } from './mock-confluence/server.mjs';

/** Local date, like the filenames (`buildFilename`); `toISOString()` is UTC and differs near midnight. */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const decode = (b: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(b);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function cloudRequest(cloud: MockConfluence, over: Partial<ExportRequest> & Pick<ExportRequest, 'mode' | 'root'>): ExportRequest {
  return {
    site: cloudSite(cloud),
    options: options(),
    userDisplayName: 'Erin Example',
    ...over,
    root: { spaceKey: 'TEST', ...over.root },
  };
}

/** Counts chrome.debugger.attach calls made by the service worker from now on. */
async function spyOnDebugger(ext: ExtensionHarness): Promise<() => Promise<number>> {
  await ext.serviceWorker.evaluate(() => {
    const g = globalThis as unknown as { __cfpAttachCalls?: number; __cfpAttachSpy?: boolean };
    g.__cfpAttachCalls = 0;
    if (g.__cfpAttachSpy) return;
    g.__cfpAttachSpy = true;
    const original = chrome.debugger.attach.bind(chrome.debugger);
    (chrome.debugger as { attach: unknown }).attach = (...args: Parameters<typeof chrome.debugger.attach>) => {
      g.__cfpAttachCalls = (g.__cfpAttachCalls ?? 0) + 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  });
  return () => ext.serviceWorker.evaluate(() => (globalThis as unknown as { __cfpAttachCalls?: number }).__cfpAttachCalls ?? 0);
}

/** Markdown link / image targets that are not absolute URLs, mail links or in-document anchors. */
function relativeTargets(md: string): string[] {
  const out: string[] = [];
  for (const m of md.matchAll(/\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let t = m[1];
    if (t.startsWith('<')) t = t.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#')) continue;
    out.push(decodeURIComponent(t.split('#')[0]));
  }
  for (const m of md.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(m[1])) out.push(decodeURIComponent(m[1]));
  }
  return out.filter((t) => t !== '');
}

test('(md1) Markdown, one page, images not bundled → one .md file, GFM content, no debugger', async ({ ext, cloud }) => {
  const source = await ext.openPage(cloud.url('/spaces/TEST/pages/103/Architecture+Overview'));
  await source.close(); // its own image requests are not the export's
  const logStart = cloud.log.length;
  const attachCalls = await spyOnDebugger(ext);
  const { job, file } = await ext.exportAndDownload(
    cloudRequest(cloud, {
      mode: 'current',
      root: { id: '103', type: 'page', title: 'Architecture Overview' },
      options: options({ format: 'markdown', downloadImages: false }),
    }),
  );
  expect(job.errors).toEqual([]);
  expect(job.result!.filename).toBe(`TEST_Architecture Overview_${today()}.md`);
  expect(path.basename(file.filename)).toBe(job.result!.filename);
  expect(file.mime).toMatch(/^text\/markdown/);

  const md = decode(file.bytes);
  // Cover → YAML front matter; the page title as a level-1 heading.
  expect(md.startsWith('---\n')).toBe(true);
  expect(md).toMatch(/^title: .*Architecture Overview/m);
  expect(md).toMatch(/^# Architecture Overview$/m);
  // Content: demoted headings, fenced Java code, panels, expand, GFM table, iframe placeholder link.
  // (Linked headings carry an explicit anchor: `## <a id="p103-…"></a>Components`.)
  expect(md).toMatch(/^## (<a id="p103-[^"]+"><\/a>)?Components$/m);
  // Same-page anchors work: every in-document link has a target.
  for (const [, target] of md.matchAll(/\]\(#([^)]+)\)/g)) expect(md).toContain(`<a id="${target}"></a>`);
  expect(md).toMatch(/^```+java$/m);
  expect(md).toContain('public class Gateway {');
  expect(md).toMatch(/\*\*Info:\*\*/);
  expect(md).toMatch(/\*\*Warning:\*\*/);
  expect(md).toContain('<details>');
  expect(md).toContain('Hidden details that must be printed.');
  expect(md).toMatch(/^\|\s*Component\s*\|\s*Owner\s*\|$/m);
  expect(md).toMatch(/^\|\s*Gateway\s*\|\s*Team Blue\s*\|$/m);
  expect(md).toContain('https://www.example.com/embed/video');
  // Images keep their absolute Confluence URLs; scripts never make it into the output.
  expect(md).toMatch(/!\[[^\]]*\]\(<?http:\/\/127\.0\.0\.1:\d+\/wiki\/download\/attachments\/103\/diagram\.png/);
  expect(md).not.toContain('<script');
  expect(md).not.toContain('__cfpInjected');
  expect(md.endsWith('\n')).toBe(true);
  expect(md).not.toMatch(/\n{4,}/);

  expect(await attachCalls()).toBe(0);
  expect(await ext.debuggerAttachedTabs()).toEqual([]);
  expect(await ext.workerTabUrls()).toEqual([]);
  // Images were not downloaded.
  expect(cloud.log.slice(logStart).filter((r) => r.path.startsWith('/wiki/download/attachments/'))).toEqual([]);
});

test('(md2) Markdown with images → ZIP: the .md plus assets/…, every relative reference resolves', async ({ ext, cloud }) => {
  const source = await ext.openPage(cloud.url('/spaces/TEST/pages/103/Architecture+Overview'));
  await source.close();
  const logStart = cloud.log.length;
  const attachCalls = await spyOnDebugger(ext);
  const { job, file } = await ext.exportAndDownload(
    cloudRequest(cloud, {
      mode: 'current',
      root: { id: '103', type: 'page', title: 'Architecture Overview' },
      options: options({ format: 'markdown', downloadImages: true }),
    }),
  );
  expect(job.errors).toEqual([]);
  expect(job.result!.filename).toBe(`TEST_Architecture Overview_${today()}.zip`);
  expect(file.mime).toBe('application/zip');
  const entries = unzipSync(file.bytes);
  const names = Object.keys(entries);
  const mdName = `TEST_Architecture Overview_${today()}.md`;
  expect(names).toContain(mdName);
  const assets = names.filter((n) => n.startsWith('assets/'));
  expect(assets).toEqual([expect.stringMatching(/^assets\/103\/diagram.*\.png$/)]);
  expect([...entries[assets[0]].slice(0, 4)]).toEqual(PNG_SIGNATURE);

  const md = decode(entries[mdName]);
  const refs = relativeTargets(md);
  expect(refs).toContain(assets[0]);
  for (const r of refs) expect(names, `reference ${r}`).toContain(r);
  // The attachment was fetched by the worker tab with the session cookie.
  // The attachment was fetched once (by the download, not by the conversion), with the session cookie.
  const imageRequests = cloud.log.slice(logStart).filter((r) => r.path.startsWith('/wiki/download/attachments/'));
  expect(imageRequests).toEqual([expect.objectContaining({ cookie: true, path: expect.stringMatching(/^\/wiki\/download\/attachments\/103\/diagram\.png/) })]);
  expect([...new Set(cloud.log.map((r) => r.method))]).toEqual(['GET']);
  expect(await attachCalls()).toBe(0);
});

test('(md3) Markdown with a broken image → degraded, the .md keeps the absolute URL', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/106/Release+Notes'));
  const { job, file } = await ext.exportAndDownload(
    cloudRequest(cloud, {
      mode: 'current',
      root: { id: '106', type: 'page', title: 'Release Notes' },
      options: options({ format: 'markdown', downloadImages: true, includeCover: false }),
    }),
  );
  expect(job.errors).toEqual([expect.objectContaining({ title: 'Images', severity: 'degraded', message: expect.stringMatching(/1 image could not be downloaded \(HTTP 404\)/) })]);
  // Nothing was downloaded, so there is nothing to bundle: a plain .md file.
  expect(job.result!.filename).toBe(`TEST_Release Notes_${today()}.md`);
  const md = decode(file.bytes);
  expect(md).toMatch(/\(<?http:\/\/127\.0\.0\.1:\d+\/wiki\/download\/attachments\/106\/missing-screenshot\.png/);
  expect(relativeTargets(md)).toEqual([]);
});

test('(txt1) plain text, subtree → one .txt in tree order, readable, no HTML, no debugger', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const attachCalls = await spyOnDebugger(ext);
  const { job, file } = await ext.exportAndDownload(
    cloudRequest(cloud, {
      mode: 'subtree',
      depth: 'all',
      root: { id: '101', type: 'page', title: 'Engineering Handbook' },
      options: options({ format: 'text' }),
    }),
  );
  expect(job.result!.filename).toBe(`TEST_Engineering Handbook_${today()}.txt`);
  expect(file.mime).toMatch(/^text\/plain/);
  expect(job.errors).toEqual([expect.objectContaining({ pageId: '104', severity: 'skipped' })]);

  const txt = decode(file.bytes);
  expect(txt).not.toMatch(/<\/?(p|div|span|table|a|img|script)\b/i);
  expect(txt).not.toContain('\r');
  expect(txt).not.toContain('\f');
  // Every page title is underlined with "=" of the same width, in page-tree order.
  const titles = ['Engineering Handbook', 'Getting Started', 'Local Setup', 'Architecture Overview'];
  const positions = titles.map((t) => {
    const m = new RegExp(`^${t}\\n(=+)$`, 'm').exec(txt);
    expect(m, `title ${t}`).not.toBeNull();
    expect(m![1].length).toBe(t.length);
    return m!.index;
  });
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(txt).not.toContain('Secret Plans\n=');
  expect(txt).toContain('Handbook root page.');
  // Pages are separated by a line of 72 "=".
  expect(txt).toContain(`\n${'='.repeat(72)}\n`);
  // The code block is indented by 4 spaces; the table cells are on aligned rows.
  expect(txt).toMatch(/^ {4}public class Gateway \{$/m);
  expect(txt).toMatch(/^.*Gateway\s+.*Team Blue\s*$/m);
  expect(await attachCalls()).toBe(0);
  expect(await ext.debuggerAttachedTabs()).toEqual([]);
});

test('(md4) separate Markdown files → ZIP with NN- files in tree order, links between pages resolve', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/101/Engineering+Handbook'));
  const attachCalls = await spyOnDebugger(ext);
  const { job, file } = await ext.exportAndDownload(
    cloudRequest(cloud, {
      mode: 'subtree',
      depth: 'all',
      root: { id: '101', type: 'page', title: 'Engineering Handbook' },
      options: options({ format: 'markdown', separateFiles: true, includeToc: true }),
    }),
  );
  expect(job.result!.filename).toBe(`TEST_Engineering Handbook_${today()}.zip`);
  const entries = unzipSync(file.bytes);
  const names = Object.keys(entries);
  const docs = names.filter((n) => n.endsWith('.md')).sort();
  expect(docs).toEqual([
    '00-Contents.md',
    '01-Engineering Handbook.md',
    '02-Getting Started.md',
    '03-Local Setup.md',
    '04-Architecture Overview.md',
  ]);
  expect(names.filter((n) => n.startsWith('assets/'))).toEqual([expect.stringMatching(/^assets\/103\/diagram.*\.png$/)]);
  for (const doc of docs) {
    const refs = relativeTargets(decode(entries[doc]));
    for (const r of refs) expect(names, `${doc} → ${r}`).toContain(r);
  }
  // The contents file links every page; "Architecture Overview" links "Getting Started" as a file.
  expect(relativeTargets(decode(entries['00-Contents.md']))).toEqual(expect.arrayContaining(docs.slice(1)));
  expect(relativeTargets(decode(entries['04-Architecture Overview.md']))).toContain('02-Getting Started.md');
  expect(await attachCalls()).toBe(0);
});

test('(md5) sanity: the debugger spy does see a PDF export attach', async ({ ext, cloud }) => {
  await ext.openPage(cloud.url('/spaces/TEST/pages/102/Getting+Started'));
  const attachCalls = await spyOnDebugger(ext);
  const { job } = await ext.exportAndDownload(
    cloudRequest(cloud, { mode: 'current', root: { id: '105', type: 'page', title: 'Local Setup' } }),
  );
  expect(job.result!.filename).toMatch(/\.pdf$/);
  expect(await attachCalls()).toBeGreaterThan(0);
});

test('(md6) popup: the format switch applies to this export only (Text → .txt), defaults unchanged', async ({ ext, cloud }) => {
  const source = await ext.openPage(cloud.url('/spaces/TEST/pages/105/Local+Setup'));
  const popup = await ext.context.newPage();
  await source.bringToFront();
  await popup.goto(ext.url('popup.html'));
  await expect(popup.locator('.ctx-title')).toHaveText('Local Setup');
  await expect(popup.getByRole('radio', { name: 'PDF', exact: true })).toBeChecked();
  await expect(popup.getByText('Live render (slow)')).toBeVisible();
  await popup.getByRole('radio', { name: 'Text', exact: true }).check();
  // Live render is PDF-only: hidden for text.
  await expect(popup.getByText('Live render (slow)')).toHaveCount(0);
  await popup.getByRole('button', { name: 'Export text' }).click();
  await expect(popup.getByText(/Local Setup_\d{4}-\d{2}-\d{2}\.txt/)).toBeVisible({ timeout: 30_000 });
  const [latest] = await ext.call<{ request: ExportRequest; status: string }[]>({ type: 'job/list' });
  expect(latest.status).toBe('done');
  expect(latest.request.options.format).toBe('text');
  // The saved default is still PDF.
  const stored = await ext.driver.evaluate(() => chrome.storage.sync.get('settings'));
  expect((stored.settings as { defaults?: { format?: string } } | undefined)?.defaults?.format ?? 'pdf').toBe('pdf');
  await popup.close();
});
