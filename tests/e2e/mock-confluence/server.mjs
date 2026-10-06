/**
 * Mock Confluence for the E2E suite. Plain Node `http`, no dependencies.
 *
 *  - flavour 'cloud' (context path /wiki): HTML page routes with ajs-* metas, REST v2
 *    (/wiki/api/v2/...) and v1 (/wiki/rest/api/...).
 *  - flavour 'server' (context path /confluence): Data Center, v1 only (v2 answers 404),
 *    no ajs-cloud-id, ajs-page-id / ajs-space-key metas on server-rendered pages.
 *
 * Behaviour that the tests rely on:
 *  - Cookie check: HTML routes set a session cookie; API and attachment routes answer 401 without it.
 *  - Cursor pagination with a page size of 2 (v2 `_links.next`, v1 `start`/`limit` + `_links.next`).
 *  - `/descendants` returns items in a deliberately NON-tree order.
 *  - Content flagged `forbidden` answers 403; content flagged `throttleOnce` answers 429 with
 *    `Retry-After: 1` on its first export_view request (after each reset).
 *  - Control endpoints (not logged): GET /__control/log, /__control/reset, /__control/config?delayMs=&imageDelayMs=
 *
 * Standalone: `node tests/e2e/mock-confluence/server.mjs [port] [cloud|server]`.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { CLOUD_CONTENT, CLOUD_SPACE, CLOUD_USER, DC_CONTENT, DC_SPACE, DC_USER } from './fixtures.mjs';

// ───────────────────────────── a real PNG, generated at startup ─────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** width×height RGB PNG with a two-colour diagonal pattern. */
export function makePng(width = 160, height = 90) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const on = (x + y) % 20 < 10;
      raw[row + 1 + x * 3] = on ? 0x0c : 0xe9;
      raw[row + 2 + x * 3] = on ? 0x66 : 0xf2;
      raw[row + 3 + x * 3] = on ? 0xe4 : 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = makePng();

// ───────────────────────────── helpers ─────────────────────────────

const PAGE_SIZE = 2;
const SESSION_COOKIE = { cloud: 'cloud.session.token', server: 'JSESSIONID' };

const slug = (title) => encodeURIComponent(title).replace(/%20/g, '+');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf ? body : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf ? 'image/png' : typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json;charset=UTF-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

const json = (res, status, obj, headers) => send(res, status, obj, headers);
const notFound = (res) => json(res, 404, { statusCode: 404, message: 'No content found' });

/** Paginates `items` with a fixed page size; `nextBase` is the path (incl. query) of the current request. */
function pageV2(items, url, mkNext) {
  const cursor = Number(url.searchParams.get('cursor') ?? 0) || 0;
  const slice = items.slice(cursor, cursor + PAGE_SIZE);
  const out = { results: slice, _links: {} };
  if (cursor + PAGE_SIZE < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('cursor', String(cursor + PAGE_SIZE));
    out._links.next = mkNext(next);
  }
  return out;
}

function pageV1(items, url, ctx) {
  const start = Number(url.searchParams.get('start') ?? 0) || 0;
  const limit = Math.min(PAGE_SIZE, Number(url.searchParams.get('limit') ?? PAGE_SIZE) || PAGE_SIZE);
  const slice = items.slice(start, start + limit);
  const out = { results: slice, start, limit, size: slice.length, _links: { base: url.origin + ctx, context: ctx } };
  if (start + limit < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('start', String(start + limit));
    next.searchParams.set('limit', String(limit));
    // v1 links are relative to the base URL (no context path).
    out._links.next = next.pathname.slice(ctx.length) + next.search;
  }
  return out;
}

// ───────────────────────────── server ─────────────────────────────

/**
 * @param {{ flavour?: 'cloud' | 'server', port?: number, host?: string, publicHost?: string }} o
 * @returns {Promise<{ url: string, baseUrl: string, origin: string, port: number, flavour: string,
 *   close(): Promise<void>, log: object[], reset(): void, config: object }>}
 */
export async function startMockConfluence(o = {}) {
  const flavour = o.flavour ?? 'cloud';
  const ctx = flavour === 'cloud' ? '/wiki' : '/confluence';
  const CONTENT = flavour === 'cloud' ? CLOUD_CONTENT : DC_CONTENT;
  const SPACE = flavour === 'cloud' ? CLOUD_SPACE : DC_SPACE;
  const USER = flavour === 'cloud' ? CLOUD_USER : DC_USER;
  const cookieName = SESSION_COOKIE[flavour];

  const state = {
    log: [],
    throttled: new Set(),
    config: { delayMs: 0, imageDelayMs: 0 },
  };
  let origin = '';

  const ids = Object.keys(CONTENT);
  const get = (id) => (Object.hasOwn(CONTENT, id) ? CONTENT[id] : undefined);
  const childrenOf = (id) =>
    ids
      .filter((cid) => get(cid).parentId === id)
      .sort((a, b) => (get(a).position ?? 0) - (get(b).position ?? 0));
  const ancestorsOf = (id) => {
    const out = [];
    let p = get(id)?.parentId;
    while (p) {
      out.unshift(p);
      p = get(p)?.parentId;
    }
    return out;
  };
  /** Descendants within `maxDepth`, in a deliberately scrambled (reverse tree) order. */
  const descendantsOf = (id, maxDepth) => {
    const out = [];
    const walk = (pid, depth) => {
      if (depth > maxDepth) return;
      for (const c of childrenOf(pid)) {
        out.push({ id: c, depth });
        walk(c, depth + 1);
      }
    };
    walk(id, 1);
    return out.reverse();
  };
  const base = () => origin + ctx;
  const webui = (id) => {
    const c = get(id);
    if (flavour === 'server') return `/pages/viewpage.action?pageId=${id}`;
    return c.type === 'folder' ? `/spaces/${SPACE.key}/folder/${id}` : `/spaces/${SPACE.key}/pages/${id}/${slug(c.title)}`;
  };
  const status = (id) => get(id).status ?? 'current';
  const storageOf = (c) => (c.storage ? c.storage(base()) : c.body ? c.body(base()) : '');

  // ── JSON shapes ──
  const v2Content = (id, bodyFormat) => {
    const c = get(id);
    const out = {
      id: String(id),
      type: c.type,
      status: status(id),
      title: c.title,
      spaceId: SPACE.id,
      parentId: c.parentId,
      parentType: c.parentId ? get(c.parentId).type : null,
      position: c.position,
      authorId: USER.accountId,
      ownerId: USER.accountId,
      createdAt: '2026-09-01T10:00:00.000Z',
      version: { number: 3, createdAt: '2026-10-01T12:00:00.000Z', message: '', authorId: USER.accountId },
      _links: { base: base(), webui: webui(id), tinyui: `/x/${id}` },
    };
    if (bodyFormat === 'export_view') out.body = { export_view: { value: c.body ? c.body(base()) : '', representation: 'export_view' } };
    if (bodyFormat === 'storage') out.body = { storage: { value: storageOf(c), representation: 'storage' } };
    return out;
  };
  const v2TreeItem = (id, depth) => ({
    id: String(id),
    status: status(id),
    title: get(id).title,
    type: get(id).type,
    parentId: get(id).parentId,
    depth,
    childPosition: get(id).position,
    lastModified: '2026-10-01T12:00:00.000Z',
  });
  const v1Content = (id, expand) => {
    const c = get(id);
    const ex = new Set((expand ?? '').split(',').filter(Boolean));
    const out = {
      id: String(id),
      type: c.type,
      status: status(id),
      title: c.title,
      _links: { webui: webui(id), self: `${base()}/rest/api/content/${id}` },
      _expandable: {},
    };
    if (ex.has('space')) out.space = { id: SPACE.id, key: SPACE.key, name: SPACE.name };
    if (ex.has('version'))
      out.version = { number: 3, when: '2026-10-01T12:00:00.000Z', by: { type: 'known', ...USER } };
    if (ex.has('history'))
      out.history = { createdBy: { type: 'known', ...USER }, lastUpdated: { when: '2026-10-01T12:00:00.000Z', by: { type: 'known', ...USER } } };
    if (ex.has('ancestors')) out.ancestors = ancestorsOf(id).map((a) => ({ id: String(a), type: get(a).type, title: get(a).title }));
    if (ex.has('body.export_view')) out.body = { ...(out.body ?? {}), export_view: { value: c.body ? c.body(base()) : '', representation: 'export_view' } };
    if (ex.has('body.storage')) out.body = { ...(out.body ?? {}), storage: { value: storageOf(c), representation: 'storage' } };
    if (ex.has('extensions.position')) out.extensions = { position: c.position ?? 'none' };
    if (ex.has('childTypes.page')) out.childTypes = { page: { value: childrenOf(id).length > 0 } };
    return out;
  };
  const v2Space = () => ({ id: SPACE.id, key: SPACE.key, name: SPACE.name, type: 'global', status: 'current', homepageId: SPACE.homepageId });
  const v1Space = () => ({ id: SPACE.id, key: SPACE.key, name: SPACE.name, type: 'global', homepage: { id: SPACE.homepageId, title: get(SPACE.homepageId).title } });

  // ── HTML shell ──
  const htmlPage = (id, url) => {
    const c = id ? get(id) : null;
    const title = c ? c.title : SPACE.name;
    const metas = [
      ['ajs-base-url', base()],
      ['ajs-context-path', ctx],
      ['ajs-site-title', flavour === 'cloud' ? 'Mock Cloud Wiki' : 'Mock DC Wiki'],
      ['ajs-current-user-fullname', USER.displayName],
      ['ajs-remote-user', USER.accountId ?? USER.username],
    ];
    if (flavour === 'cloud') {
      metas.push(['ajs-cloud-id', '00000000-0000-4000-8000-000000000001'], ['ajs-version-number', '1000.0.0']);
    } else {
      metas.push(['ajs-version-number', '8.5.4'], ['ajs-space-key', SPACE.key]);
      if (id) metas.push(['ajs-page-id', String(id)], ['ajs-page-title', title], ['ajs-content-type', c.type]);
    }
    // The browser tab never loads third-party frames or scripts from the fixtures (no network
    // access outside the mock); the API's export_view keeps them for the sanitizer tests.
    const body = (c?.liveHtml ? c.liveHtml(base()) : c?.body ? c.body(base()) : '<p>Space overview.</p>')
      .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '<span class="iframe-placeholder">[embedded content]</span>')
      .replace(c?.liveHtml ? /$^/ : /<script\b[\s\S]*?<\/script>/gi, '');
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)} - ${SPACE.name}</title>
${metas.map(([n, v]) => `<meta name="${n}" content="${escapeHtml(v)}">`).join('\n')}
</head><body${flavour === 'server' ? ' id="com-atlassian-confluence"' : ''}>
<header id="header" class="aui-header">Mock Confluence header · ${escapeHtml(url.pathname)}</header>
<div id="main-content" class="wiki-content"><h1 id="title-text">${escapeHtml(title)}</h1>${body}</div>
</body></html>`;
  };

  const hasSession = (req) => (req.headers.cookie ?? '').split(/;\s*/).some((c) => c.startsWith(`${cookieName}=`));

  // ── routing ──
  async function route(req, res, url) {
    let p = url.pathname;

    if (p.startsWith('/__control/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (p === '/__control/log') return json(res, 200, state.log);
      if (p === '/__control/reset') {
        state.log.length = 0;
        state.throttled.clear();
        state.config.delayMs = 0;
        state.config.imageDelayMs = 0;
        return json(res, 200, { ok: true });
      }
      if (p === '/__control/config') {
        for (const k of ['delayMs', 'imageDelayMs']) if (url.searchParams.has(k)) state.config[k] = Number(url.searchParams.get(k));
        return json(res, 200, state.config);
      }
      return notFound(res);
    }

    state.log.push({ method: req.method, path: p + url.search, host: req.headers.host, cookie: hasSession(req), at: Date.now() });

    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { message: 'Read-only mock' });
    if (p === '/favicon.ico') return send(res, 404, '');
    if (!p.startsWith(ctx + '/') && p !== ctx) return notFound(res);
    p = p.slice(ctx.length) || '/';

    // ── HTML routes (set the session cookie) ──
    const cookie = { 'Set-Cookie': `${cookieName}=mock-session-${flavour}; Path=/; HttpOnly; SameSite=Lax` };
    let m;
    if (flavour === 'cloud') {
      if ((m = /^\/spaces\/([^/]+)\/pages\/(\d+)(?:\/[^/]*)?$/.exec(p)) && get(m[2])) return send(res, 200, htmlPage(m[2], url), cookie);
      if ((m = /^\/spaces\/([^/]+)\/folder\/(\d+)$/.exec(p)) && get(m[2])) return send(res, 200, htmlPage(m[2], url), cookie);
      if (/^\/spaces\/[^/]+\/overview\/?$/.test(p)) return send(res, 200, htmlPage(null, url), cookie);
      if ((m = /^\/x\/([A-Za-z0-9_-]+)$/.exec(p))) {
        res.writeHead(302, { Location: `${ctx}/pages/viewpage.action?pageId=${m[1]}` });
        return res.end();
      }
    } else {
      if ((m = /^\/display\/([^/]+)\/([^/]+)$/.exec(p))) {
        const title = decodeURIComponent(m[2].replace(/\+/g, ' '));
        const id = ids.find((i) => get(i).title === title);
        if (id) return send(res, 200, htmlPage(id, url), cookie);
      }
      if (/^\/display\/[^/]+\/?$/.test(p)) return send(res, 200, htmlPage(SPACE.homepageId, url), cookie);
    }
    if (p === '/pages/viewpage.action') {
      const id = url.searchParams.get('pageId');
      if (id && get(id)) return send(res, 200, htmlPage(id, url), cookie);
    }

    // ── everything below needs the session cookie ──
    if (!hasSession(req)) {
      return json(res, 401, { statusCode: 401, message: 'This resource requires authentication (no session cookie).' });
    }

    if (/^\/download\/attachments\/\d+\/missing[^/]*$/.test(p)) return notFound(res);
    if ((m = /^\/download\/attachments\/(\d+)\/[^/]+\.png$/.exec(p))) {
      if (state.config.imageDelayMs) await sleep(state.config.imageDelayMs);
      return send(res, 200, PNG);
    }

    // ── v2 (Cloud only) ──
    if (p.startsWith('/api/v2/')) {
      if (flavour !== 'cloud') return notFound(res);
      return routeV2(req, res, url, p.slice('/api/v2'.length));
    }
    // ── v1 ──
    if (p.startsWith('/rest/api/')) return routeV1(req, res, url, p.slice('/rest/api'.length));
    return notFound(res);
  }

  const forbidden = (res) => json(res, 403, { statusCode: 403, message: 'You do not have permission to view this content.' });
  const v2Next = (next) => next.pathname + next.search; // origin-relative, includes /wiki

  async function routeV2(req, res, url, p) {
    let m;
    if ((m = /^\/(pages|folders)\/(\d+)(\/[a-z-]+)?$/.exec(p))) {
      const [, coll, id, sub] = m;
      const c = get(id);
      if (!c || (coll === 'pages' && c.type !== 'page') || (coll === 'folders' && c.type !== 'folder')) return notFound(res);
      if (c.forbidden) return forbidden(res);
      if (!sub) {
        const fmt = url.searchParams.get('body-format');
        if (fmt === 'export_view' || fmt === 'storage') {
          if (state.config.delayMs) await sleep(state.config.delayMs);
          if (fmt === 'export_view' && c.throttleOnce && !state.throttled.has(id)) {
            state.throttled.add(id);
            return json(res, 429, { message: 'Rate limited' }, { 'Retry-After': '1' });
          }
        }
        return json(res, 200, v2Content(id, coll === 'pages' ? fmt : null));
      }
      if (sub === '/direct-children') {
        const items = childrenOf(id).map((cid) => ({ id: cid, status: status(cid), title: get(cid).title, type: get(cid).type, childPosition: get(cid).position }));
        return json(res, 200, pageV2(items, url, v2Next));
      }
      if (sub === '/descendants') {
        const depth = Math.min(5, Number(url.searchParams.get('depth') ?? 5) || 5);
        const items = descendantsOf(id, depth).map(({ id: did, depth: d }) => v2TreeItem(did, d));
        return json(res, 200, pageV2(items, url, v2Next));
      }
      if (sub === '/ancestors') {
        return json(res, 200, { results: ancestorsOf(id).map((a) => ({ id: a, type: get(a).type })), _links: {} });
      }
      return notFound(res);
    }
    if (/^\/(whiteboards|databases|embeds|blogposts)\/\d+/.test(p)) return notFound(res);
    if (p === '/pages') {
      const title = url.searchParams.get('title');
      const items = ids.filter((i) => get(i).type === 'page' && (!title || get(i).title === title)).map((i) => v2Content(i));
      return json(res, 200, pageV2(items, url, v2Next));
    }
    if (p === '/spaces') {
      const keys = (url.searchParams.get('keys') ?? '').split(',').filter(Boolean);
      const items = !keys.length || keys.includes(SPACE.key) ? [v2Space()] : [];
      return json(res, 200, { results: items, _links: {} });
    }
    if ((m = /^\/spaces\/(\d+)$/.exec(p))) return m[1] === SPACE.id ? json(res, 200, v2Space()) : notFound(res);
    if ((m = /^\/spaces\/(\d+)\/pages$/.exec(p))) {
      if (m[1] !== SPACE.id) return notFound(res);
      const roots = ids.filter((i) => get(i).type === 'page' && (url.searchParams.get('depth') !== 'root' || !get(i).parentId));
      return json(res, 200, pageV2(roots.map((i) => v2Content(i)), url, v2Next));
    }
    return notFound(res);
  }

  async function routeV1(req, res, url, p) {
    let m;
    const expand = url.searchParams.get('expand') ?? '';
    if (p === '/space') {
      return json(res, 200, pageV1([v1Space()], url, ctx));
    }
    if ((m = /^\/space\/([^/]+)$/.exec(p))) return m[1] === SPACE.key ? json(res, 200, v1Space()) : notFound(res);
    if ((m = /^\/space\/([^/]+)\/content\/page$/.exec(p))) {
      if (m[1] !== SPACE.key) return notFound(res);
      const roots = ids.filter((i) => get(i).type === 'page' && !get(i).parentId);
      return json(res, 200, pageV1(roots.map((i) => v1Content(i, expand)), url, ctx));
    }
    if (p === '/user/current' || p === '/user') {
      return json(res, 200, { type: 'known', ...USER, publicName: USER.displayName });
    }
    if ((m = /^\/content\/(\d+)$/.exec(p))) {
      const c = get(m[1]);
      if (!c || c.type === 'folder') return notFound(res);
      if (c.forbidden) return forbidden(res);
      if (expand.includes('body.')) {
        if (state.config.delayMs) await sleep(state.config.delayMs);
        if (expand.includes('body.export_view') && c.throttleOnce && !state.throttled.has(m[1])) {
          state.throttled.add(m[1]);
          return json(res, 429, { message: 'Rate limited' }, { 'Retry-After': '1' });
        }
      }
      return json(res, 200, v1Content(m[1], expand));
    }
    if ((m = /^\/content\/(\d+)\/child\/page$/.exec(p))) {
      const c = get(m[1]);
      if (!c) return notFound(res);
      if (c.forbidden) return forbidden(res);
      // Scrambled on purpose: the client must sort by extensions.position.
      const kids = childrenOf(m[1]).filter((k) => get(k).type === 'page').reverse();
      return json(res, 200, pageV1(kids.map((k) => v1Content(k, expand)), url, ctx));
    }
    if (p === '/content') {
      const title = url.searchParams.get('title');
      const spaceKey = url.searchParams.get('spaceKey');
      const items = ids.filter((i) => get(i).type === 'page' && (!title || get(i).title === title) && (!spaceKey || spaceKey === SPACE.key));
      return json(res, 200, pageV1(items.map((i) => v1Content(i, expand)), url, ctx));
    }
    if (p === '/search') {
      const cql = url.searchParams.get('cql') ?? '';
      const anc = /ancestor\s*=\s*"?(\d+)"?/.exec(cql);
      const found = anc ? descendantsOf(anc[1], 100).map((d) => d.id) : [];
      return json(res, 200, pageV1(found.map((i) => ({ content: v1Content(i, 'space,ancestors'), title: get(i).title })), url, ctx));
    }
    return notFound(res);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, origin || 'http://127.0.0.1');
    } catch {
      return notFound(res);
    }
    route(req, res, url).catch((e) => {
      try {
        json(res, 500, { message: String(e?.stack ?? e) });
      } catch {
        /* response already sent */
      }
    });
  });

  const host = o.host ?? '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, host, () => resolve());
  });
  const port = server.address().port;
  origin = `http://${o.publicHost ?? '127.0.0.1'}:${port}`;

  return {
    flavour,
    port,
    origin,
    baseUrl: origin + ctx,
    contextPath: ctx,
    url: (path) => origin + ctx + path,
    log: state.log,
    config: state.config,
    reset() {
      state.log.length = 0;
      state.throttled.clear();
      state.config.delayMs = 0;
      state.config.imageDelayMs = 0;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Standalone mode for manual debugging.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8090);
  const flavour = process.argv[3] === 'server' ? 'server' : 'cloud';
  const s = await startMockConfluence({ port, flavour });
  console.log(`Mock Confluence (${flavour}) at ${s.baseUrl}`);
}
