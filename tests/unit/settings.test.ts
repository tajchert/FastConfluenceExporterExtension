import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  applyPolicy,
  loadPolicy,
  loadSettings,
  loadUserSettings,
  normalizeOptions,
  normalizePolicy,
  normalizeSettings,
  onSettingsChanged,
  saveSettings,
} from '../../lib/settings';
import { DEFAULT_OPTIONS, DEFAULT_SETTINGS, type Settings } from '../../lib/types';

beforeEach(() => {
  fakeBrowser.reset();
});

describe('normalizeSettings', () => {
  it('returns defaults for garbage', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
  });

  it('deep-merges defaults and margins', () => {
    const s = normalizeSettings({ apiConcurrency: 3, defaults: { paperSize: 'Letter', marginsMm: { top: 5 } } });
    expect(s.apiConcurrency).toBe(3);
    expect(s.defaults.paperSize).toBe('Letter');
    expect(s.defaults.marginsMm).toEqual({ ...DEFAULT_OPTIONS.marginsMm, top: 5 });
    expect(s.defaults.includeCover).toBe(DEFAULT_OPTIONS.includeCover);
    expect(s.liveRenderMacros).toEqual(DEFAULT_SETTINGS.liveRenderMacros);
  });

  it('rejects invalid values and clamps numbers', () => {
    const s = normalizeSettings({
      apiConcurrency: 500,
      liveRenderConcurrency: 0,
      printBatchSize: 'many',
      warnPageCount: 300,
      confirmPageCount: 100,
      notifyOnComplete: 'yes',
      liveRenderMacros: ['DrawIO', '', 3, 'drawio', ' gliffy '],
      defaults: { paperSize: 'B5', orientation: 'sideways', marginsMm: { left: -4, right: 'x' }, pageNumbers: 0 },
    });
    expect(s.apiConcurrency).toBe(10);
    expect(s.liveRenderConcurrency).toBe(1);
    expect(s.printBatchSize).toBe(DEFAULT_SETTINGS.printBatchSize);
    expect(s.warnPageCount).toBe(300);
    expect(s.confirmPageCount).toBe(300); // never below the warning threshold
    expect(s.notifyOnComplete).toBe(DEFAULT_SETTINGS.notifyOnComplete);
    expect(s.liveRenderMacros).toEqual(['drawio', 'gliffy']);
    expect(s.defaults.paperSize).toBe('A4');
    expect(s.defaults.orientation).toBe('portrait');
    expect(s.defaults.marginsMm.left).toBe(0);
    expect(s.defaults.marginsMm.right).toBe(DEFAULT_OPTIONS.marginsMm.right);
    expect(s.defaults.pageNumbers).toBe(DEFAULT_OPTIONS.pageNumbers);
    // One print must stay far below Chrome's 5-minute limit for a single debugger call.
    expect(normalizeSettings({ printBatchSize: 2000 }).printBatchSize).toBe(400);
  });

  it('defaults to PDF with images on, and validates the output format', () => {
    expect(DEFAULT_OPTIONS.format).toBe('pdf');
    expect(DEFAULT_OPTIONS.downloadImages).toBe(true);
    // Settings stored before formats existed get the defaults.
    const old = normalizeSettings({ defaults: { paperSize: 'Letter', separateFiles: true } });
    expect(old.defaults).toMatchObject({ format: 'pdf', downloadImages: true, paperSize: 'Letter', separateFiles: true });
    expect(normalizeOptions({ format: 'markdown', downloadImages: false })).toMatchObject({ format: 'markdown', downloadImages: false });
    expect(normalizeOptions({ format: 'text' }).format).toBe('text');
    expect(normalizeOptions({ format: 'docx', downloadImages: 'yes' })).toMatchObject({ format: 'pdf', downloadImages: true });
    expect(normalizeOptions({ format: 'PDF' }, { ...DEFAULT_OPTIONS, format: 'text' }).format).toBe('text');
  });

  it('normalizeOptions keeps valid values', () => {
    const o = normalizeOptions({ ...DEFAULT_OPTIONS, orientation: 'landscape', customCss: 'h1{color:red}' });
    expect(o.orientation).toBe('landscape');
    expect(o.customCss).toBe('h1{color:red}');
  });
});

describe('policy', () => {
  it('normalizePolicy keeps only valid keys', () => {
    const p = normalizePolicy({
      blockedSpaceKeys: ['HR', 4, '', 'LEGAL'],
      disableLiveRender: true,
      maxPages: 250.7,
      defaultOptions: { paperSize: 'Letter', orientation: 'diagonal', includeCover: false, marginsMm: { top: 10, left: 'x' }, bogus: 1 },
      unknown: 'x',
    });
    expect(p).toEqual({
      blockedSpaceKeys: ['HR', 'LEGAL'],
      disableLiveRender: true,
      maxPages: 250,
      defaultOptions: { paperSize: 'Letter', includeCover: false, marginsMm: { top: 10 } },
    });
    expect(normalizePolicy({ maxPages: 0, blockedSpaceKeys: [] })).toEqual({});
  });

  it('normalizePolicy keeps a valid default format and downloadImages, drops invalid ones', () => {
    expect(normalizePolicy({ defaultOptions: { format: 'markdown', downloadImages: false } })).toEqual({
      defaultOptions: { format: 'markdown', downloadImages: false },
    });
    // Valid values equal to the defaults are kept too (they are still enforced).
    expect(normalizePolicy({ defaultOptions: { format: 'pdf', downloadImages: true } })).toEqual({
      defaultOptions: { format: 'pdf', downloadImages: true },
    });
    expect(normalizePolicy({ defaultOptions: { format: 'html', downloadImages: 1 } })).toEqual({});
  });

  it('applyPolicy enforces the default format', () => {
    const s = applyPolicy({ ...DEFAULT_SETTINGS, defaults: { ...DEFAULT_OPTIONS, format: 'pdf' } }, { defaultOptions: { format: 'text' } });
    expect(s.defaults.format).toBe('text');
  });

  it('applyPolicy overrides defaults and forces live render off', () => {
    const user: Settings = {
      ...DEFAULT_SETTINGS,
      defaults: { ...DEFAULT_OPTIONS, liveRender: true, marginsMm: { top: 1, right: 2, bottom: 3, left: 4 } },
    };
    const s = applyPolicy(user, {
      disableLiveRender: true,
      defaultOptions: { paperSize: 'Legal', marginsMm: { top: 20 } as Settings['defaults']['marginsMm'] },
    });
    expect(s.defaults.liveRender).toBe(false);
    expect(s.defaults.paperSize).toBe('Legal');
    expect(s.defaults.marginsMm).toEqual({ top: 20, right: 2, bottom: 3, left: 4 });
  });

  it('loadPolicy returns {} when managed storage throws', async () => {
    const spy = vi.spyOn(chrome.storage.managed, 'get').mockRejectedValue(new Error('Managed storage not available'));
    await expect(loadPolicy()).resolves.toEqual({});
    spy.mockRestore();
  });

  it('loadSettings applies the managed policy last', async () => {
    await chrome.storage.sync.set({ settings: { defaults: { paperSize: 'A3', liveRender: true } } });
    await chrome.storage.managed.set({ disableLiveRender: true, defaultOptions: { orientation: 'landscape' } });
    const s = await loadSettings();
    expect(s.defaults.paperSize).toBe('A3');
    expect(s.defaults.orientation).toBe('landscape');
    expect(s.defaults.liveRender).toBe(false);
    const user = await loadUserSettings();
    expect(user.defaults.liveRender).toBe(true);
  });
});

describe('save / load / change', () => {
  it('round-trips settings and stores custom CSS locally', async () => {
    const css = 'body{font-family:serif}'.repeat(1000); // > sync item quota
    const s: Settings = {
      ...DEFAULT_SETTINGS,
      apiConcurrency: 7,
      defaults: { ...DEFAULT_OPTIONS, orientation: 'landscape', customCss: css, format: 'markdown', downloadImages: false },
    };
    await saveSettings(s);
    const sync = (await chrome.storage.sync.get('settings')).settings as Settings;
    expect(sync.defaults.customCss).toBeUndefined();
    expect((await chrome.storage.local.get('customCss')).customCss).toBe(css);
    expect(await loadSettings()).toEqual(s);
  });

  it('notifies listeners on change and unsubscribes', async () => {
    const cb = vi.fn();
    const off = onSettingsChanged(cb);
    await saveSettings({ ...DEFAULT_SETTINGS, apiConcurrency: 2 });
    await vi.waitFor(() => expect(cb).toHaveBeenCalled());
    expect(cb.mock.calls.at(-1)![0].apiConcurrency).toBe(2);
    off();
    cb.mockClear();
    await saveSettings({ ...DEFAULT_SETTINGS, apiConcurrency: 4 });
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).not.toHaveBeenCalled();
  });
});
