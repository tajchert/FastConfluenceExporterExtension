/**
 * Service worker entry: wires every Chrome event to the job manager. All listeners are registered
 * synchronously at the top level of the main function so Chrome can wake the worker for them.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { probePage } from '../lib/confluence/detect';
import { parseConfluenceUrl } from '../lib/confluence/url';
import * as manager from '../lib/job/manager';
import { clearPendingStart, getPendingStart } from '../lib/job/store';
import type { ProbeResult, UiToSw, UiToSwResponses, WorkerToSw } from '../lib/messages';
import { hasSiteAccess, patternsCoverOrigin, requestSiteAccess } from '../lib/permissions';
import { respond } from '../lib/rpc';
import { loadSettings } from '../lib/settings';
import type { ContentType, ExportMode, ExportRequest, PageContext, SiteInfo } from '../lib/types';

const COMMAND_EXPORT_CURRENT = 'export-current-page';
const MENU_EXPORT_PAGE = 'cfp-export-link';
const MENU_EXPORT_TREE = 'cfp-export-link-tree';
const INFO_NOTIFICATION = 'cfp-info';

/** Confluence page URL shapes (Cloud incl. custom domains, DC/Server with any context path). */
const LINK_PATTERNS = [
  '*://*/*spaces/*/pages/*',
  '*://*/*spaces/*/blog/*',
  '*://*/*pages/viewpage.action*',
  '*://*/display/*/*',
  '*://*/*/display/*/*',
  '*://*/x/*',
  '*://*/*/x/*',
];

const UI_TYPES = new Set<string>([
  'collect',
  'tree/children',
  'job/start',
  'job/cancel',
  'job/get',
  'job/list',
  'preview/open',
]);
const WORKER_EVENTS = new Set<string>(['worker/progress', 'worker/throttled', 'worker/ready']);
const CONTENT_TYPES = new Set<string>(['page', 'blogpost', 'folder', 'whiteboard', 'database', 'embed']);

function t(key: string, fallback: string): string {
  try {
    return chrome.i18n.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !!sender.url && sender.url.startsWith(chrome.runtime.getURL('/'));
}

async function showInfo(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.clear(INFO_NOTIFICATION);
    await chrome.notifications.create(INFO_NOTIFICATION, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icons/128.png'),
      title,
      message,
      priority: 0,
    });
  } catch {
    /* notifications unavailable */
  }
}

// ───────────────────────────── UI messages ─────────────────────────────

async function handleUi(msg: UiToSw, sender: chrome.runtime.MessageSender): Promise<UiToSwResponses[UiToSw['type']]> {
  const nearTabId = sender.tab?.id;
  switch (msg.type) {
    case 'collect':
      return manager.collectForPreview(msg.request, nearTabId);
    case 'tree/children':
      return manager.treeChildren(msg, nearTabId);
    case 'job/start':
      return { jobId: await manager.startJob(msg.request, msg.pages) };
    case 'job/cancel':
      return manager.cancelJob(msg.jobId);
    case 'job/get':
      return manager.getJob(msg.jobId);
    case 'job/list':
      return manager.listJobs();
    case 'preview/open':
      return manager.openPreview(msg.request);
  }
}

// ───────────────────────────── shared request helpers ─────────────────────────────

/** Builds an export request from a probed page context, or null when there is nothing to export. */
async function requestFromContext(
  ctx: PageContext,
  mode: ExportMode,
  sourceTabId?: number,
): Promise<ExportRequest | null> {
  if (!ctx.id) return null;
  let type: ContentType;
  if (ctx.kind === 'space') type = 'page'; // the space home page
  else if (ctx.kind === 'page' || ctx.kind === 'blogpost' || ctx.kind === 'folder') type = ctx.kind;
  else return null;
  if (type === 'folder') mode = 'folder';
  const settings = await loadSettings();
  return {
    site: ctx.site,
    mode,
    root: { id: ctx.id, type, title: ctx.title, spaceKey: ctx.spaceKey, spaceId: ctx.spaceId },
    depth: mode === 'subtree' || mode === 'folder' ? 'all' : undefined,
    options: settings.defaults,
    sourceTabId,
    userDisplayName: ctx.userDisplayName,
  };
}

async function probeTab(tabId: number): Promise<ProbeResult | null> {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: probePage });
    return (res?.result as ProbeResult | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Start immediately for single pages; multi-page exports go through the preview (FR-7, FR-16). */
async function startOrPreview(request: ExportRequest): Promise<void> {
  if (request.mode !== 'current') {
    await manager.openPreview(request);
    return;
  }
  if (!(await hasSiteAccess(request.site.origin))) {
    // chrome.permissions.request needs a user gesture: the preview page offers "Allow & export".
    await manager.openPreview(request);
    return;
  }
  try {
    await manager.startJob(request);
  } catch (e) {
    await showInfo('PDF export failed', errorMessage(e));
  }
}

// ───────────────────────────── keyboard shortcut (FR-2) ─────────────────────────────

async function exportActiveTab(tab?: chrome.tabs.Tab): Promise<void> {
  let target = tab;
  if (target?.id === undefined) {
    [target] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (target?.id === undefined) return;
  const probe = await probeTab(target.id);
  if (!probe?.isConfluence) {
    await showInfo('Not a Confluence page', 'Open a Confluence page, then press the shortcut again.');
    return;
  }
  const request = await requestFromContext(probe, 'current', target.id);
  if (!request) {
    await showInfo('Nothing to export', 'This Confluence view has no page to export. Open a page and try again.');
    return;
  }
  await startOrPreview(request);
}

// ───────────────────────────── context menu (FR-15) ─────────────────────────────

function setupContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    const common = { contexts: ['link'] as ['link'], targetUrlPatterns: LINK_PATTERNS };
    chrome.contextMenus.create(
      { id: MENU_EXPORT_PAGE, title: t('contextMenuExportPage', 'Export this page to PDF'), ...common },
      () => void chrome.runtime.lastError,
    );
    chrome.contextMenus.create(
      { id: MENU_EXPORT_TREE, title: t('contextMenuExportTree', 'Export this page + children to PDF'), ...common },
      () => void chrome.runtime.lastError,
    );
  });
}

/** Best guess of the Confluence site a link belongs to, without network access. */
function guessSite(link: URL): SiteInfo {
  const origin = link.origin;
  const path = link.pathname;
  if (link.hostname.endsWith('.atlassian.net') || path === '/wiki' || path.startsWith('/wiki/')) {
    return { origin, baseUrl: `${origin}/wiki`, contextPath: '/wiki', flavour: 'cloud' };
  }
  const m = /^(.*?)\/(?:display|pages|spaces|x)\//.exec(path);
  const contextPath = m ? m[1].replace(/\/+$/, '') : '';
  return { origin, baseUrl: origin + contextPath, contextPath, flavour: 'server' };
}

async function siteForLink(link: URL, tab?: chrome.tabs.Tab): Promise<{ site: SiteInfo; user?: string }> {
  // The click grants activeTab on the tab showing the link: when that tab is on the same site,
  // its page metadata tells us the exact flavour and context path.
  if (tab?.id !== undefined) {
    const probe = await probeTab(tab.id);
    if (probe?.isConfluence && probe.site.origin === link.origin) {
      return { site: probe.site, user: probe.userDisplayName };
    }
  }
  return { site: guessSite(link) };
}

function handleContextClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void {
  if (info.menuItemId !== MENU_EXPORT_PAGE && info.menuItemId !== MENU_EXPORT_TREE) return;
  if (!info.linkUrl) return;
  let link: URL;
  try {
    link = new URL(info.linkUrl);
  } catch {
    return;
  }
  if (link.protocol !== 'https:' && link.protocol !== 'http:') return;
  // The menu click is a user gesture: ask for site access now, before anything is awaited.
  let access: Promise<'granted' | 'denied' | 'unavailable'>;
  try {
    access = requestSiteAccess(link.origin).then(
      (ok) => (ok ? 'granted' : 'denied'),
      () => 'unavailable',
    );
  } catch {
    access = Promise.resolve('unavailable');
  }
  const mode: ExportMode = info.menuItemId === MENU_EXPORT_TREE ? 'subtree' : 'current';
  void exportLink(link, mode, access, tab).catch((e) => showInfo('PDF export failed', errorMessage(e)));
}

async function exportLink(
  link: URL,
  mode: ExportMode,
  access: Promise<'granted' | 'denied' | 'unavailable'>,
  tab?: chrome.tabs.Tab,
): Promise<void> {
  const granted = await access;
  if (granted === 'denied') return; // the user said no
  const { site, user } = await siteForLink(link, tab);
  const settings = await loadSettings();
  const base = {
    site,
    mode,
    depth: mode === 'subtree' ? ('all' as const) : undefined,
    options: settings.defaults,
    sourceTabId: tab?.id,
    userDisplayName: user,
  };

  if (granted !== 'granted' && !(await hasSiteAccess(site.origin))) {
    // No gesture-based prompt possible here: let the preview page ask ("Allow & export").
    const parsed = parseConfluenceUrl(link.href, site.contextPath);
    if (parsed.id && CONTENT_TYPES.has(parsed.kind)) {
      const type = parsed.kind as ContentType;
      await manager.openPreview({
        ...base,
        mode: type === 'folder' ? 'folder' : mode,
        root: { id: parsed.id, type, spaceKey: parsed.spaceKey },
      });
    } else {
      await showInfo(
        'Site access needed',
        `Open the extension on ${link.host} and allow access, then use the menu again.`,
      );
    }
    return;
  }

  const resolved = await manager.resolveContentUrl(site, link.href, tab?.id);
  if (!resolved) {
    await showInfo('Not a Confluence page', 'This link does not point to a Confluence page that can be exported.');
    return;
  }
  if (!CONTENT_TYPES.has(resolved.type) || (resolved.type !== 'page' && resolved.type !== 'blogpost' && resolved.type !== 'folder')) {
    await showInfo('Cannot export this content', `"${resolved.title}" has no printable content.`);
    return;
  }
  const request: ExportRequest = {
    ...base,
    mode: resolved.type === 'folder' ? 'folder' : resolved.type === 'blogpost' ? 'current' : mode,
    root: {
      id: resolved.id,
      type: resolved.type,
      title: resolved.title,
      spaceKey: resolved.spaceKey,
      spaceId: resolved.spaceId,
    },
  };
  await startOrPreview(request);
}

// ───────────────────────────── permission granted (pending start) ─────────────────────────────

async function onPermissionsAdded(perms: chrome.permissions.Permissions): Promise<void> {
  const pending = await getPendingStart();
  if (!pending || !patternsCoverOrigin(perms.origins, pending.request.site.origin)) return;
  await clearPendingStart();
  try {
    const jobId = await manager.startJob(pending.request, pending.pages);
    if (pending.request.mode !== 'current') await manager.openJobPage(jobId, pending.request.sourceTabId);
  } catch (e) {
    await showInfo('PDF export failed', errorMessage(e));
  }
}

// ───────────────────────────── entry ─────────────────────────────

export default defineBackground(() => {
  void manager.init();

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
    const m = msg as { type?: unknown; target?: unknown };
    if (m.target === 'offscreen' || typeof m.type !== 'string') return false; // for the offscreen document
    if (WORKER_EVENTS.has(m.type)) {
      if (sender.tab) manager.handleWorkerMessage(msg as WorkerToSw);
      return false;
    }
    if (!UI_TYPES.has(m.type) || !isExtensionPage(sender)) return false;
    return respond(sendResponse, () => handleUi(msg as UiToSw, sender));
  });

  chrome.commands.onCommand.addListener((command, tab) => {
    if (command !== COMMAND_EXPORT_CURRENT) return;
    void exportActiveTab(tab).catch((e) => showInfo('PDF export failed', errorMessage(e)));
  });

  chrome.contextMenus.onClicked.addListener(handleContextClick);

  chrome.permissions.onAdded.addListener((perms) => {
    void onPermissionsAdded(perms).catch(() => undefined);
  });

  chrome.notifications.onClicked.addListener((id) => {
    if (id === INFO_NOTIFICATION) {
      chrome.notifications.clear(id).catch(() => undefined);
      return;
    }
    void manager.handleNotificationClick(id).catch(() => undefined);
  });

  chrome.runtime.onInstalled.addListener(() => {
    setupContextMenus();
    void manager.init();
  });

  chrome.runtime.onStartup.addListener(() => {
    void manager.init();
  });
});
