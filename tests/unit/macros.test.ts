import { describe, expect, it } from 'vitest';
import { detectLiveRenderMacros, humanizeMacroName, replaceUnsupportedContent } from '../../lib/assemble/macros';
import { DEFAULT_SETTINGS } from '../../lib/types';
import { CODE, INFO_PANEL, JIRA_TABLE, PAGE_URL, TABLE } from './fixtures/exportView';

const NAMES = DEFAULT_SETTINGS.liveRenderMacros;

function root(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  return doc.getElementById('root')!;
}

describe('detectLiveRenderMacros', () => {
  it('returns [] for static pages', () => {
    expect(detectLiveRenderMacros(INFO_PANEL + TABLE + CODE + JIRA_TABLE, null, NAMES)).toEqual([]);
  });

  it('detects macros from storage format (structured macros and ADF extensions)', () => {
    const storage = `
      <p>Intro</p>
      <ac:structured-macro ac:name="drawio" ac:schema-version="1" ac:macro-id="x"><ac:parameter ac:name="diagramName">flow</ac:parameter></ac:structured-macro>
      <ac:adf-extension><ac:adf-node type="extension">
        <ac:adf-attribute key="extension-key">com.example.lucidchart-app:lucid-diagram</ac:adf-attribute>
        <ac:adf-attribute key="extension-type">com.atlassian.ecosystem</ac:adf-attribute>
      </ac:adf-node></ac:adf-extension>
      <ac:structured-macro ac:name="info"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>`;
    expect(detectLiveRenderMacros('<p>Intro</p>', storage, NAMES)).toEqual(['drawio', 'lucidchart']);
  });

  it('ignores a storage macro whose export_view already contains a rendered image', () => {
    const storage = '<ac:structured-macro ac:name="gliffy"><ac:parameter ac:name="name">arch</ac:parameter></ac:structured-macro>';
    const exportView =
      '<div class="conf-macro output-block" data-macro-name="gliffy"><img class="gliffy-image" src="/wiki/download/attachments/1/arch.png" width="600"/></div>';
    expect(detectLiveRenderMacros(exportView, storage, NAMES)).toEqual([]);
  });

  it('detects empty client-rendered placeholders in export_view', () => {
    const exportView = `
      <div class="conf-macro output-block" data-macro-name="drawio" data-hasbody="false"></div>
      <div class="gliffy-container" data-diagram="arch"><span class="gliffy-loading">Loading…</span></div>`;
    expect(detectLiveRenderMacros(exportView, null, NAMES)).toEqual(['drawio', 'gliffy']);
  });

  it('flags empty unknown app placeholders but not benign empty macros', () => {
    const exportView = `
      <span class="confluence-anchor-link conf-macro output-inline" id="Page-top" data-macro-name="anchor"></span>
      <div class="conf-macro output-block" data-macro-name="toc"></div>
      <div class="conf-macro output-block" data-macro-name="acme-forge-widget"></div>`;
    expect(detectLiveRenderMacros(exportView, null, NAMES)).toEqual(['acme-forge-widget']);
  });

  it('detects diagram iframes', () => {
    const exportView = '<iframe src="https://embed.diagrams.net/?embed=1&url=x"></iframe><iframe src="https://miro.com/app/live-embed/abc"></iframe>';
    expect(detectLiveRenderMacros(exportView, null, NAMES)).toEqual(['drawio', 'miro']);
  });

  it('is disabled by an empty macro list', () => {
    expect(detectLiveRenderMacros('<div data-macro-name="drawio"></div>', '<ac:structured-macro ac:name="drawio"/>', [])).toEqual([]);
  });

  it('matches configured names case-insensitively', () => {
    expect(detectLiveRenderMacros('<div data-macro-name="PlantUML"></div>', null, ['plantuml'])).toEqual(['plantuml']);
  });
});

describe('replaceUnsupportedContent', () => {
  it('replaces iframes, media and embeds with placeholders linking to source and page', () => {
    const r = root(`
      <p>Before</p>
      <iframe src="https://www.youtube.com/embed/abc" title="Launch demo"></iframe>
      <video controls><source src="/wiki/download/attachments/1/demo.mp4" type="video/mp4"/></video>
      <audio src="https://cdn.example.com/a.mp3"></audio>
      <object data="https://example.com/x.swf"></object>
      <p>After</p>`);
    const n = replaceUnsupportedContent(r, { pageUrl: PAGE_URL });
    expect(n).toBe(4);
    expect(r.querySelector('iframe, video, audio, object')).toBeNull();
    const boxes = Array.from(r.querySelectorAll('.cf-placeholder'));
    expect(boxes.map((b) => b.getAttribute('data-cf-kind'))).toEqual(['iframe', 'video', 'audio', 'object']);
    expect(boxes[0]!.textContent).toContain('Launch demo');
    expect(boxes[1]!.querySelector('.cf-placeholder-url a')!.getAttribute('href')).toBe(
      'https://acme.atlassian.net/wiki/download/attachments/1/demo.mp4',
    );
    for (const b of boxes) expect(b.querySelector('.cf-placeholder-open a')!.getAttribute('href')).toBe(PAGE_URL);
    expect(r.textContent).toContain('Before');
    expect(r.textContent).toContain('After');
  });

  it('replaces live search and interactive macros as a whole', () => {
    const r = root(`
      <div class="conf-macro output-block" data-macro-name="livesearch">
        <form class="aui"><input type="text" name="queryString" placeholder="Search"/><button>Go</button></form>
      </div>
      <div class="conf-macro output-block" data-macro-name="widget"><iframe src="https://player.vimeo.com/video/1"></iframe></div>`);
    expect(replaceUnsupportedContent(r, { pageUrl: PAGE_URL })).toBe(2);
    const labels = Array.from(r.querySelectorAll('.cf-placeholder-label')).map((l) => l.textContent);
    expect(labels).toEqual(['Live search', 'Embedded media (player.vimeo.com)']);
    expect(r.querySelector('form, input, iframe')).toBeNull();
  });

  it('keeps Jira static tables and other rendered macros untouched', () => {
    const html = JIRA_TABLE + INFO_PANEL + CODE;
    const r = root(html);
    expect(replaceUnsupportedContent(r, { pageUrl: PAGE_URL })).toBe(0);
    expect(r.querySelector('table.aui')).not.toBeNull();
    expect(r.querySelector('.cf-placeholder')).toBeNull();
  });

  it('replaces empty macro placeholders, keeping their anchors, inline when inline', () => {
    const r = root(`
      <div class="conf-macro output-block" id="drawio-1" data-macro-name="drawio"></div>
      <p>See <span class="conf-macro output-inline jira-issue" data-macro-name="jira" data-jira-key="PAY-7"></span> for details.</p>
      <span class="confluence-anchor-link conf-macro output-inline" id="Page-anchor" data-macro-name="anchor"></span>`);
    expect(replaceUnsupportedContent(r, { pageUrl: PAGE_URL })).toBe(2);
    const block = r.querySelector('div.cf-placeholder')!;
    expect(block.textContent).toContain('draw.io diagram');
    expect(r.querySelector('#drawio-1')).not.toBeNull();
    const inline = r.querySelector('p .cf-placeholder-inline')!;
    expect(inline.textContent).toContain('Jira issue PAY-7');
    expect(r.querySelector('#Page-anchor')).not.toBeNull();
  });

  it('replaces an empty page-tree shell (filled by Confluence in the browser), keeps a rendered one', () => {
    const shell = root(`
      <div class="plugin_pagetree conf-macro output-block" data-macro-name="pagetree">
        <fieldset class="hidden"><input type="hidden" name="treeId" value="1"/><input type="hidden" name="rootPage" value="Home"/></fieldset>
        <ul class="plugin_pagetree_children_list"><li><ul class="plugin_pagetree_children"></ul></li></ul>
      </div>`);
    expect(replaceUnsupportedContent(shell, { pageUrl: PAGE_URL })).toBe(1);
    const ph = shell.querySelector('.cf-placeholder')!;
    expect(ph.textContent).toContain('Page tree');
    expect(ph.querySelector('.cf-placeholder-open a')!.getAttribute('href')).toBe(PAGE_URL);

    const rendered = root(`<div class="conf-macro output-block" data-macro-name="pagetree"><ul><li><a href="#">Child page</a></li></ul></div>`);
    expect(replaceUnsupportedContent(rendered, { pageUrl: PAGE_URL })).toBe(0);
    // Other list macros that are empty simply have no items: no placeholder noise.
    const children = root(`<div class="conf-macro output-block" data-macro-name="children"></div>`);
    expect(replaceUnsupportedContent(children, { pageUrl: PAGE_URL })).toBe(0);
  });

  it('never creates links from non-http sources', () => {
    const r = root('<iframe src="javascript:alert(1)"></iframe>');
    replaceUnsupportedContent(r, { pageUrl: PAGE_URL });
    expect(r.querySelector('.cf-placeholder-url')).toBeNull();
    expect(r.innerHTML).not.toContain('javascript:');
  });
});

describe('humanizeMacroName', () => {
  it('uses friendly labels', () => {
    expect(humanizeMacroName('inc-drawio')).toBe('draw.io diagram');
    expect(humanizeMacroName('acme-forge-widget')).toBe('Acme forge widget');
    expect(humanizeMacroName('')).toBe('Macro');
  });
});
