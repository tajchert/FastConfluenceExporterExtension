import { describe, expect, it } from 'vitest';
import { extractLinksFromExportView, extractLinksFromStorage } from '../../lib/confluence/links';
import type { SiteInfo } from '../../lib/types';

const cloud: SiteInfo = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud',
};
const dc: SiteInfo = {
  origin: 'https://intranet.example.org',
  baseUrl: 'https://intranet.example.org/confluence',
  contextPath: '/confluence',
  flavour: 'server',
};

describe('extractLinksFromExportView', () => {
  it('collects linked page ids, URLs, smart links and tiny links', () => {
    const html = `
      <p><a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/200/Design" data-linked-resource-id="200" data-linked-resource-type="page">Design</a></p>
      <p><a href="/wiki/spaces/ENG/pages/201/Other">rel</a></p>
      <p><a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/202" data-card-appearance="inline">card</a></p>
      <p><a href="https://acme.atlassian.net/wiki/x/phDOEg">tiny</a></p>
      <p><a href="https://acme.atlassian.net/wiki/spaces/ENG/folder/300">folder</a></p>
      <p><a href="https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=203">legacy</a></p>
      <p><a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/200/Design#Section">dup</a></p>
    `;
    const t = extractLinksFromExportView(html, cloud, '100');
    expect(t.ids).toEqual(['200', '201', '202', '315494566', '300', '203']);
    expect(t.titles).toEqual([]);
    expect(t.tinyCodes).toEqual([]);
  });

  it('ignores self, anchors, attachments, Jira, people, external and mailto links', () => {
    const html = `
      <a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/100/Self">self</a>
      <a href="#Self-Heading">anchor</a>
      <a href="https://acme.atlassian.net/wiki/download/attachments/100/file.pdf?api=v2" data-linked-resource-type="attachment" data-linked-resource-id="999">att</a>
      <a href="https://acme.atlassian.net/wiki/pages/viewpageattachments.action?pageId=555&preview=x.png">att2</a>
      <a href="https://acme.atlassian.net/browse/ABC-1">jira</a>
      <a href="https://acme.atlassian.net/wiki/people/5b12">person</a>
      <a class="confluence-userlink user-mention" href="https://acme.atlassian.net/wiki/spaces/~x/pages/777">mention</a>
      <a href="https://example.com/wiki/spaces/ENG/pages/888">external</a>
      <a href="mailto:a@b.c">mail</a>
      <a href="https://acme.atlassian.net/wiki/spaces/ENG/overview">space</a>
      <img src="https://acme.atlassian.net/wiki/download/attachments/100/a.png" data-linked-resource-id="321" data-linked-resource-type="attachment">
    `;
    const t = extractLinksFromExportView(html, cloud, '100');
    expect(t).toEqual({ ids: [], titles: [], tinyCodes: [] });
  });

  it('does not treat a page slug that mentions attachments/download as ignored', () => {
    const html = `<a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/42/Download+attachments">x</a>`;
    expect(extractLinksFromExportView(html, cloud, '1').ids).toEqual(['42']);
  });

  it('handles DC display links with a context path', () => {
    const html = `
      <a href="/confluence/display/OPS/Runbook+Index">by title</a>
      <a href="/confluence/pages/viewpage.action?pageId=77">by id</a>
      <a href="/confluence/display/~jdoe">profile</a>
      <a href="/other/display/OPS/Elsewhere">other app</a>
    `;
    const t = extractLinksFromExportView(html, dc, '1');
    expect(t.ids).toEqual(['77']);
    expect(t.titles).toEqual([{ spaceKey: 'OPS', title: 'Runbook Index' }]);
  });

  it('returns empty targets for empty html', () => {
    expect(extractLinksFromExportView('', cloud, '1')).toEqual({ ids: [], titles: [], tinyCodes: [] });
  });
});

describe('extractLinksFromStorage', () => {
  it('collects ri:page titles (with/without space), content ids and hrefs', () => {
    const storage = `
      <p><ac:link><ri:page ri:content-title="Same Space Page" /></ac:link></p>
      <p><ac:link><ri:page ri:space-key="OPS" ri:content-title="Tom &amp; Jerry" /><ac:plain-text-link-body><![CDATA[x]]></ac:plain-text-link-body></ac:link></p>
      <p><ac:link><ri:page ri:content-id="4242" ri:content-title="By Id" /></ac:link></p>
      <p><ac:link><ri:content-entity ri:content-id="5151" /></ac:link></p>
      <p><a href="https://acme.atlassian.net/wiki/spaces/ENG/pages/600/Doc">doc</a></p>
      <p><ac:image><ri:attachment ri:filename="a.png"><ri:page ri:content-title="Attachment Owner" /></ri:attachment></ac:image></p>
      <p><ac:link><ri:attachment ri:filename="b.pdf" /></ac:link></p>
      <p><ac:link><ri:page ri:content-title="Same Space Page" /></ac:link></p>
      <p><a href="https://acme.atlassian.net/wiki/x/phDOEg">tiny</a></p>
      <p><a href="https://elsewhere.com/x">ext</a></p>
    `;
    const t = extractLinksFromStorage(storage, cloud, '1');
    expect(t.titles).toEqual([{ title: 'Same Space Page' }, { spaceKey: 'OPS', title: 'Tom & Jerry' }]);
    expect(t.ids).toEqual(['4242', '5151', '600', '315494566']);
    expect(t.tinyCodes).toEqual([]);
  });

  it('skips the page itself by id', () => {
    const storage = `<ac:link><ri:page ri:content-id="1" /></ac:link><a href="/wiki/spaces/A/pages/1">self</a>`;
    expect(extractLinksFromStorage(storage, cloud, '1')).toEqual({ ids: [], titles: [], tinyCodes: [] });
  });
});
