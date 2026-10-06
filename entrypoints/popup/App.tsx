import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button } from '../../components/Button';
import { collectPages } from '../../components/collectClient';
import { errorMessage, openJobTab, showDownload, useJob } from '../../components/hooks';
import { Icon, Spinner } from '../../components/Icon';
import { JobProgress } from '../../components/JobProgress';
import { formatDate, isJobActive, isRestrictedUrl, plural, TYPE_LABEL } from '../../components/logic';
import type { PendingStartPayload } from '../../lib/messages';
import { Notice } from '../../components/Notice';
import { Select } from '../../components/Select';
import { Toggle } from '../../components/Toggle';
import { probePage } from '../../lib/confluence/detect';
import type { ProbeResult } from '../../lib/messages';
import { hasSiteAccess, requestSiteAccess } from '../../lib/permissions';
import { callSw } from '../../lib/rpc';
import { loadPolicy, loadSettings } from '../../lib/settings';
import type { ExportJobState, ExportMode, ExportRequest, ManagedPolicy, PageContext, Settings } from '../../lib/types';
import {
  LINK_DEPTHS,
  SUBTREE_DEPTHS,
  availableModes,
  buildRequest,
  isMultiMode,
  isSpaceBlocked,
  modeLabel,
  type DepthChoice,
} from './modes';

type Phase =
  | { kind: 'loading' }
  | { kind: 'restricted' }
  | { kind: 'not-confluence' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; ctx: PageContext; tabId: number };

const PROBE_TIMEOUT_MS = 12_000;

async function probeActiveTab(): Promise<Phase> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.id === chrome.tabs.TAB_ID_NONE) return { kind: 'error', message: 'No active tab.' };
  if (isRestrictedUrl(tab.url)) return { kind: 'restricted' };
  let result: ProbeResult | undefined;
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The page took too long to respond.')), PROBE_TIMEOUT_MS),
    );
    const results = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage }),
      timeout,
    ]);
    result = results?.[0]?.result as ProbeResult | undefined;
  } catch (e) {
    const msg = errorMessage(e);
    if (/cannot access|cannot be scripted|extensions gallery|chrome:\/\/|manifest must request permission|showing error page/i.test(msg)) {
      return { kind: 'restricted' };
    }
    return { kind: 'error', message: msg };
  }
  if (!result || !result.isConfluence) return { kind: 'not-confluence' };
  const { isConfluence: _ignored, ...ctx } = result;
  return { kind: 'ready', ctx, tabId: tab.id };
}

export function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [policy, setPolicy] = useState<ManagedPolicy>({});
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([loadSettings(), loadPolicy().catch(() => ({}) as ManagedPolicy), probeActiveTab()])
      .then(([s, p, ph]) => {
        if (!alive) return;
        setSettings(s);
        setPolicy(p);
        setPhase(ph);
      })
      .catch((e) => alive && setPhase({ kind: 'error', message: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, []);

  const openOptions = () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  };

  return (
    <div class="popup">
      <header class="popup-header">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="pdf" size={16} />
        </span>
        <span class="app-title">Fast PDF Export</span>
        <Button variant="ghost" icon="gear" label="Settings" onClick={openOptions} />
      </header>
      {phase.kind === 'loading' || (phase.kind === 'ready' && !settings) ? (
        <div class="popup-state">
          <Spinner size={20} label="Loading" />
          <p>Reading this page…</p>
        </div>
      ) : phase.kind === 'restricted' ? (
        <StateMessage
          icon="lock"
          title="Can’t export this page"
          text="Browser pages and the extension store can’t be read by extensions. Open a Confluence page, then click again."
          onOptions={openOptions}
        />
      ) : phase.kind === 'not-confluence' ? (
        <StateMessage
          icon="page"
          title="This isn’t a Confluence page"
          text="Open a Confluence page, folder or space, then click again."
          onOptions={openOptions}
        />
      ) : phase.kind === 'error' ? (
        <StateMessage icon="alert" title="Something went wrong" text={phase.message} onOptions={openOptions} />
      ) : (
        <Ready
          ctx={phase.ctx}
          tabId={phase.tabId}
          settings={settings!}
          policy={policy}
          onJobStarted={setCurrentJobId}
        />
      )}
      <LastJob hideId={currentJobId} />
    </div>
  );
}

function StateMessage({
  icon,
  title,
  text,
  onOptions,
}: {
  icon: 'lock' | 'page' | 'alert';
  title: string;
  text: string;
  onOptions: () => void;
}): JSX.Element {
  return (
    <div class="popup-state">
      <Icon name={icon} size={28} class="state-icon" />
      <h2>{title}</h2>
      <p>{text}</p>
      <button type="button" class="link-btn" onClick={onOptions}>
        Settings &amp; site access
      </button>
    </div>
  );
}

function Ready({
  ctx,
  tabId,
  settings,
  policy,
  onJobStarted,
}: {
  ctx: PageContext;
  tabId: number;
  settings: Settings;
  policy: ManagedPolicy;
  onJobStarted: (id: string) => void;
}): JSX.Element {
  const modes = useMemo(() => availableModes(ctx), [ctx]);
  const [mode, setMode] = useState<ExportMode | undefined>(modes[0]);
  const [depth, setDepth] = useState<DepthChoice>('all');
  const [linkDepth, setLinkDepth] = useState<1 | 2>(1);
  const liveLocked = !!policy.disableLiveRender;
  const [cover, setCover] = useState(settings.defaults.includeCover);
  const [toc, setToc] = useState(settings.defaults.includeToc);
  const [live, setLive] = useState(settings.defaults.liveRender && !liveLocked);
  const [access, setAccess] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobIdState] = useState<string | null>(null);
  const setJobId = (id: string) => {
    setJobIdState(id);
    onJobStarted(id);
  };
  const [count, setCount] = useState<{ key: string; n: number } | null>(null);
  const blocked = isSpaceBlocked(ctx.spaceKey, policy.blockedSpaceKeys);
  const origin = ctx.site.origin;

  useEffect(() => {
    hasSiteAccess(origin).then(setAccess, () => setAccess(false));
  }, [origin]);

  const makeRequest = useCallback(
    (m: ExportMode): ExportRequest =>
      buildRequest(ctx, {
        mode: m,
        depth,
        linkDepth,
        options: { ...settings.defaults, includeCover: cover, includeToc: toc, liveRender: live && !liveLocked },
        sourceTabId: tabId,
      }),
    [ctx, depth, linkDepth, settings, cover, toc, live, liveLocked, tabId],
  );

  // Page count for "Preview (N pages)", only with site access (the collector runs in a background
  // worker tab on the Confluence origin). Linked depth 2 can fan out to thousands of requests, so
  // it is not counted here. The service worker keeps the result briefly, so the preview reuses it
  // instead of collecting again; closing the popup cancels a running count.
  const countKey =
    mode && (mode === 'subtree' || mode === 'folder' || (mode === 'linked' && linkDepth === 1)) ? `${mode}:${depth}:${linkDepth}` : '';
  useEffect(() => {
    if (!countKey || access !== true || !mode || blocked) return;
    const controller = new AbortController();
    const t = setTimeout(() => {
      collectPages(makeRequest(mode), { signal: controller.signal }).then(
        (r) => !controller.signal.aborted && setCount({ key: countKey, n: r.pages.length }),
        () => undefined,
      );
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(t);
    };
    // makeRequest also changes with toggles that do not affect the count; countKey covers the rest.
  }, [countKey, access, blocked]);

  const startJob = async (request: ExportRequest) => {
    const { jobId: id } = await callSw({ type: 'job/start', request });
    setJobId(id);
  };

  /**
   * After a permission grant the service worker may already be starting the pending export
   * (chrome.permissions.onAdded). Both go through one claim in the service worker, keyed by the
   * pending start, so the export starts exactly once and we get its job.
   */
  const handoffAfterGrant = async (pending: PendingStartPayload) => {
    const { jobId: id } = await callSw({ type: 'job/claimPending', pending });
    setJobId(id);
  };

  const onExport = () => {
    if (!mode || blocked) return;
    setError(null);
    const request = makeRequest(mode);

    if (isMultiMode(mode)) {
      setBusy(true);
      callSw({ type: 'preview/open', request }).then(
        () => window.close(),
        (e) => {
          setBusy(false);
          setError(errorMessage(e));
        },
      );
      return;
    }

    if (access) {
      setBusy(true);
      startJob(request)
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setBusy(false));
      return;
    }

    // No site access yet. The permission prompt may close this popup, so leave the request for the
    // service worker first (fire-and-forget) and call permissions.request synchronously within
    // this user gesture.
    const pending: PendingStartPayload = { request, createdAt: Date.now() };
    const stored = chrome.storage.session.set({ pendingStart: pending }).catch(() => undefined);
    setBusy(true);
    requestSiteAccess(origin)
      .then(async (granted) => {
        await stored;
        if (!granted) {
          await chrome.storage.session.remove('pendingStart').catch(() => undefined);
          setError(`Access to ${origin} is needed to read the page. Nothing was exported.`);
          return;
        }
        setAccess(true);
        await handoffAfterGrant(pending);
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (jobId) return <RunningJob jobId={jobId} />;

  const multi = mode ? isMultiMode(mode) : false;
  const n = count && count.key === countKey ? count.n : null;
  const kindLabel = ctx.kind !== 'space' && ctx.kind !== 'unknown' && ctx.kind !== 'page' ? TYPE_LABEL[ctx.kind] : null;
  const meta = [
    kindLabel,
    ctx.kind === 'space' ? 'Space overview' : null,
    ctx.spaceKey ? `Space ${ctx.spaceKey}` : null,
    ctx.lastUpdated ? `Updated ${formatDate(ctx.lastUpdated)}` : null,
  ].filter((x): x is string => !!x);

  return (
    <>
      <section class="popup-section" aria-label="Current page">
        <div class="ctx-title" title={ctx.title}>
          {ctx.title || (ctx.kind === 'space' ? ctx.spaceKey : 'Untitled')}
        </div>
        {meta.length ? <div class="ctx-meta">{meta.join(' · ')}</div> : null}
      </section>

      {blocked ? (
        <section class="popup-section">
          <Notice tone="warn" icon="lock" title="Export disabled">
            Your administrator has disabled exports from space {ctx.spaceKey}.
          </Notice>
        </section>
      ) : modes.length === 0 ? (
        <section class="popup-section">
          <Notice tone="info">Open a page, folder or space in Confluence to export it.</Notice>
        </section>
      ) : (
        <>
          <section class="popup-section">
            <fieldset class="modes">
              <legend class="visually-hidden">What to export</legend>
              {modes.map((m) => (
                <div key={m} class={`mode${mode === m ? ' is-active' : ''}`}>
                  <label>
                    <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
                    <span>{modeLabel(m, ctx.kind)}</span>
                  </label>
                  {m === 'subtree' ? (
                    <Select<DepthChoice>
                      compact
                      ariaLabel="Depth"
                      value={depth}
                      options={SUBTREE_DEPTHS}
                      disabled={mode !== 'subtree'}
                      onChange={setDepth}
                    />
                  ) : m === 'linked' ? (
                    <Select<1 | 2>
                      compact
                      ariaLabel="Link depth"
                      value={linkDepth}
                      options={LINK_DEPTHS}
                      disabled={mode !== 'linked'}
                      onChange={setLinkDepth}
                    />
                  ) : null}
                </div>
              ))}
            </fieldset>
          </section>

          <section class="popup-section">
            <div class="quick-toggles">
              <Toggle appearance="checkbox" label="Cover" checked={cover} onChange={setCover} />
              <Toggle appearance="checkbox" label="TOC" checked={toc} onChange={setToc} />
              <Toggle
                appearance="checkbox"
                label="Live render (slow)"
                checked={live}
                locked={liveLocked}
                onChange={setLive}
              />
            </div>
            {error ? (
              <div style={{ marginTop: '10px' }}>
                <Notice tone="error" compact>
                  {error}
                </Notice>
              </div>
            ) : null}
            {!multi && access === false ? (
              <p class="hint" style={{ marginTop: '10px', marginBottom: 0 }}>
                The first export from {new URL(origin).host} asks for permission to read it. Nothing leaves your browser.
              </p>
            ) : null}
            <div class="popup-actions">
              {multi ? (
                <Button variant="primary" icon="page" loading={busy} onClick={onExport}>
                  {mode === 'selection' ? 'Choose pages…' : n !== null ? `Preview (${plural(n, 'page')})` : 'Preview…'}
                </Button>
              ) : (
                <Button variant="primary" icon="download" loading={busy} onClick={onExport}>
                  Export
                </Button>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function RunningJob({ jobId }: { jobId: string }): JSX.Element {
  const { job, missing } = useJob(jobId, 1500);
  return (
    <section class="popup-section">
      {!job ? (
        missing ? (
          <Notice tone="error">The export could not be found. Please try again.</Notice>
        ) : (
          <div class="popup-state">
            <Spinner size={20} label="Starting" />
            <p>Starting export…</p>
          </div>
        )
      ) : (
        <>
          {isJobActive(job.status) ? (
            <p class="hint" style={{ marginTop: 0 }}>
              Exporting… you can close this popup.
            </p>
          ) : null}
          <JobProgress job={job} compact />
        </>
      )}
    </section>
  );
}

const RECENT_MS = 30 * 60 * 1000;

/**
 * Compact status line for the most recent export: running, or finished (also failed or
 * cancelled) in the last 30 min — with notifications off, this is where a failure shows up.
 */
function LastJob({ hideId }: { hideId: string | null }): JSX.Element | null {
  const [job, setJob] = useState<ExportJobState | null>(null);
  const jobRef = useRef<ExportJobState | null>(null);
  jobRef.current = job;

  useEffect(() => {
    let alive = true;
    callSw({ type: 'job/list' }).then(
      (jobs) => alive && setJob(jobs[0] ?? null),
      () => undefined,
    );
    const off = onJobUpdate((j) => {
      const cur = jobRef.current;
      if (!cur || j.id === cur.id || j.createdAt >= cur.createdAt) setJob(j);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!job || job.id === hideId) return null;
  const active = isJobActive(job.status);
  const recent = (job.finishedAt ?? job.createdAt) > Date.now() - RECENT_MS;
  if (!active && !recent) return null;
  const title = job.request.root.title || job.request.root.spaceKey || 'Export';
  const failed = job.status === 'error';
  const counting = active && job.progress.total > 0 && job.progress.unit !== 'step';

  return (
    <div class={`last-job${failed ? ' is-error' : ''}`} role="status">
      {active ? <Spinner size={12} /> : <Icon name={failed ? 'alert' : job.status === 'cancelled' ? 'x' : 'checkCircle'} size={14} />}
      <span class="grow">
        {active
          ? `Exporting “${title}”${counting ? ` · ${Math.min(job.progress.done, job.progress.total)}/${job.progress.total}` : '…'}`
          : failed
            ? `Export of “${title}” failed`
            : job.status === 'cancelled'
              ? `Export of “${title}” was cancelled`
              : `Last export: ${job.result?.filename ?? title}`}
      </span>
      {active || failed ? (
        <button type="button" class="link-btn" onClick={() => void openJobTab(job.id).then(() => window.close())}>
          {active ? 'View' : 'Details'}
        </button>
      ) : job.result?.downloadId !== undefined ? (
        <button type="button" class="link-btn" onClick={() => void showDownload(job.result?.downloadId)}>
          Show
        </button>
      ) : null}
    </div>
  );
}
