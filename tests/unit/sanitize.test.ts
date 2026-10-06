import { describe, expect, it } from 'vitest';
import { contentIdFromUrl, sanitizePageHtml, type SanitizeContext } from '../../lib/assemble/sanitize';
import { hostileHtml } from '../e2e/mock-confluence/hostile.mjs';
import {
  CODE,
  COMMENTED,
  EXPAND,
  FULL_PAGE,
  HEADINGS,
  IFRAME,
  IMAGES,
  INFO_PANEL,
  JIRA_TABLE,
  LINKS,
  PAGE_ID,
  PAGE_URL,
  SERVER_SITE,
  SITE,
  TABLE,
  TASKS,
} from './fixtures/exportView';

function ctx(over: Partial<SanitizeContext> = {}): SanitizeContext {
  return {
    pageId: PAGE_ID,
    site: SITE,
    pageUrl: PAGE_URL,
    exportedIds: new Set([PAGE_ID, '111', '222']),
    includeComments: false,
    ...over,
  };
}

function render(html: string, over: Partial<SanitizeContext> = {}): HTMLElement {
  const host = document.createElement('div');
  host.append(sanitizePageHtml(html, ctx(over)));
  return host;
}

function hrefOf(root: Element, text: string): string | null {
  const a = Array.from(root.querySelectorAll('a')).find((x) => x.textContent?.trim() === text);
  if (!a) throw new Error(`link "${text}" not found`);
  return a.getAttribute('href');
}

describe('sanitizePageHtml', () => {
  it('returns a DocumentFragment and removes scripts, styles and event handlers', () => {
    const frag = sanitizePageHtml(FULL_PAGE, ctx());
    expect(frag.nodeType).toBe(11);
    const host = document.createElement('div');
    host.append(frag);
    expect(host.querySelector('script, style, iframe, form, input, button')).toBeNull();
    expect(host.innerHTML).not.toMatch(/onclick|javascript:|__pwned/);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('neutralizes known injection vectors (fast check; the E2E suite repeats it in Chromium)', () => {
    const host = render(hostileHtml((n) => `window.__pwned=${n}`));
    expect(host.querySelector('script, iframe, object, embed, base, meta, form, input, button, template, noscript')).toBeNull();
    for (const el of Array.from(host.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name, `${el.tagName} ${attr.name}`).not.toMatch(/^on/i);
        expect(attr.value, `${el.tagName} ${attr.name}`).not.toMatch(/^\s*(java\s*script|data):/i);
      }
    }
    expect(host.innerHTML).not.toMatch(/javascript:/i);
    expect(host.textContent).toContain('End of the hostile page.');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('keeps inline styles but drops absolute/fixed positioning', () => {
    const root = render(TABLE);
    const td = Array.from(root.querySelectorAll('td')).find((c) => c.textContent?.includes('Minor units'))!;
    const style = td.getAttribute('style') || '';
    expect(style).toMatch(/color:\s*red/);
    expect(style).not.toMatch(/position|top/);
  });

  it('demotes headings and prefixes ids per page', () => {
    const root = render(HEADINGS);
    expect(root.querySelector('h1')).toBeNull();
    const h2 = root.querySelector('h2')!;
    expect(h2.textContent).toBe('Overview');
    expect(h2.id).toBe(`p${PAGE_ID}-CheckoutV3TechSpec-Overview`);
    expect(root.querySelector('h3')!.id).toBe(`p${PAGE_ID}-CheckoutV3TechSpec-Details`);
    // h6 stays h6
    expect(root.querySelectorAll('h6')).toHaveLength(1);
  });

  it('rewrites links to exported pages, same-page anchors and relative URLs', () => {
    const root = render(LINKS);
    expect(hrefOf(root, 'Architecture')).toBe('#p-111');
    expect(hrefOf(root, 'Glossary terms')).toBe('#p222-Glossary-Terms');
    expect(hrefOf(root, 'Runbook')).toBe('https://acme.atlassian.net/wiki/spaces/OPS/pages/999/Runbook');
    expect(hrefOf(root, 'legacy link')).toBe('#p-111');
    expect(hrefOf(root, 'tiny self link')).toBe(`#p-${PAGE_ID}`);
    expect(hrefOf(root, 'overview')).toBe(`#p${PAGE_ID}-CheckoutV3TechSpec-Overview`);
    expect(hrefOf(root, 'bad')).toBeNull();
    expect(hrefOf(root, 'external')).toBe('https://example.com/docs');
    expect(hrefOf(root, 'spec.pdf')).toBe(
      'https://acme.atlassian.net/wiki/download/attachments/315494566/spec.pdf?version=1&api=v2',
    );
    expect(hrefOf(root, 'Jane Doe')).toMatch(/^https:\/\/acme\.atlassian\.net\/wiki\/people\/abc/);
    expect(root.querySelector('[target]')).toBeNull();
  });

  it('does not rewrite links to non-exported pages even when the id is parseable', () => {
    const root = render(LINKS, { exportedIds: new Set() });
    expect(hrefOf(root, 'Architecture')).toBe('https://acme.atlassian.net/wiki/spaces/ENG/pages/111/Architecture');
  });

  it('prefers the original image over the thumbnail and removes srcset/lazy loading', () => {
    const root = render(IMAGES);
    const img = root.querySelector('img.confluence-embedded-image')!;
    expect(img.getAttribute('src')).toBe(
      'https://acme.atlassian.net/wiki/download/attachments/315494566/flow.png?version=1&api=v2',
    );
    expect(img.hasAttribute('srcset')).toBe(false);
    expect(img.hasAttribute('loading')).toBe(false);
    expect(img.getAttribute('data-linked-resource-default-alias')).toBe('flow.png');
    const emoticon = root.querySelector('img.emoticon-smile')!;
    expect(emoticon.getAttribute('src')).toBe('https://acme.atlassian.net/wiki/images/icons/emoticons/smile.svg');
    // Standard emoji become text (no third-party request, vector in the PDF).
    expect(root.querySelector('.cf-emoji')!.textContent).toBe('😀');
  });

  it('forces expand macros open and turns the control into a title', () => {
    const root = render(EXPAND);
    expect(root.querySelector('.expand-control')).toBeNull();
    expect(root.querySelector('.cf-expand-title')!.textContent).toBe('Show the rollout plan');
    const content = root.querySelector('.expand-content') as HTMLElement;
    expect(content.classList.contains('expand-hidden')).toBe(false);
    expect(content.getAttribute('style') || '').not.toMatch(/display/);
  });

  it('renders task lists and checkboxes as glyphs', () => {
    const root = render(TASKS);
    const boxes = Array.from(root.querySelectorAll('.cf-task-box')).map((b) => b.textContent);
    expect(boxes).toEqual(['☑', '☐', '☑']);
    expect(root.querySelector('li.cf-task-done')!.textContent).toContain('Write spec');
  });

  it('unwraps inline comment markers unless comments are included', () => {
    expect(render(COMMENTED).querySelector('.inline-comment-marker')).toBeNull();
    expect(render(COMMENTED).textContent).toContain('a comment');
    expect(render(COMMENTED, { includeComments: true }).querySelector('.inline-comment-marker.cf-comment')).not.toBeNull();
  });

  it('replaces iframes with a placeholder linking to the source and the page', () => {
    const root = render(IFRAME);
    const ph = root.querySelector('.cf-placeholder')!;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toContain('Demo video');
    const links = Array.from(ph.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).toContain('https://www.youtube.com/embed/abc123');
    expect(links).toContain(PAGE_URL);
  });

  it('keeps Jira static tables, panels and code blocks', () => {
    const root = render(JIRA_TABLE + INFO_PANEL + CODE);
    expect(root.querySelector('table.aui td.jira-macro-table-underline-pdfexport')).not.toBeNull();
    expect(root.querySelector('.aui-lozenge-success')!.textContent).toBe('Done');
    expect(root.querySelector('.confluence-information-macro-information')).not.toBeNull();
    expect(root.querySelector('.confluence-information-macro-icon')).toBeNull();
    expect(root.querySelector('pre.syntaxhighlighter-pre')!.textContent).toContain('public class Checkout');
  });

  it('moves a leading row of <th> cells into <thead> so it repeats on every sheet', () => {
    const root = render(TABLE);
    const thead = root.querySelector('table thead')!;
    expect(thead).not.toBeNull();
    expect(thead.textContent).toContain('Field');
    expect(root.querySelectorAll('table tbody tr')).toHaveLength(2);
  });

  it('tolerates empty and malformed input', () => {
    expect(render('').textContent).toBe('');
    expect(() => render('<div><p>unclosed <b>bold')).not.toThrow();
  });
});

describe('contentIdFromUrl', () => {
  it('parses Cloud page, blog, folder and tiny URLs', () => {
    const u = (s: string) => new URL(s);
    expect(contentIdFromUrl(u('https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Title'), SITE)).toBe('123');
    expect(contentIdFromUrl(u('https://acme.atlassian.net/wiki/spaces/ENG/pages/edit-v2/123'), SITE)).toBe('123');
    expect(contentIdFromUrl(u('https://acme.atlassian.net/wiki/spaces/ENG/blog/2024/01/31/456/Post'), SITE)).toBe('456');
    expect(contentIdFromUrl(u('https://acme.atlassian.net/wiki/spaces/ENG/folder/789'), SITE)).toBe('789');
    expect(contentIdFromUrl(u('https://acme.atlassian.net/wiki/x/phDOEg'), SITE)).toBe('315494566');
    expect(contentIdFromUrl(u('https://other.atlassian.net/wiki/spaces/ENG/pages/123'), SITE)).toBeNull();
    expect(contentIdFromUrl(u('https://acme.atlassian.net/browse/PAY-1'), SITE)).toBeNull();
  });

  it('respects a Data Center context path', () => {
    const u = (s: string) => new URL(s);
    expect(contentIdFromUrl(u('https://intranet.acme.corp/confluence/pages/viewpage.action?pageId=42'), SERVER_SITE)).toBe('42');
    expect(contentIdFromUrl(u('https://intranet.acme.corp/pages/viewpage.action?pageId=42'), SERVER_SITE)).toBeNull();
  });
});
