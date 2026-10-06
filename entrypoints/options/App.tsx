import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { Button } from '../../components/Button';
import { errorMessage, openShortcutsPage } from '../../components/hooks';
import { Icon, Spinner } from '../../components/Icon';
import { parseList, parseSiteInput } from '../../components/logic';
import { Notice, Toast } from '../../components/Notice';
import { NumberField } from '../../components/NumberField';
import { OptionsForm } from '../../components/OptionsForm';
import { Toggle } from '../../components/Toggle';
import { listGrantedOrigins, removeSiteAccess, requestSiteAccess } from '../../lib/permissions';
import { loadPolicy, loadSettings, loadUserSettings, onSettingsChanged, saveSettings } from '../../lib/settings';
import { DEFAULT_SETTINGS, type ExportOptions, type ManagedPolicy, type Settings } from '../../lib/types';

const COMMAND_NAME = 'export-current-page';

function sameSettings(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hasPolicy(p: ManagedPolicy): boolean {
  return !!(
    p.blockedSpaceKeys?.length ||
    p.disableLiveRender ||
    (p.defaultOptions && Object.keys(p.defaultOptions).length) ||
    (p.maxPages !== undefined && p.maxPages > 0)
  );
}

export function App(): JSX.Element {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [macrosText, setMacrosText] = useState('');
  const [policy, setPolicy] = useState<ManagedPolicy>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const adopt = useCallback((s: Settings) => {
    setSaved(s);
    setForm(s);
    setMacrosText(s.liveRenderMacros.join('\n'));
  }, []);

  useEffect(() => {
    Promise.all([loadSettings(), loadPolicy().catch(() => ({}) as ManagedPolicy)])
      .then(([s, p]) => {
        adopt(s);
        setPolicy(p);
      })
      .catch((e) => setLoadError(errorMessage(e)));
  }, [adopt]);

  const candidate = useMemo<Settings | null>(
    () => (form ? { ...form, liveRenderMacros: parseList(macrosText) } : null),
    [form, macrosText],
  );
  const dirty = !!(candidate && saved && !sameSettings(candidate, saved));

  // Pick up changes saved elsewhere (another options tab) unless the user is editing.
  useEffect(() => {
    if (!saved) return;
    return onSettingsChanged((s) => {
      if (!dirty) adopt(s);
    });
  }, [saved, dirty, adopt]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const locked = useMemo(() => {
    const s = new Set<keyof ExportOptions>();
    for (const k of Object.keys(policy.defaultOptions ?? {}) as (keyof ExportOptions)[]) {
      if (policy.defaultOptions?.[k] !== undefined) s.add(k);
    }
    if (policy.disableLiveRender) s.add('liveRender');
    return s;
  }, [policy]);

  const thresholdsInvalid = !!form && form.confirmPageCount < form.warnPageCount;

  const save = async () => {
    if (!candidate || thresholdsInvalid) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Locked fields show the enforced value; store the user's own value for them so nothing
      // policy-derived sticks if the policy is lifted later.
      const user = await loadUserSettings();
      const defaults = { ...candidate.defaults };
      for (const k of locked) (defaults as Record<string, unknown>)[k] = user.defaults[k];
      await saveSettings({ ...candidate, defaults });
      const fresh = await loadSettings();
      adopt(fresh);
      setToast('Settings saved');
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Reset all settings to their defaults? Site access is not affected.')) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveSettings(structuredClone(DEFAULT_SETTINGS));
      adopt(await loadSettings());
      setToast('Defaults restored');
    } catch (e) {
      setSaveError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof Settings>(key: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [key]: v } : f));
  const clearToast = useCallback(() => setToast(null), []);

  return (
    <div class="page-shell options-page">
      <header class="app-header">
        <span class="brand-mark" aria-hidden="true">
          <Icon name="pdf" size={16} />
        </span>
        <div>
          <h1>Settings</h1>
          <div class="page-sub">Fast PDF Export for Confluence</div>
        </div>
      </header>

      {loadError ? (
        <Notice tone="error" title="Could not load settings">
          {loadError}
        </Notice>
      ) : null}

      {hasPolicy(policy) ? (
        <div class="card">
          <Notice tone="info" icon="lock" title="Some settings are managed by your organization">
            Locked options can’t be changed here.
            {policy.maxPages ? ` Exports are limited to ${policy.maxPages.toLocaleString()} pages.` : ''}
            {policy.blockedSpaceKeys?.length ? ` Export is disabled for spaces: ${policy.blockedSpaceKeys.join(', ')}.` : ''}
            {policy.disableLiveRender ? ' Live render is disabled.' : ''}
          </Notice>
        </div>
      ) : null}

      <SiteAccess />

      {!form ? (
        loadError ? null : (
          <div class="card empty">
            <Spinner /> Loading settings…
          </div>
        )
      ) : (
        <>
          <section class="card" aria-labelledby="defaults-title">
            <h2 id="defaults-title" class="card-title">
              PDF defaults
            </h2>
            <p class="card-desc">Used for every new export. You can still change them per export in the preview.</p>
            <OptionsForm
              variant="settings"
              value={form.defaults}
              locked={locked}
              onChange={(d) => set('defaults', d)}
            />
            <div class="field" style={{ marginTop: '16px' }}>
              <label class="field-label" for="custom-css">
                Custom CSS (advanced)
              </label>
              <textarea
                id="custom-css"
                class="textarea mono"
                rows={6}
                spellcheck={false}
                disabled={locked.has('customCss')}
                placeholder={'.cf-cover h1 { color: #0b5cad; }\n.cf-page h1 { font-size: 22pt; }'}
                value={form.defaults.customCss}
                aria-describedby="custom-css-hint"
                onInput={(e) => set('defaults', { ...form.defaults, customCss: (e.currentTarget as HTMLTextAreaElement).value })}
              />
              <div class="field-hint" id="custom-css-hint">
                Added after the built-in print stylesheet, e.g. for company branding. Useful selectors:{' '}
                <code>.cf-cover</code>, <code>.cf-toc</code>, <code>.cf-page</code>, <code>.cf-page-meta</code>. Remote
                resources (fonts, images) are not loaded.
              </div>
            </div>
          </section>

          <section class="card" aria-labelledby="perf-title">
            <h2 id="perf-title" class="card-title">
              Performance &amp; limits
            </h2>
            <p class="card-desc">Lower the numbers if Confluence starts throttling requests.</p>
            <div class="grid-2">
              <NumberField
                label="Parallel API requests"
                value={form.apiConcurrency}
                min={1}
                max={10}
                hint="1–10 (default 5)"
                onChange={(v) => set('apiConcurrency', v)}
              />
              <NumberField
                label="Parallel live-render tabs"
                value={form.liveRenderConcurrency}
                min={1}
                max={5}
                hint="1–5 (default 3)"
                disabled={!!policy.disableLiveRender}
                onChange={(v) => set('liveRenderConcurrency', v)}
              />
              <NumberField
                label="Pages per print batch"
                value={form.printBatchSize}
                min={10}
                max={1000}
                hint="Splits very large exports to limit memory"
                onChange={(v) => set('printBatchSize', v)}
              />
              <NumberField
                label="Warn above"
                value={form.warnPageCount}
                min={1}
                max={100000}
                suffix="pages"
                onChange={(v) => set('warnPageCount', v)}
              />
              <NumberField
                label="Ask to confirm above"
                value={form.confirmPageCount}
                min={1}
                max={100000}
                suffix="pages"
                onChange={(v) => set('confirmPageCount', v)}
              />
            </div>
            {thresholdsInvalid ? (
              <div style={{ marginTop: '10px' }}>
                <Notice tone="error" compact>
                  The confirmation threshold must be at least the warning threshold.
                </Notice>
              </div>
            ) : null}
          </section>

          <section class="card" aria-labelledby="live-title">
            <h2 id="live-title" class="card-title">
              Live render
            </h2>
            <p class="card-desc">
              Pages containing these macros are printed from the real Confluence page when “Live render” is on, so
              diagrams and charts drawn in the browser appear in the PDF.
            </p>
            <div class="field">
              <label class="field-label" for="macros">
                Macro names (one per line or comma separated)
              </label>
              <textarea
                id="macros"
                class="textarea mono"
                rows={5}
                spellcheck={false}
                disabled={!!policy.disableLiveRender}
                value={macrosText}
                onInput={(e) => setMacrosText((e.currentTarget as HTMLTextAreaElement).value)}
                onBlur={() => setMacrosText(parseList(macrosText).join('\n'))}
              />
              <div class="field-hint">
                Matched case-insensitively against macro names and markers in the page source.{' '}
                {parseList(macrosText).length === 0 ? 'With an empty list, no page is live-rendered.' : ''}
              </div>
            </div>
          </section>

          <section class="card" aria-labelledby="notify-title">
            <h2 id="notify-title" class="card-title">
              Notifications
            </h2>
            <Toggle
              label="Notify me when an export finishes"
              description="Shows a system notification with the file name."
              checked={form.notifyOnComplete}
              onChange={(v) => set('notifyOnComplete', v)}
            />
          </section>

          <div class="save-bar">
            <Button variant="primary" icon="check" loading={saving} disabled={!dirty || thresholdsInvalid} onClick={() => void save()}>
              Save
            </Button>
            <Button variant="secondary" disabled={!dirty || saving} onClick={() => saved && adopt(saved)}>
              Discard changes
            </Button>
            <span class="spacer" />
            {saveError ? (
              <Notice tone="error" compact>
                {saveError}
              </Notice>
            ) : dirty ? (
              <span class="muted">Unsaved changes</span>
            ) : null}
            <Button variant="ghost" disabled={saving} onClick={() => void reset()}>
              Reset to defaults
            </Button>
          </div>
        </>
      )}

      <About />
      <Toast message={toast} onDone={clearToast} />
    </div>
  );
}

function SiteAccess(): JSX.Element {
  const [origins, setOrigins] = useState<string[] | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listGrantedOrigins().then(
      (o) => setOrigins([...o].sort()),
      (e) => setError(errorMessage(e)),
    );
  }, []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    chrome.permissions.onAdded.addListener(onChange);
    chrome.permissions.onRemoved.addListener(onChange);
    return () => {
      chrome.permissions.onAdded.removeListener(onChange);
      chrome.permissions.onRemoved.removeListener(onChange);
    };
  }, [refresh]);

  const add = (e?: Event) => {
    e?.preventDefault();
    setError(null);
    const parsed = parseSiteInput(input);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    const { origin } = parsed;
    setAdding(true);
    // No awaits before this call: it must run within the click's user gesture.
    requestSiteAccess(origin)
      .then((granted) => {
        if (granted) {
          setInput('');
          refresh();
        } else {
          setError(`Access to ${origin} was not granted.`);
        }
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setAdding(false));
  };

  const remove = (origin: string) => {
    setError(null);
    setRemoving(origin);
    removeSiteAccess(origin)
      .then((ok) => {
        if (!ok) setError(`Access to ${origin} can’t be removed (it is required by this build or by policy).`);
        refresh();
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setRemoving(null));
  };

  return (
    <section class="card" aria-labelledby="sites-title">
      <h2 id="sites-title" class="card-title">
        Site access
      </h2>
      <p class="card-desc">
        Confluence sites the extension may read. Access is requested the first time you export from a site; it is
        read-only and uses your existing login. Works with Confluence Cloud (including custom domains) and Data Center.
      </p>
      {origins === null ? (
        <div class="empty">
          <Spinner /> Loading…
        </div>
      ) : origins.length === 0 ? (
        <p class="muted" style={{ margin: '0 0 12px' }}>
          No sites yet.
        </p>
      ) : (
        <ul class="site-list" aria-label="Sites with access">
          {origins.map((o) => (
            <li key={o}>
              <Icon name="shield" size={14} class="row-icon" />
              <span class="origin">{o}</span>
              <Button size="sm" variant="danger" icon="trash" loading={removing === o} onClick={() => remove(o)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form class="add-site" onSubmit={add}>
        <input
          class={`input${error ? ' is-invalid' : ''}`}
          type="text"
          inputMode="url"
          autocomplete="off"
          spellcheck={false}
          placeholder="your-company.atlassian.net or https://wiki.example.com"
          aria-label="Confluence site address"
          aria-invalid={!!error}
          aria-describedby={error ? 'add-site-error' : undefined}
          value={input}
          onInput={(e) => {
            setInput((e.currentTarget as HTMLInputElement).value);
            setError(null);
          }}
        />
        <Button type="submit" variant="secondary" icon="plus" loading={adding}>
          Add site
        </Button>
      </form>
      {error ? (
        <div id="add-site-error" style={{ marginTop: '8px' }}>
          <Notice tone="error" compact>
            {error}
          </Notice>
        </div>
      ) : null}
    </section>
  );
}

function About(): JSX.Element {
  const [shortcut, setShortcut] = useState<string | null>(null);
  const version = chrome.runtime.getManifest().version;

  useEffect(() => {
    chrome.commands
      .getAll()
      .then((cmds) => setShortcut(cmds.find((c) => c.name === COMMAND_NAME)?.shortcut || ''))
      .catch(() => setShortcut(''));
  }, []);

  return (
    <section class="card about" aria-labelledby="about-title" style={{ marginTop: '16px' }}>
      <h2 id="about-title" class="card-title">
        About
      </h2>
      <p>Version {version}</p>
      <p>
        <Icon name="shield" size={14} /> Runs entirely in your browser. No data is sent anywhere except your Confluence
        site. The extension only reads from Confluence and never changes anything there.
      </p>
      <p>
        <Icon name="keyboard" size={14} /> Keyboard shortcut for exporting the current page:{' '}
        {shortcut ? <kbd>{shortcut}</kbd> : shortcut === '' ? <span>not set</span> : null}.{' '}
        <button type="button" class="link-btn" onClick={() => void openShortcutsPage()}>
          Change shortcut
        </button>
      </p>
    </section>
  );
}
