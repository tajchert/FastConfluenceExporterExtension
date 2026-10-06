/** Context-menu link patterns (FR-15). */

/**
 * Link shapes that are Confluence on any host (Cloud `/wiki`, `*.atlassian.net`, the DC/Server
 * `viewpage.action` URL). Generic shapes such as `/display/…` or `/x/…` also occur on unrelated
 * sites, so they are only matched on sites the user granted (see menuPatterns).
 */
export const CONFLUENCE_LINK_PATTERNS = [
  '*://*/wiki/spaces/*/pages/*',
  '*://*/wiki/spaces/*/blog/*',
  '*://*/wiki/spaces/*/folder/*',
  '*://*/wiki/x/*',
  '*://*.atlassian.net/wiki/*',
  '*://*/pages/viewpage.action*',
  '*://*/*/pages/viewpage.action*',
];

/** Context-menu link patterns: the Confluence-specific shapes plus every shape on granted sites. */
export function menuPatterns(grantedOrigins: string[]): string[] {
  const out = [...CONFLUENCE_LINK_PATTERNS];
  for (const origin of grantedOrigins) {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      continue;
    }
    // Match patterns ignore ports: `https://wiki.corp/*` covers `https://wiki.corp:8443/…`.
    const base = `${u.protocol}//${u.hostname}`;
    out.push(`${base}/*spaces/*`, `${base}/*display/*/*`, `${base}/*x/*`, `${base}/*viewpage.action*`);
  }
  return [...new Set(out)];
}

