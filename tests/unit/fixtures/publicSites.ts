/**
 * Small excerpts of `export_view` markup and REST responses observed on two public Confluence
 * sites (anonymous access, October 2026), trimmed to the structure the tests need:
 *
 *  - Data Center 9.2: https://cwiki.apache.org/confluence (Apache Software Foundation wiki)
 *  - Cloud:           https://uconn.atlassian.net/wiki     (public "AI" space)
 *
 * Only markup shapes are kept: page text is shortened or replaced, people are replaced by
 * made-up names, ids are kept where a test needs a realistic value.
 */
import type { SiteInfo } from '../../../lib/types';

export const APACHE: SiteInfo = {
  origin: 'https://cwiki.apache.org',
  baseUrl: 'https://cwiki.apache.org/confluence',
  contextPath: '/confluence',
  flavour: 'server',
  siteTitle: 'Apache Software Foundation',
};

export const UCONN: SiteInfo = {
  origin: 'https://uconn.atlassian.net',
  baseUrl: 'https://uconn.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
};

// ───────────────────────────── Data Center (cwiki.apache.org) ─────────────────────────────

/** Gliffy: a static PNG next to two image maps (page 65147974). */
export const DC_GLIFFY = `<p>
<span id="gliffy-container-65147979-4515" class="gliffy-container " data-fullwidth="1062" data-ceoid="65147974" data-filename="Impala RowBatch">
    <map id="gliffy-map-65147979-8185" name="gliffy-map-65147979-8185"></map>
    <img id="gliffy-image-65147979-4515" class="gliffy-image " width="1062" height="471" data-full-width="1062" data-full-height="471"
         src="/confluence/download/attachments/65147974/Impala%20RowBatch.png?version=12&amp;modificationDate=1469820236000&amp;api=v2"
         alt="Impala RowBatch" usemap="#gliffy-map-65147979-8185" />
    <map id="gliffy-dynamic-map-65147979-4515" class="gliffy-dynamic" name="gliffy-dynamic-map-65147979-4515"></map>
</span>
</p>`;

/** draw.io: only the exported PNG, no `data-macro-name` (page 406618787). */
export const DC_DRAWIO = `<h3 id="KIP18KnoxasOIDCProvider-3.4.1DatabaseDesign">3.4.1 Database Design</h3><p><img class="drawio-diagram-image" width="502" style="width:502px;max-width: 100%;" src="/confluence/download/attachments/406618787/federated_identity_db_er.png?version=1&modificationDate=1767870579000&api=v2"/></p>`;

/** The storage format of the same page names the macro. */
export const DC_DRAWIO_STORAGE = `<ac:structured-macro ac:name="drawio" ac:schema-version="1"><ac:parameter ac:name="diagramName">federated_identity_db_er</ac:parameter></ac:structured-macro>`;

/** Page tree macro: an empty list filled by the browser, settings in `fieldset.hidden` (page 421957302). */
export const DC_PAGETREE = `<p>
<div class="plugin_pagetree">
    <ul role="list" aria-busy="true" class="plugin_pagetree_children_list plugin_pagetree_children_list_noleftspace">
        <div class="plugin_pagetree_children">
        </div>
    </ul>
    <fieldset class="hidden">
        <input type="hidden" name="treeId" value="">
        <input type="hidden" name="treePageId" value="421957302">
        <input type="hidden" name="spaceKey" value="CLOUDSTACK" >
        <input type="hidden" name="i18n-pagetree.loading" value="Loading...">
    </fieldset>
</div>
</p>`;

/** Attachments macro: hidden settings and hidden per-file detail rows (page 217385748). */
export const DC_ATTACHMENTS = `<div class="plugin_attachments_container">
    <div class="plugin_attachments_table_container">
        <fieldset class="hidden">
            <input type="hidden" class="plugin_attachments_macro_render_param" name="pageId" value="217385748">
            <input type="hidden" name="outputType" value="email">
        </fieldset>
<table class="attachments aui">
    <thead><tr><th class="expand-column attachment-summary-toggle">&nbsp;</th><th class="filename-column">File</th><th class="modified-column">Modified</th></tr></thead>
    <tbody>
        <tr id="attachment-217385750" class="attachment-row" data-attachment-id="217385750">
            <td class="attachment-summary-toggle"></td>
            <td class="filename-column"><a class="filename" href="/confluence/download/attachments/217385748/grant.pdf?api=v2">grant.pdf</a></td>
            <td class="attachment-created modified-column"><span>Jan 01, 2022</span></td>
        </tr>
        <tr class="attachment-summary attachment-summary-217385750 hidden" data-attachment-id="217385750">
            <td class="attachment-summary-toggle"></td>
            <td class="attachment-details-wrapper" colspan="2"><div class="attachment-labels">Labels</div><div class="labels-section">No labels</div></td>
        </tr>
    </tbody>
</table>
    </div>
</div>`;

/** Single Jira issue, rendered for anonymous visitors before the browser fills it in (page 421958795). */
export const DC_JIRA_ISSUE = `<p><strong>JIRA</strong>:
<span class="jira-issue" data-jira-key="KAFKA-18800" data-client-id="SINGLE_5aa69414_421958795_anonymous" >
                    <a href="https://issues.apache.org/jira/browse/KAFKA-18800" class="jira-issue-key"><span
                    class="aui-icon aui-icon-wait issue-placeholder"></span>KAFKA-18800</a>
                            -
            <span class="summary">Getting issue details...</span>
                                                <span class="aui-lozenge aui-lozenge-subtle aui-lozenge-default issue-placeholder">STATUS</span>
                </span>
</p>`;

/** Jira issues table: the header row follows an empty first `<tr>` (page 451979307). */
export const DC_JIRA_TABLE = `<div id="refresh-module--1732135165" class="refresh-module-id jira-table">
<div id="jira-issues--1732135165" style="width: 100%;  overflow: auto;" class="jira-issues">
<table class="aui" style="padding:5px !important;vertical-align: top;">
  <tbody>
    <tr></tr>
    <tr>
      <th class="jira-macro-table-underline-pdfexport jira-tablesorter-header"><span class="jim-table-header-content">Key</span></th>
      <th class="jira-macro-table-underline-pdfexport jira-tablesorter-header"><span class="jim-table-header-content">Summary</span></th>
    </tr>
    <tr class="rowNormal">
      <td class="jira-macro-table-underline-pdfexport"><a href="https://issues.apache.org/jira/browse/FINERACT-1">FINERACT-1</a></td>
      <td class="jira-macro-table-underline-pdfexport">An issue</td>
    </tr>
  </tbody>
</table>
</div>
</div>`;

/** Links between pages on DC: by title (`/display/`), tiny link, viewpage.action (page 421958795). */
export const DC_LINKS = `<p><a href="https://cwiki.apache.org/confluence/x/h5KqCw" rel="nofollow">KIP-801</a> and
<a href="https://cwiki.apache.org/confluence/display/KAFKA/KIP-877%3A+Mechanism+for+plugins+and+connectors+to+register+metrics" rel="nofollow">KIP-877</a> and
<a href="https://cwiki.apache.org/confluence/pages/viewpage.action?spaceKey=KAFKA&amp;title=KIP-877%3A+Mechanism+for+plugins+and+connectors+to+register+metrics">KIP-877 again</a></p>`;

/** `GET /rest/api/user/current` for an anonymous visitor (Cloud and DC alike). */
export const ANONYMOUS_USER = { type: 'anonymous', displayName: 'Anonymous' };

// ───────────────────────────── Cloud (uconn.atlassian.net) ─────────────────────────────

/** "Recently updated" macro: hidden parameters, null resource ids, "Show More" and a spinner (homepage). */
export const CLOUD_RECENTLY_UPDATED = `<h2 id="ArtificialIntelligence-Recentlyupdatedcontent">Recently updated content</h2>
<div class="recently-updated recently-updated-concise" >
    <div class="hidden parameters">
        <input type="hidden" id="changesUrl" value="/wiki/plugins/recently-updated/changes.action?theme=concise&amp;pageSize=10&amp;spaceKeys=AI">
    </div>
    <div class="results-container">
        <ul>
        <li class="update-item">
            <div class="update-item-icon"><span class="icon content-type-page"></span></div>
            <div class="update-item-content">
                <a href="/wiki/spaces/AI/pages/28526313504/Training+on+AI" title="Artificial Intelligence" data-linked-resource-id="null" data-linked-resource-version="null" data-linked-resource-type="page">Training on AI</a>
                <div class="update-item-meta">Sept 14, 2026<span class="separator"> &bull; </span>contributed by <a class="url fn" data-account-id="000000000000000000000001" href="/wiki/display/~000000000000000000000001">Alex Example</a></div>
            </div>
        </li>
        </ul>
<div class="more-link-container">
    <a class="more-link" href="/wiki/plugins/recently-updated/changes.action?theme=concise&amp;pageSize=10&amp;startIndex=10">Show More</a>
    <img class="waiting-image" alt="Please wait" src="/wiki/s/-595220370/6452/x/_/images/icons/wait.gif">
</div>
    </div>
</div>`;

/** Jira work items datasource whose rows are loaded in the browser: header row, empty body (SDLC space). */
export const CLOUD_JIRA_WORK_ITEMS = `<p>test change&nbsp;</p><p><table class="jiraWorkItemMacroListViewTable"><thead><tr><th class="confluenceTh">Key</th><th class="confluenceTh">Summary</th><th class="confluenceTh">Status</th></tr></thead><tbody /></table></p>`;

/** Legacy editor text colours. */
export const CLOUD_COLORS = `<td class="confluenceTd"><span class="legacy-color-text-red2">N</span> <span class="legacy-color-text-default">$2,729.00</span> <span class="legacy-color-text-blue3">Y</span></td>`;

/** A link to another page's heading uses the editor-style fragment (page 29030154243). */
export const CLOUD_HEADING_LINK = `<p>See <a href="https://uconn.atlassian.net/wiki/spaces/IKB/pages/28881190936/ChatGPT+Edu+Service+Tiers+and+Credit-Based+Usage#Included-Models">included models</a>.</p>`;
/** …while export_view ids on the target page are `PageTitle-HeadingWithoutSpaces`. */
export const CLOUD_HEADING_TARGET = `<h2 id="ChatGPTEduServiceTiersandCredit-BasedUsage-IncludedModels">Included Models</h2><p>Models.</p><h2 id="ChatGPTEduServiceTiersandCredit-BasedUsage-Models">Models</h2>`;

/** Space overview links carry no `data-linked-resource-id`. */
export const CLOUD_SPACE_LINK = `<p>Back to <a href="https://uconn.atlassian.net/wiki/spaces/AI/overview">the AI space</a>.</p>`;

/** v2 `direct-children` item: no parentId, large childPosition values. */
export const CLOUD_DIRECT_CHILD = { id: '29156212770', status: 'current', title: 'OpenAI', type: 'folder', childPosition: 952556969 };

/** v1 `/rest/api/user?accountId=` for an anonymous visitor. */
export const CLOUD_USER_PROFILE_FORBIDDEN = {
  statusCode: 403,
  data: { authorized: false, valid: true, errors: [], successful: false },
  message: 'com.atlassian.confluence.api.service.exceptions.api.PermissionException: User not permitted to view user profiles',
};

/** CQL `type in (folder, …)` with `expand=content.ancestors`: a nested folder and a root one. */
export function cqlNonPageHits(rootFolderId: string) {
  return {
    results: [
      {
        content: {
          id: '29146382352',
          type: 'folder',
          status: 'current',
          title: 'AI Guidelines',
          ancestors: [{ id: '28527526291', type: 'page', title: 'Artificial Intelligence' }],
          _links: { webui: '/spaces/AI/folder/29146382352' },
        },
      },
      {
        content: {
          id: rootFolderId,
          type: 'folder',
          status: 'current',
          title: 'Archive',
          ancestors: [],
          _links: { webui: `/spaces/AI/folder/${rootFolderId}` },
        },
      },
    ],
    start: 0,
    limit: 100,
    size: 2,
    _links: { base: 'https://uconn.atlassian.net/wiki', context: '/wiki' },
  };
}
