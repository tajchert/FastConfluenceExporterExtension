import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button } from '../../components/Button';
import { errorMessage, useJob } from '../../components/hooks';
import { Icon, Spinner } from '../../components/Icon';
import { JobProgress } from '../../components/JobProgress';
import { isJobActive, jobFraction, largeExportGuard, plural } from '../../components/logic';
import { Notice } from '../../components/Notice';
import { OptionsForm } from '../../components/OptionsForm';
import { PageList } from '../../components/PageList';
import { TreePicker } from '../../components/TreePicker';
import { hasSiteAccess, originPattern, requestSiteAccess } from '../../lib/permissions';
import { callSw } from '../../lib/rpc';
import { loadPolicy, loadSettings } from '../../lib/settings';
import type { ContentType, ExportOptions, ExportRequest, ManagedPolicy, PageRef, Settings, TreeNode } from '../../lib/types';
import { decodeRequestParam } from '../../lib/util/base64';
import { applyPolicy, describeRequest, validateRequest } from './request';

type Step =
  | { kind: 'init' }
  | { kind: 'fatal'; message: string }
  | { kind: 'permission'; denied?: boolean }
  | { kind: 'tree' }
  | { kind: 'collecting' }
  | { kind: 'collect-failed'; message: string }
  | { kind: 'list' }
  | { kind: 'job'; jobId: string };

/** Modes whose page list is a single tree in DFS order (indentation + branch toggles). */
const TREE_MODES = new Set(['subtree', 'folder', 'space']);

export function App(): JSX.Element {
  const [step, setStep] = useState<Step>({ kind: 'init' });
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [policy, setPolicy] = useState<ManagedPolicy>({});
  const [options, setOptions] = useState<ExportOptions | null>(null);
  const [locked, setLocked] = useState<Set<keyof ExportOptions>>(() => new Set());
  const [pages, setPages] = useState<PageRef[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmLarge, setConfirmLarge] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const collectSeq = useRef(0);

  // ── bootstrap from ?req= or ?job= ──
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const jobId = params.get('job');
    const reqParam = params.get('req');
    Promise.all([loadSettings(), loadPolicy().catch(() => ({}) as ManagedPolicy)])
      .then(([s, p]) => {
        setSettings(s);
        setPolicy(p);
        if (jobId) {
          setStep({ kind: 'job', jobId });
          return;
        }
        if (!reqParam) {
          setStep({ kind: 'fatal', message: 'Nothing to export. Start an export from the extension’s toolbar button.' });
          return;
        }
        let req: ExportRequest | null = null;
        try {
          req = validateRequest(decodeRequestParam<unknown>(reqParam));
        } catch {
          req = null;
        }
        if (!req) {
          setStep({ kind: 'fatal', message: 'This export link is invalid or incomplete. Start the export again from the toolbar button.' });
          return;
        }
        void begin(req, p);
      })
      .catch((e) => setStep({ kind: 'fatal', message: errorMessage(e) }));
  }, []);

  const begin = async (req: ExportRequest, pol: ManagedPolicy = policy) => {
    const applied = applyPolicy(req.options, pol);
    setRequest(req);
    setOptions(applied.options);
    setLocked(applied.locked);
    setPages([]);
    setExcluded(new Set());
    setSelectedIds(req.selectedIds ?? []);
    setConfirmLarge(false);
    setStartError(null);
    let ok = false;
    try {
      ok = await hasSiteAccess(req.site.origin);
    } catch {
      ok = false;
    }
    if (!ok) {
      setStep({ kind: 'permission' });
      return;
    }
    proceed(req, applied.options);
  };

  /** Guards against the grant callback and permissions.onAdded both continuing the same request. */
  const proceededFor = useRef<ExportRequest | null>(null);

  const proceed = (req: ExportRequest, opts: ExportOptions, afterGrant = false) => {
    if (afterGrant) {
      if (proceededFor.current === req) return;
      proceededFor.current = req;
    }
    // "Allow & export" for a single page (keyboard shortcut / context menu without site access):
    // the user already asked for this export, so start it right away instead of showing a preview.
    if (afterGrant && req.mode === 'current') {
      void startDirect({ ...req, options: opts });
      return;
    }
    if (req.mode === 'selection') setStep({ kind: 'tree' });
    else void collect(req, opts);
  };

  const startDirect = async (req: ExportRequest) => {
    setStep({ kind: 'collecting' });
    try {
      const { jobId } = await callSw({ type: 'job/start', request: req });
      history.replaceState(null, '', `?job=${encodeURIComponent(jobId)}`);
      setStep({ kind: 'job', jobId });
    } catch (e) {
      // Fall back to the regular preview so the user can retry from there.
      setStartError(errorMessage(e));
      void collect(req, req.options);
    }
  };

  const collect = useCallback(async (req: ExportRequest, opts: ExportOptions, ids?: string[]) => {
    const seq = ++collectSeq.current;
    setStep({ kind: 'collecting' });
    try {
      const r = await callSw({
        type: 'collect',
        request: { ...req, options: opts, ...(ids ? { selectedIds: ids } : {}) },
      });
      if (seq !== collectSeq.current) return;
      setPages(r.pages);
      setWarnings(r.warnings);
      // Keep exclusions that still apply after a re-collect.
      setExcluded((prev) => new Set(r.pages.filter((p) => prev.has(p.id)).map((p) => p.id)));
      setStep({ kind: 'list' });
    } catch (e) {
      if (seq !== collectSeq.current) return;
      setStep({ kind: 'collect-failed', message: errorMessage(e) });
    }
  }, []);

  // Another tab (e.g. the options page) may grant access while we wait.
  useEffect(() => {
    if (step.kind !== 'permission' || !request || !options) return;
    const pattern = originPattern(request.site.origin);
    const onAdded = (p: chrome.permissions.Permissions) => {
      if (p.origins?.some((o) => o === pattern)) proceed(request, options, true);
    };
    chrome.permissions.onAdded.addListener(onAdded);
    return () => chrome.permissions.onAdded.removeListener(onAdded);
  }, [step.kind, request, options]);

  const grant = () => {
    if (!request || !options) return;
    // Called directly from the click: permissions.request needs the user gesture.
    requestSiteAccess(request.site.origin).then(
      (granted) => (granted ? proceed(request, options, true) : setStep({ kind: 'permission', denied: true })),
      (e) => setStep({ kind: 'fatal', message: errorMessage(e) }),
    );
  };

  const onOptionsChange = (next: ExportOptions) => {
    const prev = options;
    setOptions(next);
    if (request && prev && prev.includeArchived !== next.includeArchived && step.kind === 'list') {
      void collect(request, next, request.mode === 'selection' ? selectedIds : undefined);
    }
  };

  const loadChildren = useCallback(
    (parent?: { id: string; type: ContentType }): Promise<TreeNode[]> => {
      if (!request?.root.spaceKey) return Promise.reject(new Error('The space of this page is unknown.'));
      return callSw({
        type: 'tree/children',
        site: request.site,
        spaceKey: request.root.spaceKey,
        spaceId: request.root.spaceId,
        parent,
      });
    },
    [request],
  );

  const included = useMemo(() => pages.filter((p) => !excluded.has(p.id)), [pages, excluded]);
  const guard = settings
    ? largeExportGuard(included.length, {
        warn: settings.warnPageCount,
        confirm: settings.confirmPageCount,
        max: policy.maxPages,
      })
    : { level: 'none' as const, message: '' };
  const canExport =
    step.kind === 'list' &&
    !starting &&
    guard.level !== 'empty' &&
    guard.level !== 'blocked' &&
    (guard.level !== 'confirm' || confirmLarge);

  useEffect(() => {
    if (guard.level !== 'confirm') setConfirmLarge(false);
  }, [guard.level]);

  const startExport = async () => {
    if (!request || !options || !canExport) return;
    setStarting(true);
    setStartError(null);
    try {
      const req: ExportRequest = {
        ...request,
        options,
        selectedIds: request.mode === 'selection' ? selectedIds : request.selectedIds,
      };
      const { jobId } = await callSw({ type: 'job/start', request: req, pages: included });
      history.replaceState(null, '', `?job=${encodeURIComponent(jobId)}`);
      setStep({ kind: 'job', jobId });
    } catch (e) {
      setStartError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  // ── document title ──
  useEffect(() => {
    const base = request?.root.title || request?.root.spaceKey || 'Confluence';
    if (step.kind !== 'job') document.title = `Export · ${base}`;
  }, [request, step.kind]);

  const host = request ? new URL(request.site.origin).host : '';

  return (
    <div class="page-shell">
      <header class="app-header">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="pdf" size={16} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1>Export to PDF</h1>
          {request ? (
            <div class="page-sub">
              {describeRequest(request)} · {host}
            </div>
          ) : null}
        </div>
        <Button variant="ghost" icon="gear" label="Settings" onClick={() => void chrome.runtime.openOptionsPage()} />
      </header>

      {step.kind === 'init' ? (
        <div class="empty">
          <Spinner /> Loading…
        </div>
      ) : step.kind === 'fatal' ? (
        <div class="card job-card">
          <Notice tone="error" title="Can’t continue">
            {step.message}
          </Notice>
        </div>
      ) : step.kind === 'permission' && request ? (
        <PermissionCard
          origin={request.site.origin}
          denied={!!step.denied}
          onGrant={grant}
          label={request.mode === 'current' ? 'Allow & export' : 'Allow access'}
        />
      ) : step.kind === 'job' ? (
        <JobView
          jobId={step.jobId}
          onExportAgain={(req) => {
            history.replaceState(null, '', location.pathname);
            void begin(req);
          }}
        />
      ) : request && options && settings ? (
        <>
          <div class="preview-layout">
            <main class="stack" aria-label="Pages">
              {request.mode === 'selection' ? (
                <div hidden={step.kind !== 'tree'}>
                  <TreePicker
                    loadChildren={loadChildren}
                    preselect={request.selectedIds}
                    onSelectionChange={setSelectedIds}
                  />
                </div>
              ) : null}

              {step.kind === 'collecting' ? (
                <div class="card empty">
                  <Spinner /> Collecting pages… this can take a moment for large trees.
                </div>
              ) : null}

              {step.kind === 'collect-failed' ? (
                <div class="card stack">
                  <Notice tone="error" title="Could not collect the pages">
                    {step.message}
                  </Notice>
                  <div class="job-actions">
                    <Button
                      variant="primary"
                      onClick={() =>
                        void collect(request, options, request.mode === 'selection' ? selectedIds : undefined)
                      }
                    >
                      Retry
                    </Button>
                    {request.mode === 'selection' ? (
                      <Button icon="arrowLeft" onClick={() => setStep({ kind: 'tree' })}>
                        Back to tree
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {step.kind === 'list' ? (
                <>
                  {request.mode === 'selection' ? (
                    <div>
                      <Button size="sm" variant="ghost" icon="arrowLeft" onClick={() => setStep({ kind: 'tree' })}>
                        Back to tree
                      </Button>
                    </div>
                  ) : null}
                  {warnings.length ? (
                    <Notice tone="warn" title="Some content could not be included">
                      <ul style={{ margin: '4px 0 0', paddingLeft: '18px' }}>
                        {warnings.slice(0, 10).map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                        {warnings.length > 10 ? <li>…and {warnings.length - 10} more</li> : null}
                      </ul>
                    </Notice>
                  ) : null}
                  {pages.length === 0 ? (
                    <div class="card empty">No pages found that you can view.</div>
                  ) : (
                    <PageList
                      pages={pages}
                      excluded={excluded}
                      onChange={setExcluded}
                      tree={TREE_MODES.has(request.mode)}
                      disabled={starting}
                    />
                  )}
                </>
              ) : null}
            </main>

            <aside class="preview-side card" aria-label="PDF options">
              <div class="card-title">PDF options</div>
              <p class="card-desc">Defaults come from Settings.</p>
              <OptionsForm
                variant="preview"
                value={options}
                onChange={onOptionsChange}
                locked={locked}
              />
            </aside>
          </div>

          <div class="action-bar">
            <div class="action-bar-inner">
              {step.kind === 'tree' ? (
                <>
                  <span class="summary">{plural(selectedIds.length, 'item')} selected</span>
                  <span class="spacer" />
                  <Button
                    variant="primary"
                    disabled={selectedIds.length === 0}
                    onClick={() => void collect(request, options, selectedIds)}
                  >
                    Review selection
                  </Button>
                </>
              ) : (
                <>
                  <span class="summary">
                    {step.kind === 'list' ? `${plural(included.length, 'page')} selected` : ' '}
                  </span>
                  {step.kind === 'list' && (guard.level === 'warn' || guard.level === 'blocked') ? (
                    <Notice tone={guard.level === 'blocked' ? 'error' : 'warn'} compact>
                      {guard.message}
                    </Notice>
                  ) : null}
                  {step.kind === 'list' && guard.level === 'confirm' ? (
                    <>
                      <Notice tone="warn" compact>
                        {guard.message}
                      </Notice>
                      <label class="confirm-large">
                        <input
                          type="checkbox"
                          class="checkbox"
                          checked={confirmLarge}
                          onChange={(e) => setConfirmLarge((e.currentTarget as HTMLInputElement).checked)}
                        />
                        I understand this is a large export
                      </label>
                    </>
                  ) : null}
                  {startError ? (
                    <Notice tone="error" compact>
                      {startError}
                    </Notice>
                  ) : null}
                  <span class="spacer" />
                  <Button
                    variant="primary"
                    icon="download"
                    loading={starting}
                    disabled={!canExport}
                    onClick={() => void startExport()}
                  >
                    {options.separateFiles ? 'Export ZIP' : 'Export PDF'}
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function PermissionCard({
  origin,
  denied,
  onGrant,
  label,
}: {
  origin: string;
  denied: boolean;
  onGrant: () => void;
  label: string;
}): JSX.Element {
  return (
    <div class="card permission-card">
      <div class="card-title">
        <Icon name="shield" /> Allow access to <span class="origin">{origin}</span>
      </div>
      <p class="card-desc">The extension needs permission to read this Confluence site to build your PDF.</p>
      <ul>
        <li>Read-only: it only loads pages you can already see, using your current login.</li>
        <li>Nothing leaves your browser. There is no server, no tracking and no analytics.</li>
        <li>You can remove access at any time in Settings.</li>
      </ul>
      {denied ? (
        <div style={{ marginBottom: '12px' }}>
          <Notice tone="warn" compact>
            Access was not granted. The export can’t continue without it.
          </Notice>
        </div>
      ) : null}
      <Button variant="primary" icon="check" onClick={onGrant}>
        {label}
      </Button>
    </div>
  );
}

function JobView({
  jobId,
  onExportAgain,
}: {
  jobId: string;
  onExportAgain: (req: ExportRequest) => void;
}): JSX.Element {
  const { job, missing, loading } = useJob(jobId, 2000);

  useEffect(() => {
    if (!job) return;
    const name = job.request.root.title || job.request.root.spaceKey || 'Confluence';
    if (isJobActive(job.status)) {
      const f = jobFraction(job);
      document.title = `${f === null ? '' : `${Math.round(f * 100)}% · `}Exporting ${name}`;
    } else {
      document.title = `${job.status === 'done' ? 'Done' : job.status === 'error' ? 'Failed' : 'Cancelled'} · ${name}`;
    }
  }, [job]);

  if (!job) {
    return (
      <div class="card job-card">
        {missing ? (
          <Notice tone="warn" title="Export not found">
            This export is no longer available (the browser may have been restarted). Start a new export from the
            toolbar button.
          </Notice>
        ) : loading ? (
          <div class="empty">
            <Spinner /> Loading export…
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div class="card job-card stack">
      <div>
        <div class="card-title">{job.request.root.title || job.request.root.spaceKey || 'Export'}</div>
        <div class="page-sub">
          {describeRequest(job.request)}
          {job.pages.length ? ` · ${plural(job.pages.length, 'page')}` : ''}
        </div>
      </div>
      {missing ? (
        <Notice tone="warn" compact>
          Lost contact with the export. It may have been interrupted.
        </Notice>
      ) : null}
      <JobProgress job={job} onExportAgain={() => onExportAgain(job.request)} />
      {isJobActive(job.status) ? (
        <p class="hint">Keep this tab open until the export finishes. Your PDF is saved to your Downloads.</p>
      ) : null}
    </div>
  );
}
