import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageList } from '../../components/PageList';
import { TreePicker } from '../../components/TreePicker';
import { OptionsForm } from '../../components/OptionsForm';
import { DEFAULT_OPTIONS, type PageRef, type TreeNode } from '../../lib/types';

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

const flush = () => act(async () => new Promise<void>((r) => setTimeout(r, 0)));

const tn = (id: string, hasChildren = false): TreeNode => ({ id, type: 'page', title: `Page ${id}`, hasChildren, url: `https://x/${id}` });

describe('TreePicker', () => {
  it('loads roots, expands lazily and reports the selection in tree order', async () => {
    const loadChildren = vi.fn(async (parent?: { id: string }) =>
      parent ? [tn(`${parent.id}.1`), tn(`${parent.id}.2`)] : [tn('A', true), tn('B')],
    );
    const onSel = vi.fn();
    await act(async () => {
      render(h(TreePicker, { loadChildren, onSelectionChange: onSel, preselect: ['B'] }), root);
    });
    await flush();
    expect(loadChildren).toHaveBeenCalledTimes(1);
    const items = () => [...root.querySelectorAll('[role="treeitem"]')];
    expect(items()).toHaveLength(2);
    expect(onSel).toHaveBeenLastCalledWith(['B']);

    // Expand A with the keyboard.
    const a = items()[0] as HTMLElement;
    await act(async () => {
      a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();
    expect(loadChildren).toHaveBeenLastCalledWith({ id: 'A', type: 'page' });
    expect(items().map((el) => el.textContent)).toEqual(['Page A', 'Page A.1', 'Page A.2', 'Page B']);

    // Space on A checks A and its loaded children.
    await act(async () => {
      (items()[0] as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(onSel).toHaveBeenLastCalledWith(['A', 'A.1', 'A.2', 'B']);
    expect(items()[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a preselected id that is not loaded yet (deep page) until its level loads or Clear', async () => {
    const loadChildren = vi.fn(async (parent?: { id: string }) =>
      parent ? [tn('A.1'), tn('A.2')] : [tn('A', true), tn('B')],
    );
    const onSel = vi.fn();
    await act(async () => {
      render(h(TreePicker, { loadChildren, onSelectionChange: onSel, preselect: ['A.2'] }), root);
    });
    await flush();
    // Only the roots are loaded, but the page the user started from is still selected.
    expect(onSel).toHaveBeenLastCalledWith(['A.2']);
    expect(root.textContent).toContain('1 item selected');

    // Loading its level shows it checked, in tree order with the rest of the selection.
    const items = () => [...root.querySelectorAll('[role="treeitem"]')];
    await act(async () => {
      items()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await flush();
    expect(items().map((el) => [el.textContent, el.getAttribute('aria-checked')])).toEqual([
      ['Page A', 'mixed'],
      ['Page A.1', 'false'],
      ['Page A.2', 'true'],
      ['Page B', 'false'],
    ]);
    expect(onSel).toHaveBeenLastCalledWith(['A.2']);

    // Clear drops it.
    const clear = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!;
    await act(async () => clear.click());
    expect(onSel).toHaveBeenLastCalledWith([]);
  });

  it('Clear also drops preselected ids that were never loaded', async () => {
    const loadChildren = vi.fn(async () => [tn('A', true)]);
    const onSel = vi.fn();
    await act(async () => {
      render(h(TreePicker, { loadChildren, onSelectionChange: onSel, preselect: ['deep'] }), root);
    });
    await flush();
    expect(onSel).toHaveBeenLastCalledWith(['deep']);
    const clear = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Clear')!;
    await act(async () => clear.click());
    expect(onSel).toHaveBeenLastCalledWith([]);
  });

  it('shows a retryable error when the space cannot be loaded', async () => {
    const loadChildren = vi.fn().mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue([tn('A')]);
    await act(async () => {
      render(h(TreePicker, { loadChildren, onSelectionChange: () => undefined }), root);
    });
    await flush();
    expect(root.textContent).toContain('HTTP 500');
    const retry = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!;
    await act(async () => retry.click());
    await flush();
    expect(root.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
  });
});

describe('PageList', () => {
  const page = (id: string, depth: number, over: Partial<PageRef> = {}): PageRef => ({
    id,
    type: 'page',
    title: `Title ${id}`,
    depth,
    url: `https://x/${id}`,
    reason: depth ? 'descendant' : 'root',
    ...over,
  });

  it('toggles single pages and whole branches', async () => {
    const pages = [page('1', 0), page('2', 1), page('3', 2), page('4', 1, { type: 'whiteboard' })];
    let excluded = new Set<string>();
    const onChange = vi.fn((s: Set<string>) => {
      excluded = s;
      rerender();
    });
    const rerender = () => render(h(PageList, { pages, excluded, onChange, tree: true }), root);
    await act(async () => rerender());
    expect(root.textContent).toContain('4 of 4 items selected');
    expect(root.textContent).toContain('link only');

    const branchBtn = root.querySelector('button[aria-label^="Exclude “Title 2”"]') as HTMLButtonElement;
    expect(branchBtn).toBeTruthy();
    await act(async () => branchBtn.click());
    expect([...excluded].sort()).toEqual(['2', '3']);
    expect(root.textContent).toContain('2 of 4 items selected');

    const boxes = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      boxes[0]!.checked = false;
      boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(excluded.has('1')).toBe(true);
  });
});

describe('OptionsForm', () => {
  it('disables cover/TOC when separate files is on and respects locks', async () => {
    const onChange = vi.fn();
    await act(async () => {
      render(
        h(OptionsForm, {
          variant: 'preview',
          value: { ...DEFAULT_OPTIONS, separateFiles: true },
          onChange,
          locked: new Set(['liveRender'] as const),
        }),
        root,
      );
    });
    const byLabel = (text: string) => {
      const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.startsWith(text))!;
      return root.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
    };
    expect(byLabel('Cover page').disabled).toBe(true);
    expect(byLabel('Live render').disabled).toBe(true);
    expect(byLabel('Page numbers').disabled).toBe(false);
    await act(async () => byLabel('Page numbers').click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ pageNumbers: false }));
  });
});
