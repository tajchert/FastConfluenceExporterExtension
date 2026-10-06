import { describe, expect, it } from 'vitest';
import {
  addChildren,
  branchEnd,
  clampInt,
  clearChecked,
  computeCheckStates,
  emptyTree,
  isRestrictedUrl,
  jobFraction,
  largeExportGuard,
  marginPresetOf,
  parseList,
  parseSiteInput,
  selectAllLoaded,
  selectedInTreeOrder,
  setChecked,
  statusLabel,
  toggleNode,
  visibleRows,
} from '../../components/logic';
import type { TreeNode } from '../../lib/types';

const node = (id: string, hasChildren = false, type: TreeNode['type'] = 'page'): TreeNode => ({
  id,
  type,
  title: `T${id}`,
  hasChildren,
  url: `https://x.example/wiki/pages/${id}`,
});

describe('parseSiteInput', () => {
  it('accepts bare hosts and full URLs', () => {
    expect(parseSiteInput('acme.atlassian.net')).toEqual({ origin: 'https://acme.atlassian.net' });
    expect(parseSiteInput(' https://wiki.acme.corp/confluence/display/X ')).toEqual({ origin: 'https://wiki.acme.corp' });
    expect(parseSiteInput('http://localhost:8090/')).toEqual({ origin: 'http://localhost:8090' });
  });
  it('rejects empty, non-http and wildcard input', () => {
    expect(parseSiteInput('')).toHaveProperty('error');
    expect(parseSiteInput('ftp://x.example')).toHaveProperty('error');
    expect(parseSiteInput('https://*.atlassian.net')).toHaveProperty('error');
    expect(parseSiteInput('http://')).toHaveProperty('error');
  });
});

describe('small helpers', () => {
  it('parseList splits, trims, lower-cases and de-duplicates', () => {
    expect(parseList('drawio, Gliffy\n\n gliffy ;chart')).toEqual(['drawio', 'gliffy', 'chart']);
    expect(parseList('  ')).toEqual([]);
  });
  it('clampInt clamps and falls back', () => {
    expect(clampInt('7', 1, 5, 3)).toBe(5);
    expect(clampInt('', 1, 5, 3)).toBe(3);
    expect(clampInt(-2, 0, 5, 3)).toBe(0);
    expect(clampInt('2.6', 1, 5, 3)).toBe(2);
  });
  it('marginPresetOf recognises presets', () => {
    expect(marginPresetOf({ top: 18, right: 15, bottom: 18, left: 15 })).toBe('normal');
    expect(marginPresetOf({ top: 10, right: 10, bottom: 10, left: 10 })).toBe('narrow');
    expect(marginPresetOf({ top: 10, right: 11, bottom: 10, left: 10 })).toBe('custom');
  });
  it('isRestrictedUrl', () => {
    expect(isRestrictedUrl('chrome://extensions')).toBe(true);
    expect(isRestrictedUrl('edge://settings')).toBe(true);
    expect(isRestrictedUrl('https://chromewebstore.google.com/detail/x')).toBe(true);
    expect(isRestrictedUrl('https://chrome.google.com/webstore/category')).toBe(true);
    expect(isRestrictedUrl('https://acme.atlassian.net/wiki/spaces/X')).toBe(false);
    expect(isRestrictedUrl(undefined)).toBe(false);
  });
  it('job progress helpers', () => {
    expect(jobFraction({ status: 'fetching', progress: { done: 5, total: 10 } })).toBe(0.5);
    expect(jobFraction({ status: 'collecting', progress: { done: 0, total: 0 } })).toBeNull();
    expect(jobFraction({ status: 'done', progress: { done: 0, total: 0 } })).toBe(1);
    expect(statusLabel({ status: 'rendering' })).toMatch(/Rendering/);
    expect(statusLabel({ status: 'rendering', message: 'Custom' })).toBe('Custom');
  });
});

describe('largeExportGuard (FR-16)', () => {
  const limits = { warn: 150, confirm: 500 };
  it('levels', () => {
    expect(largeExportGuard(0, limits).level).toBe('empty');
    expect(largeExportGuard(150, limits).level).toBe('none');
    expect(largeExportGuard(151, limits).level).toBe('warn');
    expect(largeExportGuard(500, limits).level).toBe('warn');
    expect(largeExportGuard(501, limits).level).toBe('confirm');
  });
  it('policy maximum blocks', () => {
    expect(largeExportGuard(101, { ...limits, max: 100 }).level).toBe('blocked');
    expect(largeExportGuard(100, { ...limits, max: 100 }).level).toBe('none');
  });
});

describe('branchEnd', () => {
  it('finds the contiguous descendants in DFS order', () => {
    const pages = [{ depth: 0 }, { depth: 1 }, { depth: 2 }, { depth: 1 }, { depth: 0 }];
    expect(branchEnd(pages, 0)).toBe(4);
    expect(branchEnd(pages, 1)).toBe(3);
    expect(branchEnd(pages, 2)).toBe(3);
    expect(branchEnd(pages, 4)).toBe(5);
  });
});

describe('tree selection model (FR-6)', () => {
  const build = () => {
    let m = addChildren(emptyTree(), null, [node('a', true), node('b'), node('c', true)]);
    m = addChildren(m, 'a', [node('a1'), node('a2', true)]);
    m = addChildren(m, 'a2', [node('a2x')]);
    return m;
  };

  it('checking a parent checks its loaded descendants', () => {
    const m = setChecked(build(), 'a', true);
    expect(selectedInTreeOrder(m)).toEqual(['a', 'a1', 'a2', 'a2x']);
    const s = computeCheckStates(m);
    expect(s.get('a')).toBe('checked');
    expect(s.get('b')).toBe('unchecked');
    // 'c' has unloaded children: it is a leaf as far as the model knows.
    expect(s.get('c')).toBe('unchecked');
  });

  it('partial selection makes ancestors indeterminate', () => {
    const m = setChecked(build(), 'a2x', true);
    const s = computeCheckStates(m);
    expect(s.get('a2x')).toBe('checked');
    expect(s.get('a2')).toBe('indeterminate');
    expect(s.get('a')).toBe('indeterminate');
  });

  it('toggle: indeterminate → all checked → all unchecked', () => {
    let m = setChecked(build(), 'a1', true);
    m = toggleNode(m, 'a', computeCheckStates(m));
    expect(computeCheckStates(m).get('a')).toBe('checked');
    m = toggleNode(m, 'a', computeCheckStates(m));
    expect(selectedInTreeOrder(m)).toEqual([]);
  });

  it('children loaded under a checked parent inherit the check; preselect works', () => {
    let m = addChildren(emptyTree(), null, [node('r', true), node('s', true)], new Set(['s']));
    m = setChecked(m, 'r', true);
    m = addChildren(m, 'r', [node('r1'), node('r2')]);
    m = addChildren(m, 's', [node('s1')]);
    expect(selectedInTreeOrder(m)).toEqual(['r', 'r1', 'r2', 's', 's1']);
    expect(computeCheckStates(m).get('s')).toBe('checked');
  });

  it('selection order is tree order regardless of click order', () => {
    let m = build();
    m = setChecked(m, 'b', true);
    m = setChecked(m, 'a2x', true);
    m = setChecked(m, 'a1', true);
    expect(selectedInTreeOrder(m)).toEqual(['a1', 'a2x', 'b']);
  });

  it('select all loaded / clear', () => {
    const m = selectAllLoaded(build());
    expect(selectedInTreeOrder(m)).toEqual(['a', 'a1', 'a2', 'a2x', 'b', 'c']);
    expect(selectedInTreeOrder(clearChecked(m))).toEqual([]);
  });

  it('ignores duplicate ids from the API', () => {
    let m = addChildren(emptyTree(), null, [node('a', true), node('a')]);
    m = addChildren(m, 'a', [node('a'), node('z')]);
    expect(m.rootIds).toEqual(['a']);
    expect(m.nodes.a!.childIds).toEqual(['z']);
  });

  it('visibleRows follows expansion', () => {
    const m = build();
    expect(visibleRows(m, new Set()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(visibleRows(m, new Set(['a', 'a2']))).toEqual([
      { id: 'a', level: 1 },
      { id: 'a1', level: 2 },
      { id: 'a2', level: 2 },
      { id: 'a2x', level: 3 },
      { id: 'b', level: 1 },
      { id: 'c', level: 1 },
    ]);
  });
});
