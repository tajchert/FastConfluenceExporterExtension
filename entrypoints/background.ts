/**
 * Service worker entry: wires every Chrome event to the job manager. All listeners are registered
 * synchronously at the top level of the main function so Chrome can wake the worker for them.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { probePage } from '../lib/confluence/detect';
import { parseConfluenceUrl } from '../lib/confluence/url';
import * as manager from '../lib/job/manager';
import { getPendingStart } from '../lib/job/store';
import { UI_PORT_NAME, type ProbeResult, type UiToSw, type UiToSwResponses, type WorkerToSw } from '../lib/messages';
import { menuPatterns } from '../lib/linkPatterns';
import { hasSiteAccess, listGrantedOrigins, patternsCoverOrigin } from '../lib/permissions';
import { respond } from '../lib/rpc';
import { loadSettings } from '../lib/settings';
import type { ContentType, ExportMode, ExportRequest, PageContext, SiteInfo } from '../lib/types';

const COMMAND_EXPORT_CURRENT = 'export-current-page';
const MENU_EXPORT_PAGE = 'cfp-export-link';
const MENU_EXPORT_TREE = 'cfp-export-link-tree';
const INFO_NOTIFICATION = 'cfp-info';

const UI_TYPES = new Set<string>([
  'tree/children',
  'job/start',
  'job/claimPending',
  'job/retry',
  'job/cancel',
  'job/get',
  'job/list',
  'preview/open',
]);
const WORKER_EVENTS = new Set<string>(['worker/progress', 'worker/throttled', 'worker/done', 'worker/ready']);
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
    case 'tree/children':
      return manager.treeChildren(msg, nearTabId);
    case 'job/start':
      return { jobId: await manager.startJob(msg.request, msg.pages) };
    case 'job/claimPending':
      return { jobId: await manager.claimPendingStart(msg.pending) };
    case 'job/retry':
      return { jobId: await manager.retryJob(msg.jobId) };
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

async function grantedPatterns(): Promise<string[]> {
  try {
    return menuPatterns(await listGrantedOrigins());
  } catch {
    return menuPatterns([]);
  }
}

function setupContextMenus(): void {
  void grantedPatterns().then((targetUrlPatterns) => {
    chrome.contextMenus.removeAll(() => {
      void chrome.runtime.lastError;
      const common = { contexts: ['link'] as ['link'], targetUrlPatterns };
      chrome.contextMenus.create(
        { id: MENU_EXPORT_PAGE, title: t('contextMenuExportPage', 'Export this page to PDF'), ...common },
        () => void chrome.runtime.lastError,
      );
      chrome.contextMenus.create(
        { id: MENU_EXPORT_TREE, title: t('contextMenuExportTree', 'Export this page + children to PDF'), ...common },
        () => void chrome.runtime.lastError,
      );
    });
  });
}

/** Granted sites changed: the generic link shapes follow them. */
function refreshContextMenus(): void {
  void grantedPatterns().then((targetUrlPatterns) => {
    for (const id of [MENU_EXPORT_PAGE, MENU_EXPORT_TREE]) {
      chrome.contextMenus.update(id, { targetUrlPatterns }, () => void chrome.runtime.lastError);
    }
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
  const mode: ExportMode = info.menuItemId === MENU_EXPORT_TREE ? 'subtree' : 'current';
  void exportLink(link, mode, tab).catch((e) => showInfo('PDF export failed', errorMessage(e)));
}

/**
 * The menu never asks for site access itself: the link could be on any site, and a grant must
 * not be requested before the user sees which site it is for. Without access, the preview page
 * opens and shows the site with an "Allow & export" button.
 */
async function exportLink(link: URL, mode: ExportMode, tab?: chrome.tabs.Tab): Promise<void> {
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

  if (!(await hasSiteAccess(site.origin))) {
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
  refreshContextMenus();
  const pending = await getPendingStart();
  if (!pending || !patternsCoverOrigin(perms.origins, pending.request.site.origin)) return;
  try {
    // Same claim as the popup's `job/claimPending`: the export starts once, whoever is first.
    const jobId = await manager.claimPendingStart(pending);
    if (pending.request.mode !== 'current') await manager.openJobPage(jobId, pending.request.sourceTabId);
  } catch (e) {
    await showInfo('PDF export failed', errorMessage(e));
  }
}

// ───────────────────────────── entry ─────────────────────────────

export default defineBackground(() => {
  void manager.init();

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== UI_PORT_NAME || port.sender?.id !== chrome.runtime.id || !isExtensionPage(port.sender)) return;
    manager.handleUiPort(port);
  });

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
  chrome.permissions.onRemoved.addListener(() => refreshContextMenus());

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
    refreshContextMenus();
    void manager.init();
  });
});
