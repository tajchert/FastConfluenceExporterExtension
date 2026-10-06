import { describe, expect, it } from 'vitest';
import {
  buildPrintCss,
  buildPrintDocument,
  effectiveMarginsMm,
  paperSizeMm,
  type AssembleInput,
} from '../../lib/assemble/document';
import { imageFileName, waitForAssets } from '../../lib/assemble/assets';
import type { PageBody } from '../../lib/confluence/client';
import { DEFAULT_OPTIONS, type ExportOptions, type PageRef } from '../../lib/types';
import { FULL_PAGE, SITE } from './fixtures/exportView';

const options = (o: Partial<ExportOptions> = {}): ExportOptions => ({ ...DEFAULT_OPTIONS, ...o });

function ref(id: string, title: string, depth: number, extra: Partial<PageRef> = {}): PageRef {
  return {
    id,
    type: 'page',
    title,
    depth,
    url: `${SITE.baseUrl}/spaces/ENG/pages/${id}`,
    reason: depth === 0 ? 'root' : 'descendant',
    spaceKey: 'ENG',
    ...extra,
  };
}

function body(id: string, title: string, html: string, extra: Partial<PageBody> = {}): PageBody {
  return {
    id,
    type: 'page',
    title,
    spaceKey: 'ENG',
    html,
    version: 7,
    lastModified: '2026-09-30T10:00:00.000Z',
    authorDisplayName: 'Jane Doe',
    breadcrumb: ['Engineering', 'Payments'],
    url: `${SITE.baseUrl}/spaces/ENG/pages/${id}`,
    ...extra,
  };
}

function newDoc(): Document {
  return document.implementation.createHTMLDocument('worker');
}

const ROOT = ref('100', 'Checkout v3', 0);
const CHILD = ref('111', 'Architecture', 1, { parentId: '100' });
const GRANDCHILD = ref('112', 'Data model', 2, { parentId: '111' });
const WHITEBOARD = ref('113', 'Brainstorm', 1, { type: 'whiteboard', parentId: '100' });
const SKIPPED = ref('114', 'Secret page', 1, { parentId: '100' });
const LIVE = ref('115', 'Diagrams', 1, { parentId: '100' });

function input(o: Partial<AssembleInput> = {}): AssembleInput {
  return {
    pages: [
      { ref: ROOT, body: body('100', 'Checkout v3', '<h1 id="Checkoutv3-Intro">Intro</h1><p>See <a href="/wiki/spaces/ENG/pages/111/Architecture" data-linked-resource-id="111">architecture</a> and <a href="#Checkoutv3-Missing">missing</a>.</p>') },
      { ref: CHILD, body: body('111', 'Architecture', FULL_PAGE) },
      { ref: GRANDCHILD, body: body('112', 'Data model', '<p>Tables.</p>') },
      { ref: WHITEBOARD, info: { id: '113', ok: true, needsLiveRender: false, linkOnly: true } },
      { ref: LIVE, body: body('115', 'Diagrams', '<div data-macro-name="drawio"></div>'), live: true },
    ],
    allPages: [ROOT, CHILD, GRANDCHILD, WHITEBOARD, SKIPPED, LIVE],
    excludeIds: ['114'],
    site: SITE,
    options: options(),
    cover: {
      title: 'Checkout v3',
      sourceUrl: ROOT.url,
      spaceKey: 'ENG',
      exportedAt: '2026-10-06T08:30:00.000Z',
      exportedBy: 'Sam Exporter',
      pageCount: 5,
      siteTitle: 'Acme Wiki',
    },
    toc: true,
    generatedBy: 'Fast PDF Export for Confluence v1.0.0',
    ...o,
  };
}

describe('page geometry & buildPrintCss', () => {
  it('computes paper sizes with orientation', () => {
    expect(paperSizeMm('A4', 'portrait')).toEqual({ width: 210, height: 297 });
    expect(paperSizeMm('Letter', 'landscape')).toEqual({ width: 279.4, height: 215.9 });
  });

  it('emits @page size and margins, and raises the bottom margin for page numbers', () => {
    const css = buildPrintCss(options({ marginsMm: { top: 10, right: 12, bottom: 5, left: 12 }, pageNumbers: true }));
    expect(css).toContain('@page { size: 210mm 297mm; margin: 10mm 12mm 12mm 12mm; }');
    expect(css).toContain('--cf-content-width: 186mm');
    expect(css).toContain('--cf-content-height: 275mm');
    const noNumbers = buildPrintCss(options({ marginsMm: { top: 10, right: 12, bottom: 5, left: 12 }, pageNumbers: false }));
    expect(noNumbers).toContain('margin: 10mm 12mm 5mm 12mm');
  });

  it('sanitizes bogus margins', () => {
    const m = effectiveMarginsMm(options({ marginsMm: { top: Number.NaN, right: -5, bottom: 999, left: 15 } }));
    expect(m).toEqual({ top: 18, right: 0, bottom: 60, left: 15 });
  });

  it('appends custom CSS last', () => {
    const css = buildPrintCss(options({ customCss: '.cf-cover-title { color: hotpink; }', orientation: 'landscape' }));
    expect(css.trim().endsWith('.cf-cover-title { color: hotpink; }')).toBe(true);
    expect(css).toContain('size: 297mm 210mm');
  });
});

describe('buildPrintDocument', () => {
  it('builds head, cover, TOC and one article per page', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input());
    expect(doc.title).toBe('Checkout v3');
    expect(doc.head.querySelector('meta[charset]')).not.toBeNull();
    expect(doc.getElementById('cf-print-css')!.textContent).toContain('@page');

    const cover = doc.querySelector('section.cf-cover')!;
    expect(cover.querySelector('.cf-cover-title')!.textContent).toBe('Checkout v3');
    expect(cover.textContent).toContain('Acme Wiki');
    expect(cover.textContent).toContain('Sam Exporter');
    expect(cover.textContent).toContain('Fast PDF Export for Confluence v1.0.0');
    expect(cover.querySelector('h1, h2, h3')).toBeNull();

    const articles = Array.from(doc.querySelectorAll('article.cf-page'));
    expect(articles.map((a) => a.id)).toEqual(['p-100', 'p-111', 'p-112', 'p-113', 'p-115']);
    expect(articles.map((a) => a.getAttribute('data-page-id'))).toEqual(['100', '111', '112', '113', '115']);
  });

  it('renders a nested TOC without headings, skipping excluded pages', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input());
    const toc = doc.querySelector('nav.cf-toc')!;
    expect(toc.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    const links = Array.from(toc.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toEqual(['#p-100', '#p-111', '#p-112', '#p-113', '#p-115']);
    expect(toc.textContent).not.toContain('Secret page');
    // Data model (depth 2) is nested inside Architecture (depth 1) inside the root.
    const grand = toc.querySelector('a[href="#p-112"]')!.closest('li')!;
    expect(grand.parentElement!.closest('li')!.querySelector('a')!.getAttribute('href')).toBe('#p-111');
    expect(toc.querySelector('a[href="#p-113"]')!.parentElement!.textContent).toContain('Whiteboard');
  });

  it('writes a page header with marker, title and metadata', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input());
    const header = doc.querySelector('#p-111 header.cf-page-meta')!;
    const marker = header.querySelector('.cf-marker')!;
    expect(marker.textContent).toBe('⟦cfp:111⟧');
    expect(header.querySelector('h1')!.textContent).toBe('Architecture');
    const info = header.querySelector('.cf-page-info')!.textContent!;
    expect(info).toContain('Engineering › Payments');
    expect(info).toContain('Last updated');
    expect(info).toContain('by Jane Doe');
    expect(info).toContain('Version 7');
    expect(header.querySelector('.cf-page-info a')!.getAttribute('href')).toBe(`${SITE.baseUrl}/spaces/ENG/pages/111`);
    // Exactly one h1 per page: content headings are demoted.
    expect(doc.querySelectorAll('#p-111 h1')).toHaveLength(1);
  });

  it('omits the meta line but keeps title and marker when includePageMeta is off', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input({ options: options({ includePageMeta: false }) }));
    const header = doc.querySelector('#p-100 header')!;
    expect(header.querySelector('.cf-page-info')).toBeNull();
    expect(header.querySelector('.cf-marker')).not.toBeNull();
    expect(header.querySelector('h1')!.textContent).toBe('Checkout v3');
  });

  it('links between exported pages and fixes dangling anchors', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input());
    const content = doc.querySelector('#p-100 .cf-content')!;
    const arch = Array.from(content.querySelectorAll('a')).find((a) => a.textContent === 'architecture')!;
    expect(arch.getAttribute('href')).toBe('#p-111');
    const missing = Array.from(content.querySelectorAll('a')).find((a) => a.textContent === 'missing')!;
    // Target heading does not exist: falls back to the page start.
    expect(missing.getAttribute('href')).toBe('#p-100');
    expect(doc.querySelector('[data-cf-fallback]')).toBeNull();
    expect(content.querySelector('h2#p100-Checkoutv3-Intro')).not.toBeNull();
  });

  it('emits link-only and live sections', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input());
    const wb = doc.querySelector('#p-113')!;
    expect(wb.querySelector('.cf-linkonly')!.textContent).toContain("can't be exported");
    expect(wb.querySelector('.cf-content')).toBeNull();
    const live = doc.querySelector('#p-115')!;
    const slot = live.querySelector('.cf-live-slot')!;
    expect(slot.getAttribute('data-page-id')).toBe('115');
    expect(live.querySelector('.cf-content')).toBeNull();
    expect(live.querySelector('.cf-marker')!.textContent).toBe('⟦cfp:115⟧');
  });

  it('renders folders as section headers listing their exported children', () => {
    const folder = ref('200', 'Guides', 0, { type: 'folder' });
    const g1 = ref('201', 'Setup', 1, { parentId: '200' });
    const doc = newDoc();
    buildPrintDocument(
      doc,
      input({ pages: [{ ref: folder }, { ref: g1, body: body('201', 'Setup', '<p>x</p>') }], allPages: [folder, g1], excludeIds: [], cover: null }),
    );
    const section = doc.querySelector('#p-200')!;
    expect(section.classList.contains('cf-section')).toBe(true);
    expect(section.querySelector('a[href="#p-201"]')!.textContent).toBe('Setup');
    expect(doc.querySelector('.cf-cover')).toBeNull();
    expect(doc.title).toBe('Guides');
  });

  it('keeps going when a page cannot be processed', () => {
    const broken = { ...body('300', 'Broken', '') } as PageBody;
    Object.defineProperty(broken, 'html', {
      get() {
        throw new Error('boom');
      },
    });
    const doc = newDoc();
    const ok = ref('301', 'Fine', 0);
    buildPrintDocument(
      doc,
      input({
        pages: [{ ref: ref('300', 'Broken', 0), body: broken }, { ref: ok, body: body('301', 'Fine', '<p>fine</p>') }],
        allPages: [ref('300', 'Broken', 0), ok],
        excludeIds: [],
        toc: false,
      }),
    );
    expect(doc.querySelector('#p-300 .cf-unavailable')!.textContent).toContain('boom');
    expect(doc.querySelector('#p-301 .cf-content')!.textContent).toContain('fine');
    expect(doc.querySelector('nav.cf-toc')).toBeNull();
  });

  it('replaces the previous document content entirely', () => {
    const doc = newDoc();
    doc.body.innerHTML = '<pre>{"results":[]}</pre>';
    buildPrintDocument(doc, input({ cover: null, toc: false }));
    expect(doc.body.querySelector('pre')?.textContent ?? '').not.toContain('results');
    expect(doc.body.firstElementChild!.className).toBe('cf-doc');
  });

  it('links every article from a hidden block so Chrome emits p-{id} destinations without a TOC', () => {
    const doc = newDoc();
    buildPrintDocument(doc, input({ cover: null, toc: false }));
    const block = doc.querySelector<HTMLElement>('.cf-dests')!;
    expect(block.style.display).toBe('none');
    const targets = Array.from(block.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    const articles = Array.from(doc.querySelectorAll('article.cf-page')).map((a) => `#${a.id}`);
    expect(targets).toEqual(articles);
    expect(targets).toContain('#p-115'); // live slot pages too
  });
});

describe('waitForAssets', () => {
  it('replaces images that never load with a filename placeholder', async () => {
    const doc = newDoc();
    doc.body.innerHTML = `
      <p><img src="https://acme.atlassian.net/wiki/download/attachments/1/My%20Diagram.png?version=2&amp;api=v2" srcset="x 2x" loading="lazy"/></p>
      <table><tr><td><img class="icon" src="/wiki/images/icons/bug.png" width="16" alt="Bug"/></td></tr></table>`;
    const res = await waitForAssets(doc, 50);
    expect(res.imageFailures).toBe(2);
    expect(doc.querySelector('img')).toBeNull();
    const ph = doc.querySelector('.cf-img-missing')!;
    expect(ph.querySelector('.cf-img-missing-name')!.textContent).toBe('My Diagram.png');
    // Small icons degrade to their alt text instead of a big box.
    expect(doc.querySelector('td .cf-img-missing-inline')!.textContent).toBe('Bug');
  });

  it('keeps images that loaded and counts no failures', async () => {
    const doc = newDoc();
    doc.body.innerHTML = '<img src="https://acme.atlassian.net/wiki/download/attachments/1/ok.png"/>';
    const img = doc.querySelector('img')!;
    Object.defineProperty(img, 'complete', { value: true });
    Object.defineProperty(img, 'naturalWidth', { value: 640 });
    Object.defineProperty(img, 'decode', { value: () => Promise.resolve() });
    const res = await waitForAssets(doc, 1000);
    expect(res.imageFailures).toBe(0);
    expect(doc.querySelector('img')).toBe(img);
  });

  it('prefers the Confluence attachment alias for the file name', () => {
    const img = document.createElement('img');
    img.setAttribute('src', 'https://api.media.atlassian.com/file/abc/image');
    img.setAttribute('data-linked-resource-default-alias', 'screenshot.png');
    expect(imageFileName(img)).toBe('screenshot.png');
  });
});
