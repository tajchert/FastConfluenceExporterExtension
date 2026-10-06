/**
 * Behaviour found while validating the extension against two public Confluence sites
 * (fixtures/publicSites.ts): Data Center 9.2 (cwiki.apache.org) and Cloud (uconn.atlassian.net).
 */
import { describe, expect, it } from 'vitest';
import { buildPrintDocument, type AssembleInput } from '../../lib/assemble/document';
import { detectLiveRenderMacros, replaceUnsupportedContent } from '../../lib/assemble/macros';
import { buildPageIndex, sanitizePageHtml, type SanitizeContext } from '../../lib/assemble/sanitize';
import type { PageBody } from '../../lib/confluence/client';
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS, type PageRef, type SiteInfo } from '../../lib/types';
import {
  APACHE,
  CLOUD_COLORS,
  CLOUD_HEADING_LINK,
  CLOUD_HEADING_TARGET,
  CLOUD_JIRA_WORK_ITEMS,
  CLOUD_RECENTLY_UPDATED,
  CLOUD_SPACE_LINK,
  DC_ATTACHMENTS,
  DC_DRAWIO,
  DC_DRAWIO_STORAGE,
  DC_GLIFFY,
  DC_JIRA_ISSUE,
  DC_JIRA_TABLE,
  DC_LINKS,
  DC_PAGETREE,
  UCONN,
} from './fixtures/publicSites';

const NAMES = DEFAULT_SETTINGS.liveRenderMacros;

function render(html: string, site: SiteInfo, over: Partial<SanitizeContext> = {}): HTMLElement {
  const host = document.createElement('div');
  host.append(
    sanitizePageHtml(html, {
      pageId: '1',
      site,
      pageUrl: `${site.baseUrl}/pages/viewpage.action?pageId=1`,
      exportedIds: new Set(['1']),
      includeComments: false,
      ...over,
    }),
  );
  return host;
}

function root(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html');
  return doc.getElementById('root')!;
}

describe('live-render detection on Data Center export_view (no data-macro-name)', () => {
  it('does not flag a Gliffy diagram that export_view already shows as an image', () => {
    // The class scan used to hit the empty `map.gliffy-dynamic` and flag the page.
    expect(detectLiveRenderMacros(DC_GLIFFY, null, NAMES)).toEqual([]);
    expect(detectLiveRenderMacros(DC_GLIFFY, '<ac:structured-macro ac:name="gliffy"/>', NAMES)).toEqual([]);
  });

  it('does not flag draw.io named in storage when export_view has its static PNG', () => {
    expect(detectLiveRenderMacros(DC_DRAWIO, DC_DRAWIO_STORAGE, NAMES)).toEqual([]);
  });

  it('still flags draw.io from storage when export_view has nothing for it', () => {
    expect(detectLiveRenderMacros('<p>No diagram rendered</p>', DC_DRAWIO_STORAGE, NAMES)).toEqual(['drawio']);
    expect(detectLiveRenderMacros('<div class="gliffy-container"><map class="gliffy-dynamic"></map></div>', null, NAMES)).toEqual(['gliffy']);
  });
});

describe('placeholders for client-rendered content (FR-9)', () => {
  it('replaces the empty DC page tree (no macro name) with a placeholder', () => {
    const r = root(DC_PAGETREE);
    expect(replaceUnsupportedContent(r, { pageUrl: `${APACHE.baseUrl}/pages/viewpage.action?pageId=421957302` })).toBe(1);
    expect(r.querySelector('.cf-placeholder')?.textContent).toContain('Page tree');
    expect(r.querySelector('.plugin_pagetree')).toBeNull();
  });

  it('replaces an empty Cloud Jira work items table, keeps a filled one', () => {
    const r = root(CLOUD_JIRA_WORK_ITEMS);
    expect(replaceUnsupportedContent(r, { pageUrl: `${UCONN.baseUrl}/spaces/SDLC/pages/19505152794` })).toBe(1);
    expect(r.querySelector('table')).toBeNull();
    expect(r.querySelector('.cf-placeholder')?.textContent).toContain('Jira work items');

    const filled = root(CLOUD_JIRA_WORK_ITEMS.replace('<tbody />', '<tbody><tr><td>X-1</td><td>Fix</td><td>Done</td></tr></tbody>'));
    expect(replaceUnsupportedContent(filled, { pageUrl: UCONN.baseUrl })).toBe(0);
    expect(filled.querySelector('table')).not.toBeNull();
  });
});

describe('sanitizing markup seen on the public sites', () => {
  it('drops hidden AUI rows and settings (attachments macro)', () => {
    const out = render(DC_ATTACHMENTS, APACHE);
    expect(out.textContent).toContain('grant.pdf');
    expect(out.textContent).not.toMatch(/No labels|Labels/);
    expect(out.querySelector('fieldset')).toBeNull();
  });

  it('drops the "recently updated" spinner, "Show More" and hidden parameters', () => {
    const out = render(CLOUD_RECENTLY_UPDATED, UCONN);
    expect(out.textContent).toContain('Training on AI');
    expect(out.querySelector('img')).toBeNull();
    expect(out.textContent).not.toContain('Show More');
    expect(out.querySelector('.hidden')).toBeNull();
  });

  it('keeps only the key of a single Jira issue that was never filled in', () => {
    const out = render(DC_JIRA_ISSUE, APACHE);
    const issue = out.querySelector('.jira-issue')!;
    expect(issue.textContent!.trim()).toBe('KAFKA-18800');
    expect(issue.querySelector('a')?.getAttribute('href')).toBe('https://issues.apache.org/jira/browse/KAFKA-18800');
    expect(out.textContent).not.toMatch(/Getting issue details|STATUS/);
  });

  it('repeats the DC Jira table header although the table starts with an empty row', () => {
    const out = render(DC_JIRA_TABLE, APACHE);
    const table = out.querySelector('table')!;
    expect(table.querySelector('thead')?.textContent).toContain('Summary');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('keeps legacy text colour classes (print.css maps them to colours)', () => {
    const out = render(`<table><tbody><tr>${CLOUD_COLORS}</tr></tbody></table>`, UCONN);
    expect(out.querySelector('.legacy-color-text-red2')?.textContent).toBe('N');
  });

  it('links /display/ and viewpage.action?title= URLs to exported pages by title (DC)', () => {
    const pageIndex = buildPageIndex(
      [{ id: '231116181', spaceKey: 'KAFKA', title: 'KIP-877: Mechanism for plugins and connectors to register metrics' }],
      APACHE,
    );
    const out = render(DC_LINKS, APACHE, { exportedIds: new Set(['1', '195728007', '231116181']), pageIndex });
    const hrefs = Array.from(out.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    // The tiny link decodes offline (h5KqCw → 195728007); the title links use the index.
    expect(hrefs).toEqual(['#p-195728007', '#p-231116181', '#p-231116181']);
  });

  it('links a Cloud space overview to its exported homepage', () => {
    const pageIndex = buildPageIndex([{ id: '28527526291', spaceKey: 'AI', title: 'Artificial Intelligence', url: `${UCONN.baseUrl}/spaces/AI/overview` }], UCONN);
    const out = render(CLOUD_SPACE_LINK, UCONN, { exportedIds: new Set(['1', '28527526291']), pageIndex });
    expect(out.querySelector('a')?.getAttribute('href')).toBe('#p-28527526291');
  });
});

describe('assembled document', () => {
  const ref = (id: string, title: string, depth: number, spaceKey: string): PageRef => ({
    id,
    type: 'page',
    title,
    depth,
    spaceKey,
    reason: depth === 0 ? 'root' : 'linked',
    url: `${UCONN.baseUrl}/spaces/${spaceKey}/pages/${id}`,
  });
  const body = (r: PageRef, html: string): PageBody => ({ id: r.id, type: 'page', title: r.title, spaceKey: r.spaceKey, html, breadcrumb: [], url: r.url });

  it('resolves a Cloud cross-page heading link to the heading, not just the page', () => {
    const a = ref('29030154243', 'Copilot vs. ChatGPT', 0, 'AI');
    const b = ref('28881190936', 'ChatGPT Edu Service Tiers and Credit-Based Usage', 1, 'IKB');
    const input: AssembleInput = {
      pages: [
        { ref: a, body: body(a, CLOUD_HEADING_LINK) },
        { ref: b, body: body(b, CLOUD_HEADING_TARGET) },
      ],
      allPages: [a, b],
      site: UCONN,
      options: { ...DEFAULT_OPTIONS },
      cover: null,
      toc: false,
      generatedBy: 'test',
    };
    const doc = document.implementation.createHTMLDocument('w');
    buildPrintDocument(doc, input);
    const link = Array.from(doc.querySelectorAll('a')).find((x) => x.textContent === 'included models')!;
    expect(link.getAttribute('href')).toBe('#p28881190936-ChatGPTEduServiceTiersandCredit-BasedUsage-IncludedModels');
  });
});
