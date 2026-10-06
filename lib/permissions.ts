/**
 * Per-origin host access. The extension ships with no host permissions; each Confluence site is
 * granted at runtime through `optional_host_permissions` (https://*\/*, http://*\/*).
 *
 * Patterns are built without a port: a Chrome match pattern without a port matches every port,
 * so a Data Center instance on `https://wiki.corp:8443` is covered by `https://wiki.corp/*`.
 */

function parseOrigin(origin: string): URL {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported site address: ${origin}`);
  }
  return url;
}

/** 'https://x.atlassian.net' → 'https://x.atlassian.net/*' */
export function originPattern(origin: string): string {
  const url = parseOrigin(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

export async function hasSiteAccess(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(origin)] });
  } catch {
    return false;
  }
}

/**
 * Prompts the user. Must be called synchronously from a user gesture (click handler), before any
 * `await`, or Chrome rejects the request.
 */
export async function requestSiteAccess(origin: string): Promise<boolean> {
  return chrome.permissions.request({ origins: [originPattern(origin)] });
}

/** Origins the user granted (wildcard grants such as `https://*\/*` are not listed). */
export async function listGrantedOrigins(): Promise<string[]> {
  const all = await chrome.permissions.getAll();
  const origins = new Set<string>();
  for (const pattern of all.origins ?? []) {
    const m = /^(https?):\/\/([^/*]+)\/.*$/.exec(pattern);
    if (!m) continue; // '<all_urls>', '*://…' or a host wildcard
    origins.add(`${m[1]}://${m[2]}`);
  }
  return [...origins].sort();
}

export async function removeSiteAccess(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.remove({ origins: [originPattern(origin)] });
  } catch {
    // Permissions declared in the manifest (e.g. the e2e build) cannot be removed.
    return false;
  }
}

/** True when `patterns` (from permissions.onAdded) cover `origin`. */
export function patternsCoverOrigin(patterns: string[] | undefined, origin: string): boolean {
  if (!patterns?.length) return false;
  let url: URL;
  try {
    url = parseOrigin(origin);
  } catch {
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  return patterns.some((p) => {
    if (p === '<all_urls>') return true;
    const m = /^(\*|https?):\/\/([^/]+)\//.exec(p);
    if (!m) return false;
    const [, s, host] = m;
    if (s !== '*' && s !== scheme) return false;
    if (host === '*') return true;
    if (host.startsWith('*.')) {
      const suffix = host.slice(2);
      return url.hostname === suffix || url.hostname.endsWith(`.${suffix}`);
    }
    return host.replace(/:\d+$/, '') === url.hostname;
  });
}
