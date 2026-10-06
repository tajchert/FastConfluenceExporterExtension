/// <reference types="node" />
/**
 * Playwright fixtures for the E2E suite: one Chromium with the unpacked e2e build loaded
 * (worker-scoped, shared by every test), a Cloud mock and a Data Center mock.
 *
 * The extension is driven the same way its own UI drives it: an extension page sends `UiToSw`
 * messages (`job/start`, `job/get`, `collect`, …) to the service worker. Downloads made through
 * `chrome.downloads` are located with `chrome.downloads.search` (Playwright's `download` event
 * does not fire for them) and read from disk.
 */
import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportJobState, ExportOptions, ExportRequest, JobStatus, PageRef, SiteInfo } from '../../lib/types';
import { DEFAULT_OPTIONS } from '../../lib/types';
import { startMockConfluence, type MockConfluence } from './mock-confluence/server.mjs';

export const EXTENSION_DIR = path.resolve(process.cwd(), '.output/chrome-mv3-e2e');
const TERMINAL: JobStatus[] = ['done', 'error', 'cancelled'];

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export interface DownloadInfo {
  id: number;
  filename: string;
  state: string;
  mime: string;
  bytes: Uint8Array;
}

export class ExtensionHarness {
  constructor(
    readonly context: BrowserContext,
    readonly extensionId: string,
    readonly serviceWorker: Worker,
    /** An idle extension page (preview.html without parameters) used to talk to the SW. */
    readonly driver: Page,
  ) {}

  url(page: string): string {
    return `chrome-extension://${this.extensionId}/${page}`;
  }

  /** Sends a UiToSw message from an extension page, like the popup / preview do. */
  async call<T>(msg: unknown): Promise<T> {
    const res = (await this.driver.evaluate((m) => chrome.runtime.sendMessage(m), msg as object)) as RpcResult<T> | undefined;
    if (!res) throw new Error(`No response to ${JSON.stringify(msg).slice(0, 80)}`);
    if (!res.ok) throw new Error(`SW error: ${res.error}${res.code ? ` (${res.code})` : ''}`);
    return res.value;
  }

  async startJob(request: ExportRequest, pages?: PageRef[]): Promise<string> {
    const { jobId } = await this.call<{ jobId: string }>({ type: 'job/start', request, pages });
    return jobId;
  }

  getJob(jobId: string): Promise<ExportJobState | null> {
    return this.call<ExportJobState | null>({ type: 'job/get', jobId });
  }

  /** Polls `job/get` until the job reaches one of `statuses` (default: any terminal state). */
  async waitForJob(
    jobId: string,
    statuses: JobStatus[] = TERMINAL,
    timeoutMs = 90_000,
  ): Promise<ExportJobState> {
    const until = Date.now() + timeoutMs;
    let last: ExportJobState | null = null;
    while (Date.now() < until) {
      last = await this.getJob(jobId);
      if (last && statuses.includes(last.status)) return last;
      if (last && TERMINAL.includes(last.status) && !statuses.includes(last.status)) {
        throw new Error(`Job ended as "${last.status}" (waiting for ${statuses.join('|')}): ${last.message} ${JSON.stringify(last.errors)}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for job ${jobId} → ${statuses.join('|')}; last: ${JSON.stringify(last && { status: last.status, message: last.message })}`);
  }

  /** Reads a finished chrome.downloads item from disk. */
  async download(downloadId: number): Promise<DownloadInfo> {
    const until = Date.now() + 20_000;
    for (;;) {
      const [item] = (await this.driver.evaluate((id) => chrome.downloads.search({ id }), downloadId)) as chrome.downloads.DownloadItem[];
      if (item?.state === 'complete' && item.filename && fs.existsSync(item.filename)) {
        return { id: item.id, filename: item.filename, state: item.state, mime: item.mime, bytes: new Uint8Array(fs.readFileSync(item.filename)) };
      }
      if (item?.state === 'interrupted') throw new Error(`Download interrupted: ${item.error}`);
      if (Date.now() > until) throw new Error(`Download ${downloadId} not found on disk: ${JSON.stringify(item)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Runs an export to the end and reads the downloaded file; fails unless the job is `done`. */
  async exportAndDownload(request: ExportRequest, pages?: PageRef[], timeoutMs?: number): Promise<{ job: ExportJobState; file: DownloadInfo }> {
    const jobId = await this.startJob(request, pages);
    const job = await this.waitForJob(jobId, undefined, timeoutMs);
    if (job.status !== 'done' || job.result?.downloadId === undefined) {
      throw new Error(`Export ended as "${job.status}": ${job.message} ${JSON.stringify(job.errors)}`);
    }
    return { job, file: await this.download(job.result.downloadId) };
  }

  /** Opens a Confluence page in a normal tab (this also sets the mock's session cookie). */
  async openPage(url: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(url);
    return page;
  }

  /** Tabs the extension opened on a Confluence JSON endpoint (worker tabs). */
  async workerTabUrls(): Promise<string[]> {
    const tabs = (await this.driver.evaluate(() => chrome.tabs.query({}))) as chrome.tabs.Tab[];
    return tabs.map((t) => t.url ?? t.pendingUrl ?? '').filter((u) => /\/(rest\/api\/space|api\/v2\/spaces)\?limit=1/.test(u));
  }

  /** Tab ids the extension still holds a chrome.debugger session on. */
  async debuggerAttachedTabs(): Promise<number[]> {
    return this.serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const held: number[] = [];
      for (const t of tabs) {
        if (t.id === undefined) continue;
        try {
          // Only succeeds when *this extension* is attached to the tab.
          await chrome.debugger.detach({ tabId: t.id });
          held.push(t.id);
        } catch {
          /* not attached by us */
        }
      }
      return held;
    });
  }

  async closeOtherPages(keep: Page[] = []): Promise<void> {
    for (const p of this.context.pages()) {
      if (p === this.driver || keep.includes(p)) continue;
      await p.close().catch(() => undefined);
    }
  }
}

export function cloudSite(mock: MockConfluence): SiteInfo {
  return { origin: mock.origin, baseUrl: mock.baseUrl, contextPath: '/wiki', flavour: 'cloud', siteTitle: 'Mock Cloud Wiki' };
}

export function dcSite(mock: MockConfluence): SiteInfo {
  return { origin: mock.origin, baseUrl: mock.baseUrl, contextPath: '/confluence', flavour: 'server', siteTitle: 'Mock DC Wiki' };
}

export function options(overrides: Partial<ExportOptions> = {}): ExportOptions {
  return { ...DEFAULT_OPTIONS, marginsMm: { ...DEFAULT_OPTIONS.marginsMm }, ...overrides };
}

/**
 * Loads an unpacked build into a persistent Chromium profile whose downloads go to `downloadsDir`.
 * Shared with the live suite (tests/live), which loads `.output/chrome-mv3-live`.
 */
export async function launchExtension(
  downloadsDir: string,
  extensionDir = EXTENSION_DIR,
  buildCommand = 'npm run build:e2e',
): Promise<ExtensionHarness> {
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) {
    throw new Error(`Build the extension first: ${buildCommand} (missing ${extensionDir})`);
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-e2e-profile-'));
  // Chrome's own download preferences: straight to `downloadsDir`, never ask.
  fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true } }),
  );
  const headed = !!process.env.HEADED;
  const context = await chromium.launchPersistentContext(userDataDir, {
    // Full Chromium (new headless mode) supports extensions; the headless shell does not.
    channel: 'chromium',
    headless: !headed,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(sw.url()).host;
  const driver = context.pages()[0] ?? (await context.newPage());
  await driver.goto(`chrome-extension://${extensionId}/preview.html`);
  // Playwright saves downloads under GUID names; let Chrome keep the extension's filename so the
  // tests see exactly what a user would get.
  const cdp = await context.newCDPSession(driver);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir });
  await cdp.detach();
  return new ExtensionHarness(context, extensionId, sw, driver);
}

export const test = base.extend<
  { resetMocks: void },
  { ext: ExtensionHarness; cloud: MockConfluence; dc: MockConfluence; downloadsDir: string }
>({
  downloadsDir: [
    async ({}, use) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfp-e2e-downloads-'));
      await use(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    { scope: 'worker' },
  ],
  cloud: [
    async ({}, use) => {
      const mock = await startMockConfluence({ flavour: 'cloud' });
      await use(mock);
      await mock.close();
    },
    { scope: 'worker' },
  ],
  dc: [
    async ({}, use) => {
      // Different host (localhost vs 127.0.0.1) so the two sites never share cookies.
      const mock = await startMockConfluence({ flavour: 'server', publicHost: 'localhost' });
      await use(mock);
      await mock.close();
    },
    { scope: 'worker' },
  ],
  ext: [
    async ({ downloadsDir }, use) => {
      const ext = await launchExtension(downloadsDir);
      await use(ext);
      await ext.context.close();
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  resetMocks: [
    async ({ cloud, dc, ext }, use) => {
      cloud.reset();
      dc.reset();
      await use();
      await ext.closeOtherPages();
    },
    { auto: true },
  ],
});

export const expect = test.expect;
