/**
 * Live render content script (FR-10), injected into a real Confluence page tab with
 * `chrome.scripting.executeScript({ files: ['/live.js'] })`. Answers `live/prepare`: opens expand
 * macros, hides the Confluence app chrome, adds print CSS (+ custom CSS), waits until
 * client-rendered macros (draw.io, Gliffy, Lucid, charts, …) and images are rendered, then waits
 * for the network to go quiet. The service worker prints the tab afterwards.
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import type { SwToLive, SwToLiveResponses } from '../lib/messages';
import { respond } from '../lib/rpc';

type Prepared = SwToLiveResponses['live/prepare'];

/** Confluence UI that must not appear in the PDF (Cloud first, then Data Center / Server). */
const CHROME_SELECTORS = [
  // Cloud: navigation, banners, sidebars, page tree
  '#AkTopNav',
  '#AkBanner',
  '#AkSideNavigation',
  '#AkLeftSidebar',
  '#AkRightSidebar',
  '[data-testid="page-layout.top-nav"]',
  '[data-testid="page-layout.banner"]',
  '[data-testid="page-layout.left-sidebar"]',
  '[data-testid="page-layout.right-sidebar"]',
  '[data-testid="page-layout.left-panel"]',
  '[data-testid="page-layout.right-panel"]',
  '[data-testid="app-navigation"]',
  '[data-testid="atlassian-navigation"]',
  '[data-testid="side-navigation"]',
  '[data-testid="space-navigation"]',
  '[data-testid="grid-left-sidebar"]',
  '[data-testid="grid-right-sidebar"]',
  '[data-testid="page-tree"]',
  '[data-testid="pagetree"]',
  '[data-vc="side-nav"]',
  'nav[aria-label="Space navigation"]',
  'header[role="banner"]',
  // Cloud: comments, reactions, labels, action bars, floating UI
  '[data-testid="page-comments-section"]',
  '[data-testid="comments-section"]',
  '[data-testid="footer-comments"]',
  '[data-testid="inline-comments-sidebar"]',
  '[data-testid="reactions-container"]',
  '[data-testid="render-reactions"]',
  '[data-testid="content-reactions"]',
  '[data-testid="labels-section"]',
  '[data-testid="page-labels"]',
  '[data-testid="content-buttons"]',
  '[data-testid="page-header-actions"]',
  '[data-testid="object-sidebar"]',
  '[data-testid="object-sidebar-container"]',
  '[data-testid="floating-buttons"]',
  '[data-testid="floating-toolbar"]',
  '[data-testid="help-button"]',
  '[data-testid="feedback-button"]',
  '[data-testid="flag-group"]',
  '[data-testid="page-saved-indicator"]',
  '[data-testid="engagement-provider"]',
  '#comments-container',
  '#chat-button',
  '#help-button',
  '.atlaskit-portal-container',
  // Data Center / Server
  '#header',
  '#navigation',
  '.ia-splitter-left',
  '#comments-section',
  '#likes-and-labels-container',
  '#likes-section',
  '#labels-section',
  '#footer',
  '#page-metadata-banner',
  '#editor-precursor',
  '#action-menu-link',
  '#navigation-next',
  '#quick-search',
  '#com-atlassian-confluence .aui-header',
  '.page-metadata-modification-info .page-history-view',
  '#children-section',
  '#feedback-dialog',
  '#inline-comments-highlight',
  '#space-tools-web-items',
];

/** Elements that are only there while something is still loading. */
const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[data-testid*="spinner" i]',
  '[data-testid*="loading" i]',
  '[data-testid*="skeleton" i]',
  '.aui-spinner',
  '.spinner',
  '.loading',
  '.is-loading',
];

/** Containers of client-rendered macros. Each is "rendered" once it holds visual content. */
const MACRO_SELECTORS = [
  '[data-macro-name*="drawio" i]',
  '[data-macro-name*="gliffy" i]',
  '[data-macro-name*="lucid" i]',
  '[data-macro-name*="chart" i]',
  '[data-macro-name*="roadmap" i]',
  '[data-macro-name*="mermaid" i]',
  '[data-macro-name*="plantuml" i]',
  '[data-macro-name*="miro" i]',
  '[data-macro-name*="figma" i]',
  '[data-extension-key*="drawio" i]',
  '[data-extension-key*="gliffy" i]',
  '[data-extension-key*="lucid" i]',
  '[data-extension-key*="chart" i]',
  '[data-extension-key*="roadmap" i]',
  '[data-extension-key*="mermaid" i]',
  '[data-extension-key*="plantuml" i]',
  '.drawio-macro',
  '.drawio-diagram',
  '.geDiagramContainer',
  '.gliffy-macro',
  '.gliffy-container',
  '.lucidchart-macro',
  '.lucid-macro',
  '.confluence-chart',
  '.chart-macro',
  '.roadmap-macro-view',
];

const CONTENT_ROOT_SELECTORS = [
  '#main-content',
  '[data-testid="pageContentRendererTestId"]',
  '.ak-renderer-document',
  '#content-body',
  '.wiki-content',
  '#content',
  'main',
];

const POLL_MS = 250;
const NETWORK_QUIET_MS = 500;
const MAX_QUIET_WAIT_MS = 5000;
const IFRAME_SETTLE_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hideChromeCss(): string {
  return `
${CHROME_SELECTORS.join(',\n')} { display: none !important; }
html, body { background: #fff !important; overflow: visible !important; height: auto !important; }
#AkMainContent, [data-testid="grid-main-container"], [data-testid="page-layout.main"], main, #main, #content,
.ia-splitter, .ia-splitter-right, #page, #full-height-container {
  overflow: visible !important; height: auto !important; max-height: none !important;
}
#main, .ia-splitter-right, #AkMainContent, [data-testid="page-layout.main"] { margin-left: 0 !important; }
.expand-control { display: none !important; }
.expand-content, .expand-hidden { display: block !important; opacity: 1 !important; height: auto !important; visibility: visible !important; }
@media print {
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  img, svg, canvas, iframe, figure, table, pre { break-inside: avoid; }
  img, svg, canvas { max-width: 100% !important; }
}`;
}

function addStyle(id: string, css: string): void {
  document.getElementById(id)?.remove();
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  (document.head ?? document.documentElement).appendChild(el);
}

function contentRoot(): Element {
  for (const sel of CONTENT_ROOT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return document.body;
}

/** Opens expand / details elements. Only touches controls inside expand macros. */
function expandAll(): void {
  // Cloud renderer (ADF): expand nodes have a toggle button with aria-expanded="false".
  document
    .querySelectorAll<HTMLElement>(
      '[data-node-type="expand"] [aria-expanded="false"], [data-node-type="nestedExpand"] [aria-expanded="false"],' +
        '[data-testid*="expand" i] button[aria-expanded="false"]',
    )
    .forEach((btn) => {
      try {
        btn.click();
      } catch {
        /* ignore */
      }
    });
  // Data Center / export-style expand macro.
  document.querySelectorAll<HTMLElement>('.expand-container').forEach((c) => {
    c.classList.add('expanded');
    c.querySelectorAll<HTMLElement>('.expand-content').forEach((content) => {
      content.classList.remove('expand-hidden');
      content.style.display = 'block';
    });
  });
  document.querySelectorAll('details:not([open])').forEach((d) => d.setAttribute('open', ''));
}

/** Lazy media would never load in a hidden tab → force eager loading. */
function disableLazyLoading(): void {
  document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
    el.setAttribute('loading', 'eager');
  });
  document.querySelectorAll<HTMLImageElement>('img[data-src]:not([src])').forEach((img) => {
    img.src = img.dataset.src ?? '';
  });
}

/** Scrolls through every large scroll container so scroll/intersection-driven loaders fire. */
async function scrollThrough(deadline: number): Promise<void> {
  const containers: (Element | Window)[] = [window];
  document.querySelectorAll('#AkMainContent, [data-testid="grid-main-container"], main, #main, #content').forEach((el) => {
    if (el.scrollHeight > el.clientHeight + 100) containers.push(el);
  });
  for (const c of containers) {
    const height = c === window ? document.documentElement.scrollHeight : (c as Element).scrollHeight;
    const step = Math.max(400, c === window ? window.innerHeight : (c as Element).clientHeight);
    for (let y = 0; y < height && Date.now() < deadline; y += step) {
      c.scrollTo(0, y);
      await sleep(40);
    }
    c.scrollTo(0, 0);
  }
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

const loadedIframes = new WeakSet<HTMLIFrameElement>();

function trackIframes(root: ParentNode): void {
  root.querySelectorAll('iframe').forEach((f) => {
    if (loadedIframes.has(f) || f.dataset.cfpTracked) return;
    f.dataset.cfpTracked = '1';
    f.addEventListener('load', () => loadedIframes.add(f), { once: true });
  });
}

function iframeLoaded(f: HTMLIFrameElement): boolean {
  if (loadedIframes.has(f)) return true;
  const src = f.getAttribute('src') ?? '';
  if (!src || src.startsWith('about:') || src.startsWith('javascript:')) return true;
  try {
    // Same-origin frames: inspect readyState directly.
    const doc = f.contentDocument;
    if (doc && doc.readyState === 'complete' && doc.URL !== 'about:blank') return true;
  } catch {
    /* cross-origin */
  }
  // Cross-origin frames: a finished navigation shows up in resource timing.
  try {
    const abs = new URL(src, location.href).href;
    return performance
      .getEntriesByType('resource')
      .some((e) => (e as PerformanceResourceTiming).initiatorType === 'iframe' && e.name === abs && (e as PerformanceResourceTiming).responseEnd > 0);
  } catch {
    return false;
  }
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function describe(el: Element): string {
  const name = el.getAttribute('data-macro-name') ?? el.getAttribute('data-extension-key');
  if (name) return name.trim();
  if (el instanceof HTMLImageElement) {
    const file = (el.currentSrc || el.src).split('/').pop()?.split('?')[0] ?? '';
    return `image ${el.getAttribute('alt') || decodeURIComponentSafe(file)}`.trim();
  }
  if (el instanceof HTMLIFrameElement) {
    try {
      return `embed ${new URL(el.src, location.href).hostname}`;
    } catch {
      return 'embed';
    }
  }
  return (typeof el.className === 'string' && el.className.split(/\s+/)[0]) || el.tagName.toLowerCase();
}

/** Returns descriptions of everything that is not rendered yet (empty = done). */
function pendingItems(root: Element): string[] {
  const pending: string[] = [];
  root.querySelectorAll('img').forEach((img) => {
    if (!isVisible(img)) return;
    if (!img.complete) pending.push(describe(img));
  });
  root.querySelectorAll('iframe').forEach((f) => {
    if (isVisible(f) && !iframeLoaded(f)) pending.push(describe(f));
  });
  root.querySelectorAll(MACRO_SELECTORS.join(',')).forEach((m) => {
    if (!isVisible(m)) return;
    const hasVisual = !!m.querySelector('svg, canvas, img, iframe, object, embed') && !m.querySelector(LOADING_SELECTORS.join(','));
    if (!hasVisual) pending.push(describe(m));
  });
  root.querySelectorAll(LOADING_SELECTORS.join(',')).forEach((l) => {
    if (isVisible(l)) pending.push('loading indicator');
  });
  return [...new Set(pending)];
}

/** Resolves once no resource finished/started for NETWORK_QUIET_MS (bounded by maxMs). */
async function waitForNetworkQuiet(maxMs: number): Promise<void> {
  let last = Date.now();
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver(() => {
      last = Date.now();
    });
    observer.observe({ type: 'resource', buffered: false });
  } catch {
    observer = undefined;
  }
  const end = Date.now() + maxMs;
  try {
    while (Date.now() < end) {
      if (Date.now() - last >= NETWORK_QUIET_MS) return;
      await sleep(100);
    }
  } finally {
    observer?.disconnect();
  }
}

async function prepare(msg: SwToLive): Promise<Prepared> {
  const started = Date.now();
  const timeoutMs = Math.max(1000, msg.timeoutMs || 20_000);
  const deadline = started + timeoutMs;

  addStyle('cfp-live-hide-chrome', hideChromeCss());
  disableLazyLoading();
  expandAll();
  trackIframes(document);

  await scrollThrough(Math.min(deadline, started + 5000));
  // Expanding can reveal more lazy content and nested expands.
  expandAll();
  disableLazyLoading();

  const root = contentRoot();
  let missing = pendingItems(root);
  while (missing.length && Date.now() < deadline) {
    await sleep(POLL_MS);
    trackIframes(root);
    missing = pendingItems(root);
  }
  // Cross-origin app iframes (draw.io, Lucid, …) keep drawing after their load event.
  if (root.querySelector('iframe')) await sleep(Math.min(IFRAME_SETTLE_MS, Math.max(0, deadline + 2000 - Date.now())));

  await waitForNetworkQuiet(Math.min(MAX_QUIET_WAIT_MS, Math.max(NETWORK_QUIET_MS, deadline + 3000 - Date.now())));
  try {
    await Promise.race([document.fonts?.ready, sleep(3000)]);
  } catch {
    /* fonts API unavailable */
  }

  if (msg.customCss) addStyle('cfp-live-custom', msg.customCss);
  window.scrollTo(0, 0);
  missing = pendingItems(root);
  return { rendered: missing.length === 0, waitedMs: Date.now() - started, missing };
}

export default defineUnlistedScript(() => {
  const w = window as unknown as { __cfpLiveInstalled?: boolean };
  if (w.__cfpLiveInstalled) return;
  w.__cfpLiveInstalled = true;

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const m = msg as SwToLive | undefined;
    if (!m || m.type !== 'live/prepare') return false;
    return respond(sendResponse, () => prepare(m));
  });
});
