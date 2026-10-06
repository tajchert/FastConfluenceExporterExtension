/**
 * Realistic Confluence Cloud `export_view` fragments, modelled on the spike findings
 * (docs/ARCHITECTURE.md §1). Site: https://acme.atlassian.net/wiki.
 */
import type { SiteInfo } from '../../../lib/types';

export const SITE: SiteInfo = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
  siteTitle: 'Acme Wiki',
};

export const SERVER_SITE: SiteInfo = {
  origin: 'https://intranet.acme.corp',
  baseUrl: 'https://intranet.acme.corp/confluence',
  contextPath: '/confluence',
  flavour: 'server',
};

export const PAGE_ID = '315494566';
export const PAGE_URL = `${SITE.baseUrl}/spaces/ENG/pages/${PAGE_ID}/Checkout+v3+Tech+Spec`;

export const INFO_PANEL = `
<div class="confluence-information-macro confluence-information-macro-information conf-macro output-block" data-hasbody="true" data-macro-name="info">
  <span class="aui-icon aui-icon-small aui-iconfont-info confluence-information-macro-icon"> </span>
  <div class="confluence-information-macro-body"><p>Payments go through the <strong>new</strong> gateway.</p></div>
</div>`;

export const WARNING_PANEL = `
<div class="confluence-information-macro confluence-information-macro-warning conf-macro output-block" data-macro-name="warning">
  <p class="title">Careful</p>
  <span class="aui-icon aui-icon-small aui-iconfont-error confluence-information-macro-icon"> </span>
  <div class="confluence-information-macro-body"><p>Do not deploy on Fridays.</p></div>
</div>`;

export const TABLE = `
<div class="table-wrap"><table data-table-width="760" data-layout="default" class="confluenceTable">
  <colgroup><col style="width: 226.67px;"/><col style="width: 533.33px;"/></colgroup>
  <tbody>
    <tr><th class="confluenceTh"><p>Field</p></th><th class="confluenceTh"><p>Description</p></th></tr>
    <tr><td class="confluenceTd"><p>id</p></td><td class="confluenceTd"><p>Primary key</p></td></tr>
    <tr><td class="confluenceTd"><p>amount</p></td><td class="confluenceTd" style="position: absolute; top: 0; color: red;"><p>Minor units</p></td></tr>
  </tbody>
</table></div>`;

export const CODE = `
<div class="code panel pdl conf-macro output-block" style="border-width: 1px;" data-hasbody="true" data-macro-name="code">
  <div class="codeContent panelContent pdl">
    <pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false; theme: Confluence" data-theme="Confluence">public class Checkout {
  void pay() { /* very long line that should wrap rather than be cut off ......................................... */ }
}</pre>
  </div>
</div>`;

export const EXPAND = `
<div id="expander-1234" class="expand-container conf-macro output-block" data-hasbody="true" data-macro-name="expand">
  <div id="expander-control-1234" class="expand-control" aria-expanded="false">
    <span class="expand-icon aui-icon aui-icon-small aui-iconfont-chevron-right">&nbsp;</span>
    <span class="expand-control-text conf-macro-render">Show the rollout plan</span>
  </div>
  <div id="expander-content-1234" class="expand-content expand-hidden" style="display: none;">
    <p>Week 1: internal users.</p>
  </div>
</div>`;

export const LINKS = `
<p>
  See <a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/111/Architecture" data-linked-resource-id="111" data-linked-resource-version="3" data-linked-resource-type="page">Architecture</a>,
  <a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/222/Glossary#Glossary-Terms" data-linked-resource-id="222" data-linked-resource-type="page">Glossary terms</a>,
  <a href="https://acme.atlassian.net/wiki/spaces/OPS/pages/999/Runbook" data-linked-resource-id="999" data-linked-resource-type="page">Runbook</a>,
  <a href="/wiki/pages/viewpage.action?pageId=111">legacy link</a>,
  <a href="https://acme.atlassian.net/wiki/x/phDOEg">tiny self link</a>,
  <a href="#CheckoutV3TechSpec-Overview">overview</a>,
  <a href="javascript:alert(1)" onclick="alert(2)">bad</a>,
  <a href="https://example.com/docs" class="external-link" rel="nofollow" target="_blank">external</a>,
  <a href="/wiki/download/attachments/315494566/spec.pdf?version=1&amp;api=v2" data-linked-resource-type="attachment" data-linked-resource-id="5555">spec.pdf</a>,
  <a class="confluence-userlink user-mention" data-account-id="abc" href="https://acme.atlassian.net/wiki/people/abc?ref=confluence">Jane Doe</a>
</p>`;

export const HEADINGS = `
<h1 id="CheckoutV3TechSpec-Overview">Overview</h1>
<p>Intro.</p>
<h2 id="CheckoutV3TechSpec-Details">Details</h2>
<h6 id="CheckoutV3TechSpec-Fine">Fine print</h6>`;

export const IMAGES = `
<p><span class="confluence-embedded-file-wrapper image-center-wrapper confluence-embedded-manual-size">
  <img class="confluence-embedded-image image-center" loading="lazy" width="680"
    src="https://acme.atlassian.net/wiki/download/thumbnails/315494566/flow.png?version=1&amp;api=v2"
    data-image-src="https://acme.atlassian.net/wiki/download/attachments/315494566/flow.png?version=1&amp;api=v2"
    srcset="/wiki/download/thumbnails/315494566/flow.png?width=1360 2x"
    data-linked-resource-default-alias="flow.png" alt="flow.png"/>
</span></p>
<p><img class="emoticon emoticon-smile" src="/wiki/images/icons/emoticons/smile.svg" alt="(smile)"/>
  <img class="emoticon emoticon-blue-star" data-emoji-id="1f600" data-emoji-shortname=":grinning:" data-emoji-fallback="😀" src="https://pf-emoji-service.example/1f600.png" alt=":grinning:"/></p>`;

export const TASKS = `
<ul class="inline-task-list" data-inline-tasks-content-id="315494566">
  <li class="checked" data-inline-task-id="1"><span>Write spec</span></li>
  <li data-inline-task-id="2"><span>Review spec</span></li>
</ul>
<p><input type="checkbox" checked="checked"/> legacy box</p>`;

export const COMMENTED = `<p>Text with <span class="inline-comment-marker" data-ref="abc-123">a comment</span> inside.</p>`;

export const JIRA_TABLE = `
<div class="jira-table conf-macro output-block" data-macro-name="jira" data-hasbody="false">
  <table class="aui">
    <thead><tr><th class="jira-macro-table-underline-pdfexport">Key</th><th class="jira-macro-table-underline-pdfexport">Summary</th><th class="jira-macro-table-underline-pdfexport">Status</th></tr></thead>
    <tbody><tr>
      <td class="jira-macro-table-underline-pdfexport"><a href="https://acme.atlassian.net/browse/PAY-1">PAY-1</a></td>
      <td class="jira-macro-table-underline-pdfexport">Add card vault</td>
      <td class="jira-macro-table-underline-pdfexport"><span class="aui-lozenge aui-lozenge-success">Done</span></td>
    </tr></tbody>
  </table>
</div>`;

export const IFRAME = `
<div class="conf-macro output-block" data-macro-name="html">
  <iframe src="https://www.youtube.com/embed/abc123" width="560" height="315" title="Demo video"></iframe>
</div>`;

export const STATUS = `<p>State: <span class="status-macro aui-lozenge aui-lozenge-visual-refresh aui-lozenge-current">In progress</span></p>`;

export const FULL_PAGE = [
  HEADINGS,
  INFO_PANEL,
  WARNING_PANEL,
  TABLE,
  CODE,
  EXPAND,
  LINKS,
  IMAGES,
  TASKS,
  COMMENTED,
  JIRA_TABLE,
  IFRAME,
  STATUS,
  '<script>window.__pwned = true</script><style>body{display:none}</style>',
].join('\n');
