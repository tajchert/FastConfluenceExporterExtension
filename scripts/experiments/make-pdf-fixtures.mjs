// Regenerates the real-Chrome PDF fixtures used by tests/unit/merge.test.ts.
// Usage: node scripts/experiments/make-pdf-fixtures.mjs [path-to-chrome]
// Prints with CDP Page.printToPDF using the same parameters as lib/render/cdp.ts.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../tests/unit/fixtures');
const executablePath =
  process.argv[2] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const css = `@page { size: A4; margin: 18mm 15mm; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; }
.cf-page { break-before: page; } .cf-toc a { display: block; }`;
const lorem = (n) => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(n);
const article = (p) => `<article class="cf-page" id="p-${p.id}">
<header class="cf-page-meta"><h1>${p.title}</h1><div>Space · <a href="https://example.com/wiki/pages/${p.id}">Open in Confluence</a></div></header>
<h2 id="p${p.id}-Intro">Intro of ${p.id}</h2><p>${lorem(p.len ?? 10)}</p>
<p><a href="#p${p.id}-Intro">same page</a> <a href="#p-101">to first</a></p></article>`;
const hiddenLinks = (pages) =>
  `<div style="display:none">${pages.map((p) => `<a href="#p-${p.id}"></a>`).join('')}</div>`;

const docs = {
  // Batch 1: cover + TOC + 3 pages (102 spans several sheets, 103 has a non-ASCII title).
  'chrome-sections.pdf': (() => {
    const pages = [
      { id: '101', title: 'Alpha page' },
      { id: '102', title: 'Beta page', len: 160 },
      { id: '103', title: 'Zażółć gęślą jaźń — “quotes”' },
    ];
    return `<section class="cf-cover"><div style="font-size:28pt">Export cover</div></section>
<nav class="cf-toc"><div>Contents</div>${pages.map((p) => `<a href="#p-${p.id}">${p.title}</a>`).join('')}</nav>
${hiddenLinks(pages)}${pages.map(article).join('')}`;
  })(),
  // Batch 2: no cover/TOC, dests only via the hidden link block.
  'chrome-batch2.pdf': (() => {
    const pages = [{ id: '104', title: 'Delta page' }];
    return `${hiddenLinks(pages)}${pages.map(article).join('')}`;
  })(),
  // No links at all: Chrome emits no named destinations, only the outline.
  'chrome-nodests.pdf': `<article class="cf-page" id="p-201"><h1>First</h1><h2>Sub</h2><p>${lorem(5)}</p></article>
<article class="cf-page" id="p-202"><h1>Second</h1><p>${lorem(90)}</p></article>
<article class="cf-page" id="p-203"><h1>Third  title</h1><p>x</p></article>`,
  // A "live render" print: own internal link + a colliding id (p-101).
  'chrome-live.pdf': `<h1 id="title">Live page</h1><p><a href="#later">jump</a> <a href="#p-101">collide</a></p>
<div style="break-before:page" id="later"><h2 id="p-101">Later section</h2><p>${lorem(3)}</p></div>`,
};

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  for (const [name, body] of Object.entries(docs)) {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
    const cdp = await page.context().newCDPSession(page);
    const res = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:8px;color:#666;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      generateDocumentOutline: true,
      generateTaggedPDF: true,
      transferMode: 'ReturnAsStream',
    });
    const chunks = [];
    for (;;) {
      const c = await cdp.send('IO.read', { handle: res.stream, size: 1 << 20 });
      chunks.push(Buffer.from(c.data, c.base64Encoded ? 'base64' : 'utf8'));
      if (c.eof) break;
    }
    await cdp.send('IO.close', { handle: res.stream });
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(path.join(outDir, name), buf);
    console.log(name, buf.length, 'bytes');
    await cdp.detach();
  }
} finally {
  await browser.close();
}
