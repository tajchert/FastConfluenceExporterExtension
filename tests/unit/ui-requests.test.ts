import { describe, expect, it } from 'vitest';
import { availableModes, buildRequest, isSpaceBlocked } from '../../entrypoints/popup/modes';
import { applyPolicy, describeRequest, validateRequest } from '../../entrypoints/preview/request';
import { DEFAULT_OPTIONS, type PageContext } from '../../lib/types';

const site = {
  origin: 'https://acme.atlassian.net',
  baseUrl: 'https://acme.atlassian.net/wiki',
  contextPath: '/wiki',
  flavour: 'cloud' as const,
};

const ctx = (over: Partial<PageContext> = {}): PageContext => ({
  site,
  kind: 'page',
  id: '123',
  spaceKey: 'ENG',
  title: 'Spec',
  url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123/Spec',
  userDisplayName: 'Ada',
  ...over,
});

describe('popup modes', () => {
  it('offers modes per content kind', () => {
    expect(availableModes(ctx())).toEqual(['current', 'subtree', 'linked', 'selection', 'space']);
    expect(availableModes(ctx({ kind: 'folder' }))).toEqual(['folder', 'selection', 'space']);
    expect(availableModes(ctx({ kind: 'blogpost' }))).toEqual(['current', 'linked', 'selection', 'space']);
    expect(availableModes(ctx({ kind: 'whiteboard' }))).toEqual(['selection', 'space']);
    expect(availableModes(ctx({ spaceKey: undefined }))).toEqual(['current', 'subtree', 'linked']);
    expect(availableModes(ctx({ id: undefined }))).toEqual([]);
  });

  it('builds requests with a root id for every mode', () => {
    const base = { depth: 2 as const, linkDepth: 2 as const, options: DEFAULT_OPTIONS, sourceTabId: 7 };
    const sub = buildRequest(ctx(), { ...base, mode: 'subtree' });
    expect(sub).toMatchObject({ mode: 'subtree', depth: 2, root: { id: '123', type: 'page', title: 'Spec' }, sourceTabId: 7 });
    expect(sub.userDisplayName).toBe('Ada');
    expect(sub.options).not.toBe(DEFAULT_OPTIONS);

    expect(buildRequest(ctx(), { ...base, mode: 'linked' })).toMatchObject({ linkDepth: 2 });
    expect(buildRequest(ctx({ kind: 'folder' }), { ...base, mode: 'folder' })).toMatchObject({
      depth: 'all',
      root: { id: '123', type: 'folder' },
    });
    const space = buildRequest(ctx({ kind: 'space', title: 'Engineering' }), { ...base, mode: 'space' });
    expect(space.root).toMatchObject({ id: '123', type: 'page', title: 'Engineering', spaceKey: 'ENG' });
    expect(buildRequest(ctx(), { ...base, mode: 'space' }).root.title).toBe('ENG');
    expect(buildRequest(ctx(), { ...base, mode: 'selection' }).selectedIds).toEqual(['123']);
  });

  it('blocked spaces', () => {
    expect(isSpaceBlocked('hr', ['HR'])).toBe(true);
    expect(isSpaceBlocked('ENG', ['HR'])).toBe(false);
    expect(isSpaceBlocked(undefined, ['HR'])).toBe(false);
  });
});

describe('preview request validation', () => {
  const good = () => buildRequest(ctx(), { mode: 'subtree', depth: 'all', linkDepth: 1, options: DEFAULT_OPTIONS });

  it('accepts a popup request and fills missing options', () => {
    const r = good();
    const { options: _o, ...noOptions } = r;
    const v = validateRequest(JSON.parse(JSON.stringify(noOptions)));
    expect(v?.options).toEqual(DEFAULT_OPTIONS);
    expect(validateRequest(r)?.root.id).toBe('123');
  });

  it('rejects malformed input', () => {
    expect(validateRequest(null)).toBeNull();
    expect(validateRequest({ ...good(), mode: 'everything' })).toBeNull();
    expect(validateRequest({ ...good(), root: { id: '', type: 'page' } })).toBeNull();
    expect(validateRequest({ ...good(), site: { ...site, origin: 'javascript:alert(1)' } })).toBeNull();
    expect(validateRequest({ ...good(), site: { ...site, baseUrl: 'https://evil.example/wiki' } })).toBeNull();
    expect(validateRequest({ ...good(), mode: 'selection', root: { id: '1', type: 'page' } })).toBeNull();
    expect(validateRequest({ ...good(), selectedIds: [1, 2] })).toBeNull();
  });

  it('policy disables live render', () => {
    const { options, locked } = applyPolicy({ ...DEFAULT_OPTIONS, liveRender: true }, { disableLiveRender: true });
    expect(options.liveRender).toBe(false);
    expect(locked.has('liveRender')).toBe(true);
    expect(applyPolicy(DEFAULT_OPTIONS, {}).locked.size).toBe(0);
  });

  it('describes requests', () => {
    expect(describeRequest(good())).toContain('“Spec” and its sub-pages');
    expect(describeRequest({ ...good(), mode: 'space' })).toBe('Entire space ENG');
  });
});
