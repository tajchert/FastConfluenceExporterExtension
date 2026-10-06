import { afterEach, describe, expect, it, vi } from 'vitest';
import { needsSessionCheck, readSession, sessionStillValid } from '../../lib/confluence/session';
import { ANONYMOUS_USER } from './fixtures/publicSites';

function answer(r: () => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async () => r()));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSession', () => {
  const base = 'https://cwiki.apache.org/confluence';

  it('tells signed-in, anonymous (public site) and signed-out apart', async () => {
    answer(() => new Response(JSON.stringify({ type: 'known', displayName: 'Ada' })));
    await expect(readSession(base)).resolves.toBe('user');
    answer(() => new Response(JSON.stringify(ANONYMOUS_USER)));
    await expect(readSession(base)).resolves.toBe('anonymous');
    answer(() => new Response('{"statusCode":401}', { status: 401 }));
    await expect(readSession(base)).resolves.toBe('signed-out');
    // A same-origin login page instead of JSON.
    answer(() => new Response('<html><form><input type="password"></form></html>'));
    await expect(readSession(base)).resolves.toBe('signed-out');
  });

  it('reports a network failure as unreachable', async () => {
    answer(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(readSession(base)).resolves.toBe('unreachable');
  });
});

describe('session decisions', () => {
  it('checks the session on 401 / network errors, and on 403/404 only for a signed-in start', () => {
    expect(needsSessionCheck(401, 'anonymous')).toBe(true);
    expect(needsSessionCheck(0, undefined)).toBe(true);
    expect(needsSessionCheck(404, 'user')).toBe(true); // DC answers 404 once the session is gone
    expect(needsSessionCheck(403, 'user')).toBe(true);
    expect(needsSessionCheck(404, 'anonymous')).toBe(false);
    expect(needsSessionCheck(500, 'user')).toBe(false);
  });

  it('an anonymous export of a public site survives a network hiccup', () => {
    expect(sessionStillValid('anonymous', 'unreachable')).toBe(true);
    expect(sessionStillValid('anonymous', 'anonymous')).toBe(true);
    expect(sessionStillValid(undefined, 'anonymous')).toBe(true);
  });

  it('signed in → anonymous or signed out means the session expired', () => {
    expect(sessionStillValid('user', 'anonymous')).toBe(false);
    expect(sessionStillValid('user', 'signed-out')).toBe(false);
    expect(sessionStillValid('user', 'unreachable')).toBe(false); // e.g. a failed SSO redirect
    expect(sessionStillValid('user', 'user')).toBe(true);
  });
});
