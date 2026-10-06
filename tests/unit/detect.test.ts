import { afterEach, describe, expect, it, vi } from 'vitest';
import { probePage } from '../../lib/confluence/detect';
import type { ProbeResult } from '../../lib/messages';

/**
 * probePage is serialized by chrome.scripting.executeScript, so we run it the same way:
 * re-created from its source text, without access to module scope.
 */
const isolated = new Function(`return (${probePage.toString()});`)() as typeof probePage;

function setPage(url: string, metas: Record<string, string> = {}) {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  document.head.innerHTML = Object.entries(metas)
    .map(([k, v]) => `<meta name="${k}" content="${v}">`)
    .join('');
  document.body.removeAttribute('id');
}

function route(handler: (u: URL) => unknown) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      seen.push(u.pathname + u.search);
      const body = handler(u);
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probePage', () => {
  it('returns isConfluence:false for other sites', async () => {
    setPage('https://example.com/some/page');
    route(() => undefined);
    await expect(isolated()).resolves.toEqual({ isConfluence: false, url: 'https://example.com/some/page' });
  });

  it('does not treat Jira (ajs metas) as Confluence', async () => {
    setPage('https://jira.example.com/browse/ABC-1', { 'ajs-base-url': 'https://jira.example.com', 'application-name': 'JIRA' });
    route(() => undefined);
    await expect(isolated()).resolves.toMatchObject({ isConfluence: false });
  });

  it('detects a Cloud page from the URL (stale metas ignored)', async () => {
    setPage('https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Design', {
      'ajs-base-url': 'https://acme.atlassian.net/wiki',
      'ajs-context-path': '/wiki',
      'ajs-cloud-id': 'abc',
      'ajs-page-id': '999',
      'ajs-current-user-fullname': 'Ada Lovelace',
      'ajs-site-title': 'Acme',
    });
    route((u) => {
      if (u.pathname === '/wiki/rest/api/content/123')
        return { id: '123', type: 'page', title: 'Design', space: { key: 'ENG', id: 77 }, version: { when: '2026-09-30' } };
      return undefined;
    });
    const r = (await isolated()) as Extract<ProbeResult, { isConfluence: true }>;
    expect(r).toMatchObject({
      isConfluence: true,
      site: { origin: 'https://acme.atlassian.net', baseUrl: 'https://acme.atlassian.net/wiki', contextPath: '/wiki', flavour: 'cloud', siteTitle: 'Acme' },
      kind: 'page',
      id: '123',
      spaceKey: 'ENG',
      spaceId: '77',
      title: 'Design',
      lastUpdated: '2026-09-30',
      userDisplayName: 'Ada Lovelace',
    });
  });

  it('resolves a Cloud space overview to its homepage', async () => {
    setPage('https://acme.atlassian.net/wiki/spaces/ENG/overview', { 'ajs-cloud-id': 'abc' });
    route((u) => {
      if (u.pathname === '/wiki/api/v2/spaces') return { results: [{ id: 77, key: 'ENG', name: 'Engineering', homepageId: 5 }] };
      if (u.pathname === '/wiki/rest/api/user/current') return { displayName: 'Ada' };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({ kind: 'space', id: '5', spaceKey: 'ENG', spaceId: '77', title: 'Engineering', userDisplayName: 'Ada' });
  });

  it('decodes tiny links offline and discovers the type', async () => {
    setPage('https://acme.atlassian.net/wiki/x/phDOEg');
    route((u) => {
      if (u.pathname === '/wiki/rest/api/content/315494566') return { id: '315494566', type: 'blogpost', title: 'News', space: { key: 'N' } };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({ kind: 'blogpost', id: '315494566', spaceKey: 'N', title: 'News' });
  });

  it('detects DC with a context path and resolves display URLs', async () => {
    setPage('https://intranet.example.org/confluence/display/OPS/Run+Book', {
      'ajs-context-path': '/confluence',
      'ajs-version-number': '8.5.4',
      'application-name': 'Confluence',
    });
    route((u) => {
      if (u.pathname === '/confluence/rest/api/content' && u.searchParams.get('title') === 'Run Book')
        return { results: [{ id: 42, title: 'Run Book', version: { when: '2025-01-01' }, space: { id: 3 } }] };
      if (u.pathname === '/confluence/rest/api/user/current') return { displayName: 'Linus' };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({
      site: { baseUrl: 'https://intranet.example.org/confluence', contextPath: '/confluence', flavour: 'server' },
      kind: 'page',
      id: '42',
      spaceKey: 'OPS',
      title: 'Run Book',
      userDisplayName: 'Linus',
    });
  });

  it('decides the flavour of a custom domain via the v2 API', async () => {
    setPage('https://docs.acme.com/wiki/spaces/ENG/folder/8', { 'ajs-context-path': '/wiki', 'ajs-confluence-flavour': 'x' });
    route((u) => {
      if (u.pathname === '/wiki/api/v2/spaces') return { results: [] };
      if (u.pathname === '/wiki/api/v2/folders/8') return { id: '8', title: 'Specs', spaceId: 77 };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({
      site: { flavour: 'cloud', baseUrl: 'https://docs.acme.com/wiki' },
      kind: 'folder',
      id: '8',
      title: 'Specs',
      spaceKey: 'ENG',
    });
  });

  it('Cloud page: REST v2 first; an anonymous visitor costs no user request', async () => {
    // Metas as served to anonymous visitors of a public Cloud site (uconn.atlassian.net).
    setPage('https://uconn.atlassian.net/wiki/spaces/AI/pages/29030154243/Copilot+vs.+ChatGPT', {
      'ajs-base-url': 'https://uconn.atlassian.net/wiki',
      'ajs-context-path': '/wiki',
      'ajs-cloud-id': 'x',
      'ajs-remote-user': '',
      'ajs-atlassian-account-id': '',
      'ajs-current-user-fullname': '',
    });
    const seen = route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/29030154243')
        return { id: '29030154243', title: 'Copilot vs. ChatGPT', spaceId: '28527525901', version: { createdAt: '2026-09-01T10:00:00.000Z' } };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({ kind: 'page', id: '29030154243', spaceKey: 'AI', spaceId: '28527525901', title: 'Copilot vs. ChatGPT', lastUpdated: '2026-09-01T10:00:00.000Z' });
    expect(seen).toEqual(['/wiki/api/v2/pages/29030154243']);
    expect((await isolated()) as object).not.toHaveProperty('userDisplayName');
  });

  it('Cloud folder: createdAt in epoch milliseconds becomes an ISO date', async () => {
    setPage('https://uconn.atlassian.net/wiki/spaces/AI/folder/29156212770', { 'ajs-cloud-id': 'x' });
    route((u) => {
      if (u.pathname === '/wiki/api/v2/folders/29156212770') return { id: '29156212770', title: 'OpenAI', spaceId: '1', createdAt: 1788880748346 };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({ kind: 'folder', title: 'OpenAI', lastUpdated: new Date(1788880748346).toISOString() });
  });

  it('resolves the tinyurl.action address Cloud shows for /x/ links', async () => {
    setPage('https://uconn.atlassian.net/wiki/pages/tinyurl.action?urlIdentifier=k4FfpAY', { 'ajs-cloud-id': 'x' });
    route((u) => {
      if (u.pathname === '/wiki/api/v2/pages/28527526291') return { id: '28527526291', title: 'Artificial Intelligence', spaceId: '7' };
      if (u.pathname === '/wiki/rest/api/content/28527526291') return { id: '28527526291', type: 'page', title: 'Artificial Intelligence', space: { key: 'AI', id: 7 } };
      return undefined;
    });
    await expect(isolated()).resolves.toMatchObject({ kind: 'page', id: '28527526291', title: 'Artificial Intelligence' });
  });

  it('DC blog post without ajs-site-title: the site name comes from the document title', async () => {
    setPage('https://cwiki.apache.org/confluence/spaces/TAPESTRY/blog/2026/04/14/421954354/Tapestry+5.9.1+released', {
      'ajs-context-path': '/confluence',
      'ajs-version-number': '9.2.21',
      'ajs-remote-user': '',
      'ajs-current-user-fullname': '',
    });
    document.body.id = 'com-atlassian-confluence';
    document.title = 'Tapestry 5.9.1 released - Apache Tapestry - Apache Software Foundation';
    route((u) => {
      if (u.pathname === '/confluence/rest/api/content/421954354')
        return { id: '421954354', type: 'blogpost', title: 'Tapestry 5.9.1 released', space: { key: 'TAPESTRY', id: 1 }, version: { when: '2026-04-14' } };
      if (u.pathname === '/confluence/rest/api/user/current') return { type: 'anonymous', displayName: 'Anonymous' };
      return undefined;
    });
    const r = await isolated();
    expect(r).toMatchObject({ kind: 'blogpost', id: '421954354', site: { flavour: 'server', siteTitle: 'Apache Software Foundation' } });
    expect(r).not.toHaveProperty('userDisplayName');
    document.title = '';
  });

  it('never throws when the API is unreachable', async () => {
    setPage('https://acme.atlassian.net/wiki/spaces/ENG/pages/1/X');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    await expect(isolated()).resolves.toMatchObject({ isConfluence: true, kind: 'page', id: '1', spaceKey: 'ENG' });
  });
});
