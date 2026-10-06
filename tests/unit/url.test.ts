import { describe, expect, it } from 'vitest';
import { contentUrl, decodeTinyCode, isSameSite, parseConfluenceUrl } from '../../lib/confluence/url';
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
const dcRoot: SiteInfo = {
  origin: 'https://wiki.example.org',
  baseUrl: 'https://wiki.example.org',
  contextPath: '',
  flavour: 'server',
};

describe('decodeTinyCode', () => {
  it('decodes the verified vector', () => {
    expect(decodeTinyCode('phDOEg')).toBe('315494566');
  });
  it('handles base64url characters and padding', () => {
    // 0xFB 0xFF → 65531, base64 "+/8=" → url-safe "-_8"
    expect(decodeTinyCode('-_8')).toBe('65531');
    expect(decodeTinyCode('-_8=')).toBe('65531');
  });
  it('handles trailing zero bytes stripped by Confluence', () => {
    // 315494566 encoded with 8 bytes is "phDOEgAAAAA="
    expect(decodeTinyCode('phDOEgAAAAA=')).toBe('315494566');
    expect(decodeTinyCode('phDOEgAAAAA')).toBe('315494566');
  });
  it('decodes large ids without precision loss', () => {
    // 4294967296123 = 0x3E80000007B → LE bytes 7B 00 00 00 E8 03
    const bytes = [0x7b, 0x00, 0x00, 0x00, 0xe8, 0x03];
    const code = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeTinyCode(code)).toBe((0x3e8n * 2n ** 32n + 0x7bn).toString());
  });
  it('rejects invalid codes', () => {
    expect(decodeTinyCode('')).toBeNull();
    expect(decodeTinyCode('AAAA')).toBeNull();
    expect(decodeTinyCode('ab$c')).toBeNull();
  });
});

describe('parseConfluenceUrl — Cloud', () => {
  const p = (path: string) => parseConfluenceUrl(`https://acme.atlassian.net${path}`, '/wiki');

  it('parses pages with and without slug', () => {
    expect(p('/wiki/spaces/ENG/pages/123456/My+Page')).toEqual({ kind: 'page', id: '123456', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG/pages/123456')).toEqual({ kind: 'page', id: '123456', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG/pages/123456/My+Page#Heading?x=1')).toMatchObject({ kind: 'page', id: '123456' });
  });
  it('parses editor URLs', () => {
    expect(p('/wiki/spaces/ENG/pages/edit-v2/42')).toEqual({ kind: 'page', id: '42', spaceKey: 'ENG', editor: true });
    expect(p('/wiki/spaces/ENG/pages/42/edit')).toEqual({ kind: 'page', id: '42', spaceKey: 'ENG', editor: true });
    expect(p('/wiki/spaces/ENG/pages/42/Title/edit-v2')).toMatchObject({ id: '42', editor: true });
    expect(p('/wiki/pages/resumedraft.action?draftId=77&draftShareId=abc')).toEqual({
      kind: 'page',
      id: '77',
      editor: true,
    });
  });
  it('parses folders, whiteboards, databases and embeds', () => {
    expect(p('/wiki/spaces/ENG/folder/9')).toEqual({ kind: 'folder', id: '9', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG/whiteboard/10')).toEqual({ kind: 'whiteboard', id: '10', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG/database/11')).toEqual({ kind: 'database', id: '11', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG/embed/12')).toEqual({ kind: 'embed', id: '12', spaceKey: 'ENG' });
  });
  it('parses blog posts', () => {
    expect(p('/wiki/spaces/ENG/blog/2026/09/30/5555/Release+notes')).toEqual({
      kind: 'blogpost',
      id: '5555',
      spaceKey: 'ENG',
    });
    expect(p('/wiki/spaces/ENG/blog/edit-v2/5555')).toEqual({
      kind: 'blogpost',
      id: '5555',
      spaceKey: 'ENG',
      editor: true,
    });
    expect(p('/wiki/spaces/ENG/blog')).toEqual({ kind: 'space', spaceKey: 'ENG' });
  });
  it('parses space URLs', () => {
    expect(p('/wiki/spaces/ENG/overview')).toEqual({ kind: 'space', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG')).toEqual({ kind: 'space', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/ENG/')).toEqual({ kind: 'space', spaceKey: 'ENG' });
    expect(p('/wiki/spaces/~5b1234abcd/overview')).toEqual({ kind: 'space', spaceKey: '~5b1234abcd' });
    expect(p('/wiki/spaces/ENG/pages')).toEqual({ kind: 'space', spaceKey: 'ENG' });
  });
  it('parses tiny links', () => {
    expect(p('/wiki/x/phDOEg')).toEqual({ kind: 'tiny', tinyCode: 'phDOEg', id: '315494566' });
  });
  it('parses legacy action URLs', () => {
    expect(p('/wiki/pages/viewpage.action?pageId=321')).toEqual({ kind: 'page', id: '321' });
    expect(p('/wiki/plugins/viewsource/viewpagesrc.action?pageId=321')).toEqual({ kind: 'page', id: '321' });
    expect(p('/wiki/pages/editpage.action?pageId=321')).toEqual({ kind: 'page', id: '321', editor: true });
  });
  it('returns unknown for non-content URLs', () => {
    expect(p('/wiki/home')).toEqual({ kind: 'unknown' });
    expect(p('/wiki/')).toEqual({ kind: 'unknown' });
    expect(parseConfluenceUrl('not a url')).toEqual({ kind: 'unknown' });
  });
  it('works without a known context path', () => {
    expect(parseConfluenceUrl('https://acme.atlassian.net/wiki/spaces/ENG/pages/1/T')).toEqual({
      kind: 'page',
      id: '1',
      spaceKey: 'ENG',
    });
    expect(parseConfluenceUrl('https://docs.acme.com/wiki/x/phDOEg')).toMatchObject({ kind: 'tiny', id: '315494566' });
  });
});

describe('parseConfluenceUrl — Data Center / Server', () => {
  it('parses display URLs with + and percent encoding', () => {
    expect(parseConfluenceUrl('https://wiki.example.org/display/ENG/Release+Plan+%2B+Notes', '')).toEqual({
      kind: 'page',
      spaceKey: 'ENG',
      title: 'Release Plan + Notes',
    });
    expect(parseConfluenceUrl('https://wiki.example.org/display/ENG/Caf%C3%A9+Menu?focusedCommentId=1', '')).toEqual({
      kind: 'page',
      spaceKey: 'ENG',
      title: 'Café Menu',
    });
  });
  it('parses space and personal space display URLs', () => {
    expect(parseConfluenceUrl('https://wiki.example.org/display/ENG', '')).toEqual({ kind: 'space', spaceKey: 'ENG' });
    expect(parseConfluenceUrl('https://wiki.example.org/display/ENG/', '')).toEqual({ kind: 'space', spaceKey: 'ENG' });
    expect(parseConfluenceUrl('https://wiki.example.org/display/~jdoe', '')).toEqual({ kind: 'space', spaceKey: '~jdoe' });
  });
  it('parses DC blog post URLs', () => {
    expect(parseConfluenceUrl('https://wiki.example.org/display/ENG/2024/01/05/Kickoff+Notes', '')).toEqual({
      kind: 'blogpost',
      spaceKey: 'ENG',
      title: 'Kickoff Notes',
    });
  });
  it('handles a context path', () => {
    const base = 'https://intranet.example.org/confluence';
    expect(parseConfluenceUrl(`${base}/display/OPS/Runbook`, '/confluence')).toEqual({
      kind: 'page',
      spaceKey: 'OPS',
      title: 'Runbook',
    });
    expect(parseConfluenceUrl(`${base}/pages/viewpage.action?pageId=98765`, '/confluence')).toEqual({
      kind: 'page',
      id: '98765',
    });
    expect(parseConfluenceUrl(`${base}/spaces/OPS/pages/98765/Runbook`, '/confluence')).toEqual({
      kind: 'page',
      id: '98765',
      spaceKey: 'OPS',
    });
    expect(parseConfluenceUrl(`${base}/x/phDOEg`, '/confluence')).toMatchObject({ kind: 'tiny', id: '315494566' });
    // auto-detected context path
    expect(parseConfluenceUrl(`${base}/display/OPS/Runbook`)).toMatchObject({ kind: 'page', title: 'Runbook' });
  });
  it('parses viewpage.action by title and viewspace.action', () => {
    expect(
      parseConfluenceUrl('https://wiki.example.org/pages/viewpage.action?spaceKey=ENG&title=Some+Page', ''),
    ).toEqual({ kind: 'page', spaceKey: 'ENG', title: 'Some Page' });
    expect(parseConfluenceUrl('https://wiki.example.org/spaces/viewspace.action?key=ENG', '')).toEqual({
      kind: 'space',
      spaceKey: 'ENG',
    });
    expect(parseConfluenceUrl('https://wiki.example.org/pages/viewpageattachments.action?pageId=5', '')).toEqual({
      kind: 'page',
      id: '5',
    });
  });
});

describe('contentUrl', () => {
  it('builds Cloud URLs', () => {
    expect(contentUrl(cloud, { id: '1', type: 'page', spaceKey: 'ENG' })).toBe(
      'https://acme.atlassian.net/wiki/spaces/ENG/pages/1',
    );
    expect(contentUrl(cloud, { id: '2', type: 'folder', spaceKey: 'ENG' })).toBe(
      'https://acme.atlassian.net/wiki/spaces/ENG/folder/2',
    );
    expect(contentUrl(cloud, { id: '3', type: 'blogpost', spaceKey: 'ENG' })).toBe(
      'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=3',
    );
    expect(contentUrl(cloud, { id: '4', type: 'page' })).toBe(
      'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=4',
    );
  });
  it('builds DC URLs', () => {
    expect(contentUrl(dc, { id: '5', type: 'page', spaceKey: 'OPS' })).toBe(
      'https://intranet.example.org/confluence/pages/viewpage.action?pageId=5',
    );
    expect(contentUrl(dcRoot, { id: '6', type: 'page' })).toBe('https://wiki.example.org/pages/viewpage.action?pageId=6');
  });
});

describe('isSameSite', () => {
  it('checks origin and context path', () => {
    expect(isSameSite('https://acme.atlassian.net/wiki/spaces/A/pages/1', cloud)).toBe(true);
    expect(isSameSite('/wiki/spaces/A/pages/1', cloud)).toBe(true);
    expect(isSameSite('https://acme.atlassian.net/browse/ABC-1', cloud)).toBe(false);
    expect(isSameSite('https://other.atlassian.net/wiki/spaces/A/pages/1', cloud)).toBe(false);
    expect(isSameSite('https://intranet.example.org/confluence/display/X', dc)).toBe(true);
    expect(isSameSite('https://intranet.example.org/confluencex/display/X', dc)).toBe(false);
    expect(isSameSite('https://wiki.example.org/anything', dcRoot)).toBe(true);
  });
});
