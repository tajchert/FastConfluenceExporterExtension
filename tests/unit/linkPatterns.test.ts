import { describe, expect, it } from 'vitest';
import { CONFLUENCE_LINK_PATTERNS, menuPatterns } from '../../lib/linkPatterns';

/** Chrome match-pattern semantics for the parts used here (scheme, host wildcard, path glob). */
function matches(pattern: string, url: string): boolean {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern)!;
  const u = new URL(url);
  if (m[1] !== '*' && `${m[1]}:` !== u.protocol) return false;
  const host = m[2]!;
  if (host !== '*' && !(host.startsWith('*.') ? u.hostname.endsWith(host.slice(1)) : u.hostname === host)) return false;
  const re = new RegExp(`^${m[3]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  return re.test(u.pathname + u.search);
}
const anyMatch = (patterns: string[], url: string) => patterns.some((p) => matches(p, url));

describe('context-menu link patterns', () => {
  it('match Confluence-specific links on any site, but not generic shapes on unknown sites', () => {
    const p = menuPatterns([]);
    expect(anyMatch(p, 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Title')).toBe(true);
    expect(anyMatch(p, 'https://wiki.custom.com/wiki/x/AbC')).toBe(true);
    expect(anyMatch(p, 'https://intranet.corp/confluence/pages/viewpage.action?pageId=5')).toBe(true);
    expect(anyMatch(p, 'https://example.com/display/foo/bar')).toBe(false);
    expect(anyMatch(p, 'https://example.com/x/123')).toBe(false);
    expect(p).toEqual(CONFLUENCE_LINK_PATTERNS);
  });

  it('add every shape on granted sites', () => {
    const p = menuPatterns(['https://wiki.corp:8443', 'http://dc.local']);
    expect(anyMatch(p, 'https://wiki.corp/display/OPS/Runbook')).toBe(true);
    expect(anyMatch(p, 'https://wiki.corp/confluence/x/AbC')).toBe(true);
    expect(anyMatch(p, 'http://dc.local/spaces/OPS/pages/9')).toBe(true);
    expect(anyMatch(p, 'https://other.corp/display/OPS/Runbook')).toBe(false);
  });
});
