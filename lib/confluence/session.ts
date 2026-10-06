/**
 * Who is the worker tab talking to Confluence as? Public sites (Cloud and Data Center) can be
 * read anonymously, so "anonymous" is a valid session, not a signed-out one. What matters is a
 * *change*: a job that started signed in and now reads as anonymous (or gets a login page)
 * lost its session.
 */
import { isAbortError } from '../util/abort';
import { getJson } from './http';

/**
 * - `user`: signed in.
 * - `anonymous`: `/rest/api/user/current` answers `{type: "anonymous"}` (public access).
 * - `signed-out`: Confluence refuses the request (401/403) or serves a login page (non-JSON).
 * - `unreachable`: no answer (network error, timeout, 5xx). An expired SSO session often looks
 *   like this too: the API request is redirected cross-origin to the identity provider and fails.
 */
export type SessionState = 'user' | 'anonymous' | 'signed-out' | 'unreachable';

export async function readSession(baseUrl: string, signal?: AbortSignal): Promise<SessionState> {
  try {
    const u = await getJson<{ type?: unknown } | null>(`${baseUrl.replace(/\/+$/, '')}/rest/api/user/current`, {
      signal,
      maxRetries: 1,
    });
    if (!u || typeof u !== 'object') return 'signed-out';
    return u.type === 'anonymous' ? 'anonymous' : 'user';
  } catch (e) {
    if (isAbortError(e)) throw e;
    const status = (e as { status?: unknown } | null)?.status;
    return status === 401 || status === 403 ? 'signed-out' : 'unreachable';
  }
}

/**
 * Should a page failure with HTTP `status` trigger a session check? 401 and network failures
 * always do. 403/404 only for a job that started signed in: Data Center answers 404 (not 401)
 * for content an anonymous visitor cannot see, so an expired session shows up as "not found".
 */
export function needsSessionCheck(status: number | undefined, start: SessionState | undefined): boolean {
  if (status === 401 || status === 0) return true;
  return (status === 403 || status === 404) && start === 'user';
}

/**
 * Is the session still good enough to continue the export, given the state at the start of the
 * job (`start`, undefined when unknown) and the state now? `false` = stop with a sign-in error.
 */
export function sessionStillValid(start: SessionState | undefined, now: SessionState): boolean {
  switch (now) {
    case 'user':
      return true;
    case 'anonymous':
      // Anonymous all along (a public site) is fine; signed in → anonymous means it expired.
      return start !== 'user';
    case 'signed-out':
      return false;
    case 'unreachable':
      // A public site with a network hiccup: skip the page, keep going. Otherwise keep the
      // conservative answer (an expired SSO session fails exactly like this).
      return start === 'anonymous';
  }
}
