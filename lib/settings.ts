/**
 * User settings (chrome.storage.sync) layered over DEFAULT_SETTINGS, with the enterprise policy
 * (chrome.storage.managed, see public/managed_schema.json) applied last.
 *
 * Storage layout:
 *  - sync  `settings`  : Settings without `defaults.customCss` (sync has an 8 KB per-item quota)
 *  - local `customCss` : the custom print CSS (can be large)
 *
 * Everything read from storage is validated field by field; unknown or malformed values fall back
 * to the defaults so a corrupted entry can never break an export.
 */
import {
  DEFAULT_OPTIONS,
  DEFAULT_SETTINGS,
  type ExportOptions,
  type ManagedPolicy,
  type Orientation,
  type PaperSize,
  type Settings,
} from './types';

const SYNC_KEY = 'settings';
const LOCAL_CSS_KEY = 'customCss';
/** Hard cap for custom CSS (characters). */
export const MAX_CUSTOM_CSS_LENGTH = 100_000;

const PAPER_SIZES: readonly PaperSize[] = ['A4', 'Letter', 'Legal', 'A3'];
const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape'];

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function num(v: unknown, fallback: number, min: number, max: number, integer = true): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const n = integer ? Math.round(v) : v;
  return Math.min(max, Math.max(min, n));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function stringList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Validate a (partial) ExportOptions object and fill gaps from `base`. */
export function normalizeOptions(raw: unknown, base: ExportOptions = DEFAULT_OPTIONS): ExportOptions {
  const r: Dict = isDict(raw) ? raw : {};
  const m: Dict = isDict(r.marginsMm) ? r.marginsMm : {};
  const css = typeof r.customCss === 'string' ? r.customCss : base.customCss;
  return {
    paperSize: oneOf(r.paperSize, PAPER_SIZES, base.paperSize),
    orientation: oneOf(r.orientation, ORIENTATIONS, base.orientation),
    marginsMm: {
      top: num(m.top, base.marginsMm.top, 0, 100, false),
      right: num(m.right, base.marginsMm.right, 0, 100, false),
      bottom: num(m.bottom, base.marginsMm.bottom, 0, 100, false),
      left: num(m.left, base.marginsMm.left, 0, 100, false),
    },
    includeCover: bool(r.includeCover, base.includeCover),
    includeToc: bool(r.includeToc, base.includeToc),
    includePageMeta: bool(r.includePageMeta, base.includePageMeta),
    includeComments: bool(r.includeComments, base.includeComments),
    pageNumbers: bool(r.pageNumbers, base.pageNumbers),
    liveRender: bool(r.liveRender, base.liveRender),
    separateFiles: bool(r.separateFiles, base.separateFiles),
    includeArchived: bool(r.includeArchived, base.includeArchived),
    shrinkWideTables: bool(r.shrinkWideTables, base.shrinkWideTables),
    customCss: css.length > MAX_CUSTOM_CSS_LENGTH ? css.slice(0, MAX_CUSTOM_CSS_LENGTH) : css,
  };
}

/** Validate a stored Settings object, deep-merging it over `base` (DEFAULT_SETTINGS). */
export function normalizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const r: Dict = isDict(raw) ? raw : {};
  const warnPageCount = num(r.warnPageCount, base.warnPageCount, 1, 100_000);
  return {
    defaults: normalizeOptions(r.defaults, base.defaults),
    apiConcurrency: num(r.apiConcurrency, base.apiConcurrency, 1, 10),
    liveRenderConcurrency: num(r.liveRenderConcurrency, base.liveRenderConcurrency, 1, 6),
    liveRenderMacros: [...new Set(stringList(r.liveRenderMacros, base.liveRenderMacros).map((s) => s.toLowerCase()))],
    printBatchSize: num(r.printBatchSize, base.printBatchSize, 10, 2000),
    warnPageCount,
    confirmPageCount: Math.max(warnPageCount, num(r.confirmPageCount, base.confirmPageCount, 1, 100_000)),
    notifyOnComplete: bool(r.notifyOnComplete, base.notifyOnComplete),
  };
}

/** Validate a managed policy object. Unknown keys are dropped. */
export function normalizePolicy(raw: unknown): ManagedPolicy {
  const r: Dict = isDict(raw) ? raw : {};
  const policy: ManagedPolicy = {};
  if (Array.isArray(r.blockedSpaceKeys)) {
    const keys = stringList(r.blockedSpaceKeys, []);
    if (keys.length) policy.blockedSpaceKeys = keys;
  }
  if (typeof r.disableLiveRender === 'boolean') policy.disableLiveRender = r.disableLiveRender;
  if (typeof r.maxPages === 'number' && Number.isFinite(r.maxPages) && r.maxPages >= 1) {
    policy.maxPages = Math.floor(r.maxPages);
  }
  if (isDict(r.defaultOptions)) {
    const partial = validPartialOptions(r.defaultOptions);
    if (Object.keys(partial).length) policy.defaultOptions = partial;
  }
  return policy;
}

/**
 * Keep only the keys of `raw` that hold valid values. A value is valid when normalizing it over
 * two bases that differ in every field yields the same result (i.e. the base was not used).
 */
function validPartialOptions(raw: Dict): Partial<ExportOptions> {
  const alt: ExportOptions = {
    paperSize: DEFAULT_OPTIONS.paperSize === 'A4' ? 'Letter' : 'A4',
    orientation: DEFAULT_OPTIONS.orientation === 'portrait' ? 'landscape' : 'portrait',
    marginsMm: { top: -1, right: -1, bottom: -1, left: -1 },
    includeCover: !DEFAULT_OPTIONS.includeCover,
    includeToc: !DEFAULT_OPTIONS.includeToc,
    includePageMeta: !DEFAULT_OPTIONS.includePageMeta,
    includeComments: !DEFAULT_OPTIONS.includeComments,
    pageNumbers: !DEFAULT_OPTIONS.pageNumbers,
    liveRender: !DEFAULT_OPTIONS.liveRender,
    separateFiles: !DEFAULT_OPTIONS.separateFiles,
    includeArchived: !DEFAULT_OPTIONS.includeArchived,
    shrinkWideTables: !DEFAULT_OPTIONS.shrinkWideTables,
    customCss: '\u0000',
  };
  const a = normalizeOptions(raw, DEFAULT_OPTIONS);
  const b = normalizeOptions(raw, alt);
  const out: Partial<ExportOptions> = {};
  const target = out as Record<string, unknown>;
  for (const key of Object.keys(a) as (keyof ExportOptions)[]) {
    if (!(key in raw)) continue;
    if (key === 'marginsMm') {
      const margins: Partial<ExportOptions['marginsMm']> = {};
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        if (a.marginsMm[side] === b.marginsMm[side]) margins[side] = a.marginsMm[side];
      }
      // Partial margins are merged over the user's margins in applyPolicy().
      if (Object.keys(margins).length) target.marginsMm = margins;
    } else if (a[key] === b[key]) {
      target[key] = a[key];
    }
  }
  return out;
}

/** Apply policy-enforced values to export options (used for defaults and for every request). */
export function applyPolicyToOptions(options: ExportOptions, policy: ManagedPolicy): ExportOptions {
  return policy.disableLiveRender ? { ...options, liveRender: false } : options;
}

/** Overlay the managed policy on settings: `defaultOptions` wins, `disableLiveRender` forces off. */
export function applyPolicy(settings: Settings, policy: ManagedPolicy): Settings {
  let defaults = settings.defaults;
  if (policy.defaultOptions) {
    defaults = normalizeOptions(
      {
        ...defaults,
        ...policy.defaultOptions,
        marginsMm: { ...defaults.marginsMm, ...(policy.defaultOptions.marginsMm ?? {}) },
      },
      defaults,
    );
  }
  return { ...settings, defaults: applyPolicyToOptions(defaults, policy) };
}

/** The enterprise policy. Returns {} when none is set (managed storage throws without a policy). */
export async function loadPolicy(): Promise<ManagedPolicy> {
  try {
    const managed = chrome.storage?.managed;
    if (!managed) return {};
    const raw = await managed.get(null);
    return normalizePolicy(raw);
  } catch {
    return {};
  }
}

/** User settings without the policy overlay (for the options page form). */
export async function loadUserSettings(): Promise<Settings> {
  let syncRaw: unknown;
  let css: unknown;
  try {
    syncRaw = (await chrome.storage.sync.get(SYNC_KEY))[SYNC_KEY];
  } catch {
    syncRaw = undefined;
  }
  try {
    css = (await chrome.storage.local.get(LOCAL_CSS_KEY))[LOCAL_CSS_KEY];
  } catch {
    css = undefined;
  }
  const settings = normalizeSettings(syncRaw);
  if (typeof css === 'string') settings.defaults = normalizeOptions({ ...settings.defaults, customCss: css }, settings.defaults);
  return settings;
}

/** DEFAULT_SETTINGS ⊕ storage.sync ⊕ managed policy. */
export async function loadSettings(): Promise<Settings> {
  const [user, policy] = await Promise.all([loadUserSettings(), loadPolicy()]);
  return applyPolicy(user, policy);
}

export async function saveSettings(s: Settings): Promise<void> {
  const normalized = normalizeSettings(s);
  const { customCss, ...defaultsWithoutCss } = normalized.defaults;
  const forSync = { ...normalized, defaults: defaultsWithoutCss };
  await chrome.storage.sync.set({ [SYNC_KEY]: forSync });
  await chrome.storage.local.set({ [LOCAL_CSS_KEY]: customCss });
}

/** Calls `cb` with freshly loaded settings whenever user settings or the policy change. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  let disposed = false;
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const relevant =
      (area === 'sync' && SYNC_KEY in changes) ||
      (area === 'local' && LOCAL_CSS_KEY in changes) ||
      area === 'managed';
    if (!relevant) return;
    loadSettings().then(
      (s) => {
        if (!disposed) cb(s);
      },
      () => undefined,
    );
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    disposed = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
