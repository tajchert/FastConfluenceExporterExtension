/**
 * Extra `export_view` fragments for the Markdown / text converter tests, modelled on markup seen
 * on cwiki.apache.org (Data Center) and Confluence Cloud. Complements ./exportView.ts.
 */
import type { PageBody } from '../../../lib/confluence/client';
import { DEFAULT_OPTIONS, type ExportOptions, type PageRef } from '../../../lib/types';
import type { ConvertInput } from '../../../lib/convert';
import { SITE } from './exportView';

/** DC code macro with a title and backticks inside (Markdown in a code block). */
export const CODE_WITH_BACKTICKS = `
<div class="code panel pdl" style="border-width: 1px;">
  <div class="codeHeader panelHeader pdl" style="border-bottom-width: 1px;"><b>README.md</b></div>
  <div class="codeContent panelContent pdl">
    <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: bash; gutter: false" data-theme="Confluence">Run it:
\`\`\`
npm test
\`\`\`
then \`\`\`\`done\`\`\`\`</pre>
  </div>
</div>`;

/** Cloud-style code block with a language class and a noformat block. */
export const CODE_CLASS = `
<pre><code class="language-ts">const a: number = 1;</code></pre>
<div class="preformatted panel" style="border-width: 1px;"><div class="preformattedContent panelContent"><pre>plain   text
  indented</pre></div></div>`;

export const PANELS = `
<div class="confluence-information-macro confluence-information-macro-note"><span class="aui-icon aui-icon-small aui-iconfont-warning confluence-information-macro-icon"></span>
  <div class="confluence-information-macro-body"><p>Mind the gap.</p><ul><li>one</li></ul></div></div>
<div class="confluence-information-macro confluence-information-macro-tip"><div class="confluence-information-macro-body"><p>Use the cache.</p></div></div>
<div class="panel" style="border-width: 1px;"><div class="panelHeader" style="border-bottom-width: 1px;"><b>Release notes</b></div>
  <div class="panelContent"><p>Version 2 is out.</p></div></div>
<div class="panel" style="background-color: #EAE6FF;"><div class="panelContent"><p>Plain callout.</p></div></div>`;

/** Colspan + a list inside a cell: GFM can't express it. */
export const COMPLEX_TABLE = `
<div class="table-wrap"><table class="confluenceTable" style="width: 100%"><colgroup><col style="width: 50px"/><col/></colgroup><tbody>
  <tr><th class="confluenceTh" colspan="2" style="background: red">Plan</th></tr>
  <tr><td class="confluenceTd"><p>Steps</p></td><td class="confluenceTd"><ul><li>first</li><li>second</li></ul></td></tr>
  <tr><td class="confluenceTd">Code</td><td class="confluenceTd"><div class="code panel pdl"><div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: sql">SELECT 1;

SELECT 2;</pre></div></div></td></tr>
</tbody></table></div>`;

/** No header row; multi-paragraph cells, a pipe and a line break. */
export const HEADERLESS_TABLE = `
<table class="confluenceTable"><tbody>
  <tr><td class="confluenceTd"><p>a|b</p></td><td class="confluenceTd"><p>line 1<br/>line 2</p></td></tr>
  <tr><td class="confluenceTd"><p>para 1</p><p>para 2</p></td><td class="confluenceTd"><strong>bold</strong></td></tr>
</tbody></table>`;

export const NESTED_LISTS = `
<ol><li>First<ul><li>Nested a</li><li>Nested b<ol><li>Deep</li></ol></li></ul></li><li>Second</li></ol>
<ol start="4"><li>Four</li><li>Five</li></ol>`;

export const SPECIAL_CHARS = `
<p>Use <code>List&lt;String&gt;</code> not List&lt;String&gt; and 2 * 3 = 6, snake_case_name, _emph_, [brackets], a \\ backslash &amp;amp; and ~~strike~~.</p>
<p>1. not a list</p>
<p># not a heading</p>
<p>- not a bullet</p>
<p><s>gone</s> <sup>2</sup></p>`;

/** DC emoticons (no emoji fallback) and a custom Cloud emoji. */
export const EMOTICONS = `
<p>Good <img class="emoticon emoticon-tick" src="/wiki/images/icons/emoticons/check.svg" alt="(tick)"/>
 bad <img class="emoticon emoticon-cross" src="/wiki/images/icons/emoticons/error.svg" alt="(error)"/>
 idea <img class="emoticon" src="/wiki/images/icons/emoticons/lightbulb_on.svg" alt="(light-on)"/>
 party <img class="emoticon" data-emoji-id="abc" data-emoji-shortname=":partyparrot:" data-emoji-fallback=":partyparrot:" src="https://emoji.example/parrot.gif" alt=":partyparrot:"/></p>`;

/** Same image twice, a different image with the same file name, an external image. */
export const IMAGES_DEDUPE = `
<p><img class="confluence-embedded-image" src="https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=1&amp;api=v2" data-linked-resource-default-alias="diagram v2.png" alt="first"/></p>
<p><img class="confluence-embedded-image" src="https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=1&amp;api=v2" alt="again"/></p>
<p><img class="confluence-embedded-image" src="https://acme.atlassian.net/wiki/download/attachments/200/diagram%20v2.png?version=2&amp;api=v2" data-linked-resource-default-alias="diagram v2.png"/></p>
<p><img src="https://images.example.com/logo.svg" alt="Logo"/></p>
<table><tbody><tr><th>Pic</th><th>Note</th></tr><tr><td><img src="https://acme.atlassian.net/wiki/download/attachments/200/cell.png"/></td><td><ul><li>list makes it HTML</li></ul></td></tr></tbody></table>`;

/** Anchor macro + link to it, and a link to an anchor that does not exist. */
export const ANCHORS = `
<p><span class="confluence-anchor-link" id="Page-target"></span>Anchored paragraph.</p>
<p><a href="#Page-target">jump</a> and <a href="#Page-missing">missing</a>.</p>`;

export const CJK_TABLE = `
<table><thead><tr><th>名前</th><th>Note</th></tr></thead><tbody><tr><td>東京</td><td>x</td></tr><tr><td>ab</td><td>😀 ok</td></tr></tbody></table>`;

export const WIDE_TABLE = `
<table><thead><tr><th>Column A</th><th>Column B</th></tr></thead><tbody>
<tr><td>${'long text '.repeat(10)}</td><td>${'more words '.repeat(5)}</td></tr></tbody></table>`;

export const INLINE_PLACEHOLDER = `<p>Watch <span class="conf-macro output-inline" data-macro-name="widget"><a href="https://vimeo.com/123">video</a></span> now.</p>`;

// ───────────────────────────── builders ──────────────────────────────────────────────────────

export function ref(id: string, title: string, depth: number, extra: Partial<PageRef> = {}): PageRef {
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

export function body(id: string, title: string, html: string, extra: Partial<PageBody> = {}): PageBody {
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

export function convertInput(
  pages: { ref: PageRef; body?: PageBody }[],
  o: Partial<Omit<ConvertInput, 'options'>> & { options?: Partial<ExportOptions> } = {},
): ConvertInput {
  const { options, ...rest } = o;
  return {
    pages,
    allPages: pages.map((p) => p.ref),
    site: SITE,
    options: { ...DEFAULT_OPTIONS, format: 'markdown', ...options },
    cover: null,
    toc: false,
    generatedBy: 'Fast Confluence Exporter v1.0.0',
    separate: false,
    baseName: 'ENG_Checkout v3_2026-10-06',
    ...rest,
  };
}

export function newDoc(): Document {
  return document.implementation.createHTMLDocument('worker');
}

/** DC 9 expand: the title sits in a <button> (cwiki.apache.org, "Creating a Flink Release"). */
export const DC9_EXPAND = `
<div id="expander-1548104890" class="expand-container"><div id="expander-control-1548104890" class="expand-control"><button type="button" id="expand-button-1548104890" class="aui-button aui-button-link aui-button-link-icon-text" aria-expanded="true" aria-controls="expander-content-1548104890"><span class="expand-icon aui-icon aui-icon-small aui-iconfont-chevron-down" aria-hidden="true"></span><span class="expand-control-text conf-macro-render">Introduction</span></button></div><div role="region" id="expander-content-1548104890" class="expand-content" aria-labelledby="expand-button-1548104890"><p>The project publishes releases.</p></div></div>`;

/** Line breaks at the edge of a line box (inside a span, before a code panel in a list item). */
export const STRAY_BREAKS = `
<p><span>Motivation text.<br/></span></p>
<ul><li><p class="auto-cursor-target"><span>Before (multiple <code>--property</code> options):<br/></span></p><div class="code panel pdl"><div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: bash; gutter: false">run \\
  --x</pre></div></div></li></ul>
<p>keep<br/>this break</p>`;

/** Inline code wrapping a link (Confluence lets authors format a link as code). */
export const CODE_LINK = `<p>Publish to <code><a href="http://dist.apache.org/">dist.apache.org</a></code> and <a href="https://example.com/r"><code>release</code></a>.</p>`;
