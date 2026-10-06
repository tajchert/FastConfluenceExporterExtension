#!/usr/bin/env node
/**
 * Chrome Web Store screenshots (1280×800, 24-bit PNG) from the real extension, exporting public
 * content of the Apache Software Foundation wiki (https://cwiki.apache.org/confluence, Confluence
 * Data Center, anonymous access). No private or company data is involved.
 *
 *   npm run screenshots        (= npm run build:live && node scripts/store-screenshots.mjs)
 *
 * Writes store/screenshots/01-popup.png … 05-options.png:
 *   01 the popup on the "Community Over Code" home page
 *   02 the preview of that page tree, one page unticked
 *   03 the finished export in the preview tab
 *   04 pages of the resulting PDF (rasterized with pdftoppm from poppler-utils)
 *   05 the options page
 *
 * Needs the live build (.output/chrome-mv3-live, host access to cwiki.apache.org) and
 * Playwright's Chromium (`npx playwright install chromium`). Screenshot 04 needs `pdftoppm`
 * (macOS: `brew install poppler`, Debian/Ubuntu: `apt install poppler-utils`); without it, 04 is
 * skipped with a message. HEADED=1 shows the browser.
 *
 * Be polite: one run makes a few dozen requests to cwiki.apache.org (one page tree of ~8 pages).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_DIR = join(root, '.output', 'chrome-mv3-live');
const OUT_DIR = join(root, 'store', 'screenshots');
const W = 1280;
const H = 800;

const SITE = {
  origin: 'https://cwiki.apache.org',
  baseUrl: 'https://cwiki.apache.org/confluence',
  contextPath: '/confluence',
  flavour: 'server',
  siteTitle: 'Apache Software Foundation',
};
const ROOT = { id: '315494566', type: 'page', title: 'Community Over Code Home', spaceKey: 'COC' };
const PAGE_URL = `${SITE.baseUrl}/spaces/COC/pages/315494566/Community+Over+Code+Home`;
/** No people in marketing shots: the page header's "by {author}" is hidden with custom CSS. */
const HIDE_AUTHOR_CSS = '.cf-author { display: none; }';

const DEFAULT_OPTIONS = {
  paperSize: 'A4',
  orientation: 'portrait',
  marginsMm: { top: 18, right: 15, bottom: 18, left: 15 },
  includeCover: true,
  includeToc: true,
  includePageMeta: true,
  includeComments: false,
  pageNumbers: true,
  liveRender: false,
  separateFiles: false,
  includeArchived: false,
  shrinkWideTables: true,
  customCss: '',
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dataUrl = (png) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function which(cmd) {
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

// ───────────────────────────── composition ─────────────────────────────

const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif`;

function frame({ title, subtitle, body }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
    body{font-family:${FONT};color:#1b1f2a;background:linear-gradient(160deg,#f3f4f8 0%,#e6e9f1 100%);position:relative}
    .cap{position:absolute;left:72px;top:40px;right:72px}
    .cap h1{margin:0;font-size:34px;line-height:1.15;font-weight:750;letter-spacing:-.01em}
    .cap h1 b{color:#4330c9;font-weight:inherit}
    .cap p{margin:8px 0 0;font-size:18px;color:#4b5263}
    .win{position:absolute;left:72px;right:72px;top:150px;bottom:0;border-radius:14px 14px 0 0;overflow:hidden;
      background:#fff;box-shadow:0 24px 60px rgba(25,30,60,.22),0 2px 6px rgba(25,30,60,.12)}
    .bar{height:38px;background:#eceef3;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid #dcdfe7}
    .dot{width:12px;height:12px;border-radius:50%;background:#d3d6de}
    .url{margin-left:14px;flex:1;height:24px;border-radius:12px;background:#fff;color:#5b6273;font-size:12.5px;
      display:flex;align-items:center;padding:0 12px;white-space:nowrap;overflow:hidden}
    .shot{position:absolute;left:0;right:0;top:38px;bottom:0;background-size:100% auto;background-position:top left;background-repeat:no-repeat}
    .popup{position:absolute;right:28px;top:46px;width:360px;border-radius:10px;overflow:hidden;
      box-shadow:0 18px 50px rgba(20,24,50,.35),0 0 0 1px rgba(20,24,50,.08)}
    .popup img{display:block;width:100%}
    .sheets{position:absolute;left:0;right:0;top:150px;bottom:0;display:flex;justify-content:center;gap:34px;align-items:flex-start}
    .sheet{width:auto;height:560px;background:#fff;box-shadow:0 22px 50px rgba(25,30,60,.25),0 1px 3px rgba(25,30,60,.15)}
    .sheet img{display:block;height:100%}
  </style></head><body>
    <div class="cap"><h1>${title}</h1><p>${esc(subtitle)}</p></div>
    ${body}
  </body></html>`;
}

function windowWith(url, shotPng, overlay = '') {
  return `<div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    <span class="url">${esc(url)}</span></div>
    <div class="shot" style="background-image:url('${dataUrl(shotPng)}')"></div>${overlay}</div>`;
}

async function compose(browser, html, file) {
  // A fresh page per image (see scripts/generate-icons.mjs: reused viewports can garble tiles).
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: W, height: H } });
    console.log(`wrote ${file}`);
  } finally {
    await page.close();
  }
}

// ───────────────────────────── extension ─────────────────────────────

async function launchExtension(downloadsDir) {
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    throw new Error(`Build the extension first: npm run build:live (missing ${EXTENSION_DIR})`);
  }
  const userDataDir = mkdtempSync(join(tmpdir(), 'cfp-shots-profile-'));
  mkdirSync(join(userDataDir, 'Default'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true } }),
  );
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    locale: 'en-US',
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;
  const driver = context.pages()[0] ?? (await context.newPage());
  await driver.goto(`chrome-extension://${extensionId}/preview.html`);
  const cdp = await context.newCDPSession(driver);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir });
  await cdp.detach();
  // Gentle on the public wiki, and no system notification in the shots.
  await driver.evaluate((css) =>
    Promise.all([
      chrome.storage.sync.set({ settings: { apiConcurrency: 2, liveRenderConcurrency: 1, notifyOnComplete: false } }),
      chrome.storage.local.set({ customCss: css }),
    ]),
    HIDE_AUTHOR_CSS,
  );
  return { context, driver, url: (p) => `chrome-extension://${extensionId}/${p}`, userDataDir };
}

async function downloadedFile(driver, downloadId) {
  for (let i = 0; i < 200; i++) {
    const [item] = await driver.evaluate((id) => chrome.downloads.search({ id }), downloadId);
    if (item?.state === 'complete' && item.filename && existsSync(item.filename)) return item.filename;
    await sleep(100);
  }
  throw new Error(`download ${downloadId} not found`);
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const downloadsDir = mkdtempSync(join(tmpdir(), 'cfp-shots-downloads-'));
  const ext = await launchExtension(downloadsDir);
  const composer = await chromium.launch({ headless: true });
  const work = mkdtempSync(join(tmpdir(), 'cfp-shots-'));
  try {
    // 01 popup over the Confluence page
    const source = await ext.context.newPage();
    await source.goto(PAGE_URL, { waitUntil: 'load', timeout: 90_000 });
    await source.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    // Marketing shots show no people: hide the byline (and the site's sign-up notice).
    await source.addStyleTag({ content: '#header-precursor, .page-metadata { visibility: hidden !important; }' });
    await sleep(200);
    const pageShot = await source.screenshot();
    const popup = await ext.context.newPage();
    await source.bringToFront();
    await popup.goto(ext.url('popup.html'));
    await popup.locator('.ctx-title').waitFor({ timeout: 60_000 });
    await popup.getByRole('radio', { name: 'This page + children' }).check();
    await popup.getByRole('button', { name: /^Preview \(\d+ pages?\)/ }).waitFor({ timeout: 90_000 });
    await sleep(300);
    const popupShot = await popup.locator('.popup').screenshot();
    await popup.close();
    await compose(
      composer,
      frame({
        title: 'Export Confluence to PDF in <b>one click</b>',
        subtitle: 'This page, a page tree, a folder, linked pages or a whole space.',
        body: windowWith(PAGE_URL.replace(/^https:\/\//, ''), pageShot, `<div class="popup"><img src="${dataUrl(popupShot)}"></div>`),
      }),
      join(OUT_DIR, '01-popup.png'),
    );

    // 02 preview with one page unticked
    const request = {
      site: SITE,
      mode: 'subtree',
      depth: 'all',
      root: ROOT,
      options: { ...DEFAULT_OPTIONS, customCss: HIDE_AUTHOR_CSS },
    };
    const preview = await ext.context.newPage();
    await preview.goto(ext.url(`preview.html?req=${b64url(request)}`));
    const rows = preview.locator('ul.rows li');
    await preview.locator('ul.rows .row-title').first().waitFor({ timeout: 120_000 });
    const n = await rows.count();
    if (n > 3) await rows.nth(n - 2).locator('input[type="checkbox"]').first().uncheck();
    await sleep(300);
    const previewShot = await preview.screenshot();
    await compose(
      composer,
      frame({
        title: 'Preview the pages, <b>untick</b> what you don’t need',
        subtitle: 'Sidebar order and breadcrumbs, straight from Confluence.',
        body: windowWith('Fast Confluence Exporter — Preview', previewShot),
      }),
      join(OUT_DIR, '02-preview.png'),
    );

    // 03 the finished export
    await preview.getByRole('button', { name: 'Export PDF' }).click();
    await preview.waitForURL(/\?job=/, { timeout: 60_000 });
    const jobId = new URL(preview.url()).searchParams.get('job');
    let job = null;
    for (let i = 0; i < 1800 && !(job && ['done', 'error', 'cancelled'].includes(job.status)); i++) {
      const res = await ext.driver.evaluate((id) => chrome.runtime.sendMessage({ type: 'job/get', jobId: id }), jobId);
      job = res?.ok ? res.value : null;
      await sleep(100);
    }
    if (job?.status !== 'done') throw new Error(`export ended as ${job?.status}: ${job?.message}`);
    await preview.getByText(job.result.filename).waitFor({ timeout: 30_000 });
    await sleep(500);
    const resultShot = await preview.screenshot();
    await compose(
      composer,
      frame({
        title: 'One clean PDF, <b>built in your browser</b>',
        subtitle: 'Progress, cancel and a clear summary. No servers, no accounts, no API tokens.',
        body: windowWith('Fast Confluence Exporter — Export', resultShot),
      }),
      join(OUT_DIR, '03-result.png'),
    );

    // 04 pages of the PDF
    const pdfFile = await downloadedFile(ext.driver, job.result.downloadId);
    const pdftoppm = which('pdftoppm');
    if (!pdftoppm) {
      console.warn('pdftoppm not found (install poppler-utils / `brew install poppler`): skipping 04-pdf.png');
    } else {
      execFileSync(pdftoppm, ['-png', '-r', '110', '-f', '1', '-l', '3', pdfFile, join(work, 'sheet')]);
      const sheets = readdirSync(work)
        .filter((f) => /^sheet-\d+\.png$/.test(f))
        .sort()
        .map((f) => readFileSync(join(work, f)));
      await compose(
        composer,
        frame({
          title: 'Cover, contents, bookmarks and <b>working links</b>',
          subtitle: 'Selectable text, sharp images, every page on a new sheet.',
          body: `<div class="sheets">${sheets.map((s) => `<div class="sheet"><img src="${dataUrl(s)}"></div>`).join('')}</div>`,
        }),
        join(OUT_DIR, '04-pdf.png'),
      );
    }

    // 05 options
    const options = await ext.context.newPage();
    await options.goto(ext.url('options.html'));
    await options.waitForLoadState('load');
    await options.getByText(SITE.origin, { exact: true }).waitFor({ timeout: 15_000 });
    // The live build may access two sites; show only the one these screenshots use.
    await options.evaluate((keep) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent || '').trim();
        if (/^https?:\/\/\S+$/.test(t) && !t.includes(keep)) hits.push(n.parentElement);
      }
      for (let el of hits) {
        while (el && el.parentElement && !el.querySelector('button')) el = el.parentElement;
        el?.remove();
      }
    }, new URL(SITE.origin).host);
    await sleep(500);
    const optionsShot = await options.screenshot();
    await compose(
      composer,
      frame({
        title: 'Make it <b>yours</b>',
        subtitle: 'Paper size, margins, cover, table of contents, page numbers and custom CSS.',
        body: windowWith('Fast Confluence Exporter — Options', optionsShot),
      }),
      join(OUT_DIR, '05-options.png'),
    );
  } finally {
    await composer.close().catch(() => undefined);
    await ext.context.close().catch(() => undefined);
    for (const d of [work, downloadsDir, ext.userDataDir]) rmSync(d, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
