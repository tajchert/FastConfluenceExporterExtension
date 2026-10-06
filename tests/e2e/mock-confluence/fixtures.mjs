/**
 * Synthetic content for the mock Confluence (tests/e2e/mock-confluence/server.mjs).
 * Made-up spaces, titles and people only; markup modelled on the export_view shapes in
 * docs/ARCHITECTURE.md §1 and tests/unit/fixtures/exportView.ts.
 *
 * Every body is a function of `base` (absolute Confluence base URL, e.g. http://127.0.0.1:1234/wiki)
 * because export_view uses absolute same-origin URLs for images and page links.
 */

// ───────────────────────────── Cloud (context path /wiki) ─────────────────────────────

export const CLOUD_SPACE = { id: '9001', key: 'TEST', name: 'Test Space', homepageId: '100' };

export const CLOUD_USER = { accountId: 'acc-erin', displayName: 'Erin Example' };

const panel = (kind, text) => `
<div class="confluence-information-macro confluence-information-macro-${kind} conf-macro output-block" data-hasbody="true" data-macro-name="${kind === 'information' ? 'info' : kind}">
  <span class="aui-icon aui-icon-small aui-iconfont-info confluence-information-macro-icon"> </span>
  <div class="confluence-information-macro-body"><p>${text}</p></div>
</div>`;

const pageLink = (base, id, slug, text) =>
  `<a href="${base}/spaces/TEST/pages/${id}/${slug}" data-linked-resource-id="${id}" data-linked-resource-version="1" data-linked-resource-type="page">${text}</a>`;

/** Rich page: panels, table, code, expand, iframe, image, same-page anchors and links. */
const architectureBody = (base) => `
<div class="toc-macro rbtoc1700000000000"><ul class="toc-indentation">
  <li><a href="#ArchitectureOverview-Components">Components</a></li>
  <li><a href="#ArchitectureOverview-Datamodel">Data model</a></li>
</ul></div>
<p>This page describes the architecture. See ${pageLink(base, '102', 'Getting+Started', 'Getting Started')} first,
then the <a href="${base}/spaces/TEST/pages/102">plain link to Getting Started</a> (duplicate on purpose).</p>
<p>Restricted: ${pageLink(base, '104', 'Secret+Plans', 'Secret Plans')}. Release notes: <a href="${base}/x/ag">short link</a>.
Folder page: <a href="${base}/spaces/TEST/pages/501/API+Design">API Design</a>.</p>
<p>Ignored: <a class="external-link" href="https://example.com/docs" rel="nofollow">external</a>,
<a href="${base}/download/attachments/103/diagram.png?version=1&amp;api=v2">attachment</a>,
<a href="https://jira.example.com/browse/ABC-1">ABC-1</a>,
<a class="confluence-userlink user-mention" href="${base}/people/acc-erin" data-account-id="acc-erin">Erin Example</a>,
<a href="mailto:team@example.com">mail</a>.</p>
${panel('information', 'Info panel: the <strong>new</strong> gateway is live.')}
${panel('note', 'Note panel: read the data model.')}
${panel('warning', 'Warning panel: do not deploy on Fridays.')}
<h1 id="ArchitectureOverview-Components">Components</h1>
<p>Back to the <a href="#ArchitectureOverview-Datamodel">data model</a>.</p>
<div class="table-wrap"><table data-table-width="760" data-layout="default" class="confluenceTable">
  <colgroup><col style="width: 226.67px;"/><col style="width: 533.33px;"/></colgroup>
  <tbody>
    <tr><th class="confluenceTh"><p>Component</p></th><th class="confluenceTh"><p>Owner</p></th></tr>
    <tr><td class="confluenceTd"><p>Gateway</p></td><td class="confluenceTd"><p>Team Blue</p></td></tr>
    <tr><td class="confluenceTd"><p>Ledger</p></td><td class="confluenceTd"><p>Team Green</p></td></tr>
  </tbody>
</table></div>
<div class="code panel pdl conf-macro output-block" data-hasbody="true" data-macro-name="code">
  <div class="codeContent panelContent pdl">
    <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false; theme: Confluence">public class Gateway {
  void pay() { /* a very long line that must wrap rather than be cut off ...................................................... */ }
}</pre>
  </div>
</div>
<div id="expander-1234" class="expand-container conf-macro output-block" data-hasbody="true" data-macro-name="expand">
  <div id="expander-control-1234" class="expand-control" aria-expanded="false">
    <span class="expand-icon aui-icon aui-icon-small aui-iconfont-chevron-right">&nbsp;</span><span class="expand-control-text">Show details</span>
  </div>
  <div id="expander-content-1234" class="expand-content expand-hidden"><p>Hidden details that must be printed.</p></div>
</div>
<h1 id="ArchitectureOverview-Datamodel">Data model</h1>
<p><span class="confluence-embedded-file-wrapper image-center-wrapper"><img class="confluence-embedded-image image-center" loading="lazy" src="${base}/download/attachments/103/diagram.png?version=1&amp;modificationDate=1700000000000&amp;api=v2" data-image-src="${base}/download/attachments/103/diagram.png?version=1&amp;api=v2" data-linked-resource-id="9999" data-linked-resource-type="attachment" alt="diagram"></span></p>
<p><iframe src="https://www.example.com/embed/video" style="width:640px;height:360px" frameborder="0"></iframe></p>
<p><script>window.__cfpInjected = true;</script><span onclick="alert(1)">Scripts and handlers are stripped.</span></p>`;

const simple = (text) => `<p>${text}</p><h2 id="x-Section">Section</h2><p>More text for ${text}</p>`;

/**
 * Cloud content. `position` is the sidebar order (deliberately not alphabetical and not id order).
 * `forbidden` → every API call for it answers 403. `throttleOnce` → the first export_view request
 * answers 429 with Retry-After: 1.
 */
export const CLOUD_CONTENT = {
  100: { type: 'page', title: 'Test Home', parentId: null, position: 0, body: () => simple('Welcome to the test space.') },
  101: { type: 'page', title: 'Engineering Handbook', parentId: '100', position: 10, body: () => simple('Handbook root page.') },
  102: { type: 'page', title: 'Getting Started', parentId: '101', position: 100, throttleOnce: true, body: () => simple('How to get started.') },
  105: { type: 'page', title: 'Local Setup', parentId: '102', position: 0, body: () => simple('Install the tools.') },
  103: { type: 'page', title: 'Architecture Overview', parentId: '101', position: 200, body: architectureBody },
  104: { type: 'page', title: 'Secret Plans', parentId: '101', position: 300, forbidden: true, body: () => simple('You should not see this.') },
  107: { type: 'page', title: 'Old Archived Page', parentId: '101', position: 400, status: 'archived', body: () => simple('Archived.') },
  106: {
    type: 'page',
    title: 'Release Notes',
    parentId: '100',
    position: 20,
    // The attachment answers 404 → the export shows a placeholder and reports it as degraded.
    body: (base) => simple('Version 1.0 released.') + `<p><img class="confluence-embedded-image" src="${base}/download/attachments/106/missing-screenshot.png?version=1&amp;api=v2" alt="missing"></p>`,
  },
  108: {
    type: 'page',
    title: 'System Diagram',
    parentId: '100',
    position: 25,
    // export_view of a client-rendered macro: an empty placeholder (needs live render).
    body: () => `<p>The diagram below is drawn in the browser.</p><div class="conf-macro output-block" data-macro-name="drawio" data-hasbody="false"></div>`,
    storage: () => `<p>The diagram below is drawn in the browser.</p><ac:structured-macro ac:name="drawio" ac:schema-version="1"><ac:parameter ac:name="diagramName">system</ac:parameter></ac:structured-macro>`,
    // What the real page shows once its app script ran (the HTML route keeps this script).
    liveHtml: () => `<p>The diagram below is drawn in the browser.</p>
<div class="drawio-macro conf-macro" data-macro-name="drawio" id="drawio-1"></div>
<script>setTimeout(function () {
  document.getElementById('drawio-1').innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160"><rect x="10" y="10" width="380" height="140" fill="#e9f2ff" stroke="#0c66e4"/>' +
    '<text x="40" y="90" font-size="24">LIVE DIAGRAM</text></svg>' +
    '<p><a href="https://live.example/rendered-diagram">rendered by the page script</a></p>';
}, 700);</script>`,
  },
  500: { type: 'folder', title: 'Design Docs', parentId: '100', position: 30 },
  501: { type: 'page', title: 'API Design', parentId: '500', position: 5, body: () => simple('REST conventions.') },
  502: { type: 'page', title: 'UI Guidelines', parentId: '500', position: 7, body: () => simple('Spacing and colours.') },
  600: { type: 'page', title: 'Big Manual', parentId: '100', position: 40, body: () => simple('A manual with many chapters.') },
};

// 12 chapters under "Big Manual" (more than the minimum print batch size of 10).
for (let i = 1; i <= 12; i++) {
  CLOUD_CONTENT[600 + i] = {
    type: 'page',
    title: `Chapter ${i}`,
    parentId: '600',
    position: i,
    body: (base) =>
      simple(`Chapter ${i} text.`) +
      (i === 1 ? `<p>Jump to <a href="${base}/spaces/TEST/pages/612/Chapter+12" data-linked-resource-id="612" data-linked-resource-type="page">Chapter 12</a>.</p>` : ''),
  };
}

// ───────────────────────────── Data Center (context path /confluence) ─────────────────────────

export const DC_SPACE = { id: 327681, key: 'DOC', name: 'Documentation', homepageId: '2001' };
export const DC_USER = { username: 'dana', displayName: 'Dana Datacenter' };

export const DC_CONTENT = {
  2001: { type: 'page', title: 'DC Home', parentId: null, position: null, body: (base) => `<p>Data Center home. Child: <a href="${base}/display/DOC/DC+Child+B">DC Child B</a>.</p><p><img class="confluence-embedded-image" src="${base}/download/attachments/2001/logo.png?version=1&amp;api=v2" alt="logo"></p>` },
  // Sidebar order: B (position 0) before A (position 1), i.e. not alphabetical.
  2002: { type: 'page', title: 'DC Child A', parentId: '2001', position: 1, body: () => simple('Child A on Data Center.') },
  2003: { type: 'page', title: 'DC Child B', parentId: '2001', position: 0, body: () => simple('Child B on Data Center.') },
  2004: { type: 'page', title: 'DC Grandchild', parentId: '2003', position: 0, body: () => simple('Grandchild on Data Center.') },
};
