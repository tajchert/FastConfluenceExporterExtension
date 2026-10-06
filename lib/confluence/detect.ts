/**
 * Active-tab probe used by the popup:
 *   chrome.scripting.executeScript({ target: { tabId }, func: probePage })
 *
 * The function is serialized with Function.prototype.toString and executed inside the page, so it
 * MUST be fully self-contained: every helper is declared inside the function body and nothing from
 * module scope is referenced at runtime (type imports are fine). It never throws.
 *
 * The URL parsing below mirrors lib/confluence/url.ts (keep them in sync).
 */
import type { ProbeResult } from '../messages';

export async function probePage(): Promise<ProbeResult> {
  type Kind = 'page' | 'blogpost' | 'folder' | 'whiteboard' | 'database' | 'embed' | 'space' | 'tiny' | 'unknown';
  type ContentKind = 'page' | 'blogpost' | 'folder' | 'whiteboard' | 'database' | 'embed';
  interface Parsed {
    kind: Kind;
    id?: string;
    spaceKey?: string;
    title?: string;
    tinyCode?: string;
  }

  const href = location.href;
  const TIMEOUT_MS = 8000;

  const metaRaw = (name: string): string | null => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? (el.getAttribute('content') ?? '').trim() : null;
  };
  const meta = (name: string): string | undefined => metaRaw(name) || undefined;

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decodeTiny = (code: string): string | undefined => {
    let s = code.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!s || s.length > 24) return undefined;
    for (const ch of s) if (B64.indexOf(ch) < 0) return undefined;
    while (s.length % 4 !== 0) s += 'A';
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i += 4) {
      const n =
        (B64.indexOf(s.charAt(i)) << 18) |
        (B64.indexOf(s.charAt(i + 1)) << 12) |
        (B64.indexOf(s.charAt(i + 2)) << 6) |
        B64.indexOf(s.charAt(i + 3));
      bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
    }
    let v = BigInt(0);
    for (let i = bytes.length - 1; i >= 0; i--) v = v * BigInt(256) + BigInt(bytes[i] ?? 0);
    return v > BigInt(0) ? v.toString() : undefined;
  };

  const dec = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const NUM = /^\d+$/;
  const EDIT = ['edit', 'edit-v2', 'edit-embed'];
  const isDate = (y?: string, m?: string, d?: string) =>
    !!y && !!m && !!d && /^\d{4}$/.test(y) && /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d);

  const parseSegs = (raw: string[], q: URLSearchParams): Parsed | null => {
    const last = raw[raw.length - 1];
    if (last && last.toLowerCase().endsWith('.action')) {
      const action = last.toLowerCase();
      if (action === 'tinyurl.action') {
        const code = (q.get('urlIdentifier') ?? '').trim();
        return code ? { kind: 'tiny', tinyCode: code, id: decodeTiny(code) } : { kind: 'unknown' };
      }
      const pid = q.get('pageId') ?? q.get('contentId') ?? (action === 'resumedraft.action' ? q.get('draftId') : null);
      if (pid && NUM.test(pid)) return { kind: 'page', id: pid };
      const key = q.get('spaceKey') ?? q.get('key') ?? undefined;
      const title = q.get('title');
      if (key && title && (action === 'viewpage.action' || action === 'display.action')) {
        return { kind: 'page', spaceKey: key, title: title.trim() };
      }
      return key ? { kind: 'space', spaceKey: key } : { kind: 'unknown' };
    }
    const seg = raw.map(dec);
    const [s0, s1, s2, s3, s4] = seg;
    if (s0 === 'x' && s1) return { kind: 'tiny', tinyCode: raw[1], id: decodeTiny(raw[1] ?? '') };
    if (s0 === 'spaces') {
      if (!s1) return { kind: 'unknown' };
      if (!s2 || s2 === 'overview') return { kind: 'space', spaceKey: s1 };
      if (s2 === 'pages') {
        if (s3 && NUM.test(s3)) return { kind: 'page', id: s3, spaceKey: s1 };
        if (s3 && s4 && NUM.test(s4)) return { kind: 'page', id: s4, spaceKey: s1 };
        return { kind: 'space', spaceKey: s1 };
      }
      if (s2 === 'blog') {
        const s6 = seg[6];
        if (isDate(s3, s4, seg[5]) && s6 && NUM.test(s6)) return { kind: 'blogpost', id: s6, spaceKey: s1 };
        if (s3 && NUM.test(s3)) return { kind: 'blogpost', id: s3, spaceKey: s1 };
        if (s3 && s4 && NUM.test(s4)) return { kind: 'blogpost', id: s4, spaceKey: s1 };
        return { kind: 'space', spaceKey: s1 };
      }
      if (s2 === 'folder' || s2 === 'whiteboard' || s2 === 'database' || s2 === 'embed') {
        if (s3 && NUM.test(s3)) return { kind: s2, id: s3, spaceKey: s1 };
        if (s3 && s4 && NUM.test(s4) && EDIT.indexOf(s3) >= 0) return { kind: s2, id: s4, spaceKey: s1 };
      }
      return { kind: 'space', spaceKey: s1 };
    }
    if (s0 === 'display') {
      if (!s1) return { kind: 'unknown' };
      const r2 = raw[2];
      if (!r2) return { kind: 'space', spaceKey: s1 };
      const r5 = raw[5];
      const t = (r: string) => dec(r.replace(/\+/g, ' ')).trim();
      if (isDate(s2, s3, s4) && r5) return { kind: 'blogpost', spaceKey: s1, title: t(r5) };
      return { kind: 'page', spaceKey: s1, title: t(r2) };
    }
    return null;
  };

  const parse = (url: string, ctx: string): Parsed => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { kind: 'unknown' };
    }
    const segs = u.pathname.split('/').filter((s) => s.length > 0);
    const ctxSegs = ctx.split('/').filter((s) => s.length > 0);
    const candidates: string[][] = [];
    if (!ctx || u.pathname === ctx || u.pathname.startsWith(ctx + '/')) candidates.push(segs.slice(ctxSegs.length));
    for (let skip = 0; skip <= Math.min(2, segs.length); skip++) candidates.push(segs.slice(skip));
    for (const c of candidates) {
      const p = parseSegs(c, u.searchParams);
      if (p) return p;
    }
    return { kind: 'unknown' };
  };

  // Returned if something unexpected fails after the site has been identified.
  let minimal: ProbeResult | null = null;

  try {
    // ── Is this Confluence? ────────────────────────────────────────────────────────────
    const host = location.hostname.toLowerCase();
    const atlassianNet = /\.atlassian(-[a-z0-9-]+)?\.net$/.test(host);
    const path = location.pathname;
    const appName = (meta('application-name') ?? '').toLowerCase();
    const cloudId = meta('ajs-cloud-id');
    const strong =
      appName === 'confluence' ||
      metaRaw('ajs-confluence-flavour') !== null ||
      document.querySelector('meta[name^="confluence-"]') !== null ||
      document.body?.id === 'com-atlassian-confluence' ||
      (atlassianNet && (path === '/wiki' || path.startsWith('/wiki/')));
    const ajs = metaRaw('ajs-base-url') !== null || metaRaw('ajs-context-path') !== null;
    if (!strong && (!ajs || appName === 'jira' || meta('ajs-jira-base-url'))) {
      return { isConfluence: false, url: href };
    }

    // ── Site ───────────────────────────────────────────────────────────────────────────
    const origin = location.origin;
    const norm = (p: string) => {
      const t = p.trim().replace(/\/+$/, '');
      return !t ? '' : t.startsWith('/') ? t : '/' + t;
    };
    let contextPath: string | undefined;
    const ctxMeta = metaRaw('ajs-context-path') ?? metaRaw('confluence-context-path');
    if (ctxMeta !== null) contextPath = norm(ctxMeta);
    if (contextPath === undefined) {
      const baseMeta = meta('ajs-base-url') ?? meta('confluence-base-url');
      if (baseMeta) {
        try {
          contextPath = norm(new URL(baseMeta, origin).pathname);
        } catch {
          /* ignore */
        }
      }
    }
    if (contextPath === undefined) {
      if (atlassianNet) contextPath = '/wiki';
      else {
        const segs = path.split('/').filter((s) => s.length > 0);
        const at = segs.findIndex((s) => ['spaces', 'display', 'x', 'pages', 'plugins', 'wiki'].indexOf(s) >= 0);
        contextPath = at > 0 && at <= 2 ? '/' + segs.slice(0, at).join('/') : segs[0] === 'wiki' ? '/wiki' : '';
      }
    }
    const baseUrl = origin + contextPath;

    const getJson = async (p: string): Promise<any> => {
      const res = await fetch(baseUrl + p, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    const tryJson = async (p: string): Promise<any> => {
      try {
        return await getJson(p);
      } catch {
        return null;
      }
    };

    // Confirm ambiguous pages (ajs metas only) really are Confluence.
    if (!strong) {
      const probe = await tryJson('/rest/api/space?limit=1');
      if (!probe || !Array.isArray(probe.results)) return { isConfluence: false, url: href };
    }

    let flavour: 'cloud' | 'server';
    const version = meta('ajs-version-number') ?? '';
    if (cloudId || atlassianNet) flavour = 'cloud';
    else if (/^\d{1,2}\./.test(version)) flavour = 'server'; // DC/Server 5.x … 10.x; Cloud reports 1000.x
    else {
      const v2 = await tryJson('/api/v2/spaces?limit=1');
      flavour = v2 && Array.isArray(v2.results) ? 'cloud' : 'server';
    }

    minimal = { isConfluence: true, site: { origin, baseUrl, contextPath, flavour }, kind: 'unknown', url: href };

    // ── What is shown? (URL first: Cloud is an SPA, its metas can be stale) ───────────────
    let p = parse(href, contextPath);
    if (p.kind === 'tiny' && !p.id) {
      try {
        const res = await fetch(href, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (res.url && res.url !== href) p = parse(res.url, contextPath);
      } catch {
        /* keep unresolved */
      }
    }

    let kind: ContentKind | 'space' | 'unknown' = p.kind === 'tiny' ? 'unknown' : p.kind;
    let id = p.id;
    let spaceKey = p.spaceKey;
    let spaceId: string | undefined;
    let title: string | undefined;
    let lastUpdated: string | undefined;
    let typeKnown = p.kind !== 'tiny' && p.kind !== 'unknown';

    // DC/Server pages are server-rendered, so their metas are reliable.
    if (flavour === 'server') {
      const metaId = meta('ajs-page-id');
      const metaType = (meta('ajs-content-type') ?? '').toLowerCase();
      if (!id && metaId && NUM.test(metaId) && (kind === 'page' || kind === 'blogpost' || kind === 'unknown' || kind === 'space')) {
        id = metaId;
        if (kind === 'unknown' || (kind !== 'space' && (metaType === 'page' || metaType === 'blogpost'))) {
          kind = metaType === 'blogpost' ? 'blogpost' : 'page';
          typeKnown = metaType === 'page' || metaType === 'blogpost';
        }
      }
      spaceKey = spaceKey ?? meta('ajs-space-key');
    }

    const userP = (async (): Promise<string | undefined> => {
      const m = meta('ajs-current-user-fullname');
      if (m) return m;
      // Anonymous visitor (public site): the user metas are present but empty — no request.
      if (metaRaw('ajs-remote-user') === '' && metaRaw('ajs-atlassian-account-id') === '') return undefined;
      const u = await tryJson('/rest/api/user/current');
      if (!u || u.type === 'anonymous') return undefined;
      return u.displayName || u.publicName || u.username || undefined;
    })();

    // Title-based URLs (DC /display/KEY/Title, viewpage.action?title=).
    if (!id && p.title && spaceKey) {
      const t = await tryJson(
        `/rest/api/content?${new URLSearchParams({
          spaceKey,
          title: p.title,
          type: p.kind === 'blogpost' ? 'blogpost' : 'page',
          expand: 'version,space',
          limit: '5',
        }).toString()}`,
      );
      const hit = t && Array.isArray(t.results) ? t.results[0] : null;
      if (hit) {
        id = String(hit.id);
        title = hit.title;
        lastUpdated = hit.version?.when;
        spaceId = hit.space?.id !== undefined ? String(hit.space.id) : undefined;
      } else title = p.title;
    }

    if (kind === 'space' && spaceKey) {
      let resolved = false;
      if (flavour === 'cloud') {
        const s = await tryJson(`/api/v2/spaces?${new URLSearchParams({ keys: spaceKey, limit: '1' }).toString()}`);
        const sp = s && Array.isArray(s.results) ? s.results[0] : null;
        if (sp) {
          resolved = true;
          spaceId = String(sp.id);
          if (sp.homepageId) id = String(sp.homepageId);
          title = sp.name ?? spaceKey;
        }
      }
      if (!resolved) {
        const sp = await tryJson(`/rest/api/space/${encodeURIComponent(spaceKey)}?expand=homepage`);
        if (sp) {
          if (sp.id !== undefined) spaceId = String(sp.id);
          if (sp.homepage?.id !== undefined) id = String(sp.homepage.id);
          title = sp.name ?? spaceKey;
        }
      }
    } else if (id && !title) {
      /** v2 timestamps: ISO strings, but folders report `createdAt` in epoch milliseconds. */
      const iso = (v: unknown): string | undefined => {
        if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
        if (typeof v === 'string' && /^\d{12,}$/.test(v)) return new Date(Number(v)).toISOString();
        return typeof v === 'string' && v ? v : undefined;
      };
      const fromV2 = (v: any) => {
        title = v.title;
        lastUpdated = iso(v.version?.createdAt) ?? iso(v.createdAt);
        if (v.spaceId !== undefined && v.spaceId !== null) spaceId = String(v.spaceId);
      };
      const v2Path = (k: ContentKind) => `/api/v2/${k === 'page' ? 'pages' : k + 's'}/${id}`;
      let done = false;
      if (kind === 'folder' || kind === 'whiteboard' || kind === 'database' || kind === 'embed') {
        const c = await tryJson(v2Path(kind));
        if (c) fromV2(c);
        done = true;
      } else if (flavour === 'cloud' && (kind === 'page' || kind === 'blogpost')) {
        // Cloud: REST v2 first (v1 is deprecated there); the URL already told us the type.
        const c = await tryJson(v2Path(kind));
        if (c) {
          fromV2(c);
          done = true;
        }
      }
      if (!done) {
        // One v1 call gives type, title, space key and last update on Cloud and DC alike.
        const c = await tryJson(`/rest/api/content/${id}?expand=space,version`);
        if (c) {
          const t = String(c.type ?? '').toLowerCase();
          if (t === 'page' || t === 'blogpost') kind = t;
          else if (!typeKnown && (t === 'folder' || t === 'whiteboard' || t === 'database' || t === 'embed')) kind = t;
          title = c.title;
          lastUpdated = c.version?.when;
          spaceKey = c.space?.key ?? spaceKey;
          if (c.space?.id !== undefined) spaceId = String(c.space.id);
        } else if (flavour === 'cloud') {
          const order: ContentKind[] = typeKnown && kind !== 'unknown' && kind !== 'space' ? [kind] : ['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed'];
          for (const k of order) {
            const v = await tryJson(v2Path(k));
            if (v) {
              kind = k;
              fromV2(v);
              break;
            }
          }
        }
      }
      if (kind === 'unknown' && id) kind = 'page';
    }

    if (!spaceKey && spaceId && flavour === 'cloud') {
      const s = await tryJson(`/api/v2/spaces/${spaceId}`);
      if (s?.key) spaceKey = String(s.key);
    }
    if (!title && flavour === 'server' && id && id === meta('ajs-page-id')) title = meta('ajs-page-title');

    const userDisplayName = await userP;
    // DC omits ajs-site-title on blog posts and the dashboard; its <title> ends with the site name
    // ("Page - Space - Site").
    const titleParts = flavour === 'server' ? document.title.split(' - ') : [];
    const siteTitle = meta('ajs-site-title') ?? (titleParts.length >= 3 ? titleParts[titleParts.length - 1]!.trim() || undefined : undefined);

    return {
      isConfluence: true,
      site: { origin, baseUrl, contextPath, flavour, ...(siteTitle ? { siteTitle } : {}) },
      kind,
      ...(id ? { id } : {}),
      ...(spaceKey ? { spaceKey } : {}),
      ...(spaceId ? { spaceId } : {}),
      ...(title ? { title } : {}),
      ...(lastUpdated ? { lastUpdated } : {}),
      ...(userDisplayName ? { userDisplayName } : {}),
      url: href,
    };
  } catch {
    return minimal ?? { isConfluence: false, url: href };
  }
}
