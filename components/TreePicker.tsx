import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ContentType, TreeNode } from '../lib/types';
import { Button } from './Button';
import { errorMessage } from './hooks';
import { Icon, Spinner } from './Icon';
import {
  addChildren,
  clearChecked,
  computeCheckStates,
  emptyTree,
  isLinkOnlyType,
  plural,
  selectAllLoaded,
  selectedInTreeOrder,
  toggleNode,
  visibleRows,
  type TreeModel,
} from './logic';
import { TYPE_ICON, TypeBadges } from './PageList';
import { Checkbox } from './Toggle';

const ROOT = '\u0000root';

export interface TreePickerProps {
  /** parent omitted = space roots. */
  loadChildren: (parent?: { id: string; type: ContentType }) => Promise<TreeNode[]>;
  /** Ids checked as soon as they are loaded (e.g. the page the user started from). */
  preselect?: readonly string[];
  /** Called with checked ids in page-tree order. */
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
}

/** FR-6: lazily loaded space tree with tri-state checkboxes and full keyboard support. */
export function TreePicker({ loadChildren, preselect, onSelectionChange, disabled }: TreePickerProps): JSX.Element {
  const [model, setModel] = useState<TreeModel>(emptyTree);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set([ROOT]));
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const treeRef = useRef<HTMLUListElement>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  // Props read through refs so callers need not memoize them (the root loads once).
  const loadRef = useRef(loadChildren);
  loadRef.current = loadChildren;
  const preselectRef = useRef<ReadonlySet<string>>(new Set());
  preselectRef.current = new Set(preselect ?? []);
  const selectionCb = useRef(onSelectionChange);
  selectionCb.current = onSelectionChange;

  const load = useCallback(
    async (parentId: string | null) => {
      const key = parentId ?? ROOT;
      setLoading((s) => new Set(s).add(key));
      setErrors((m) => {
        const n = new Map(m);
        n.delete(key);
        return n;
      });
      try {
        const entry = parentId ? modelRef.current.nodes[parentId] : undefined;
        const kids = await loadRef.current(entry ? { id: entry.node.id, type: entry.node.type } : undefined);
        setModel((m) => addChildren(m, parentId, kids, preselectRef.current));
        if (parentId) setExpanded((s) => new Set(s).add(parentId));
      } catch (e) {
        setErrors((m) => new Map(m).set(key, errorMessage(e)));
      } finally {
        setLoading((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const states = useMemo(() => computeCheckStates(model), [model]);
  const rows = useMemo(() => visibleRows(model, expanded), [model, expanded]);
  // Preselected ids (e.g. the page the user started from) are usually deeper than the space
  // roots loaded first: until their level is loaded (then addChildren checks them) or the user
  // clears the selection, they still count as selected instead of being silently dropped.
  const [pendingPreselect, setPendingPreselect] = useState<string[]>(() => [...new Set(preselect ?? [])]);
  const selectedIds = useMemo(() => {
    const loaded = selectedInTreeOrder(model);
    const waiting = pendingPreselect.filter((id) => !model.nodes[id] && !loaded.includes(id));
    return waiting.length ? [...loaded, ...waiting] : loaded;
  }, [model, pendingPreselect]);

  useEffect(() => {
    selectionCb.current(selectedIds);
  }, [selectedIds]);

  // Keep a valid roving-focus target.
  const activeId = focusId && model.nodes[focusId] && rows.some((r) => r.id === focusId) ? focusId : rows[0]?.id ?? null;

  useEffect(() => {
    if (!focusId) return;
    const el = rowRefs.current.get(focusId);
    if (el && treeRef.current?.contains(document.activeElement) && document.activeElement !== el) el.focus();
  }, [focusId]);

  const toggleExpand = (id: string) => {
    const entry = model.nodes[id];
    if (!entry || !entry.node.hasChildren) return;
    if (expanded.has(id)) {
      setExpanded((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    } else if (entry.childIds === null) {
      if (!loading.has(id)) void load(id);
    } else {
      setExpanded((s) => new Set(s).add(id));
    }
  };

  const check = (id: string) => {
    if (disabled) return;
    setModel((m) => toggleNode(m, id, computeCheckStates(m)));
  };

  const moveFocus = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    rowRefs.current.get(id)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, id: string) => {
    const idx = rows.findIndex((r) => r.id === id);
    const entry = model.nodes[id];
    if (!entry) return;
    switch (e.key) {
      case 'ArrowDown':
        moveFocus(rows[idx + 1]?.id);
        break;
      case 'ArrowUp':
        moveFocus(rows[idx - 1]?.id);
        break;
      case 'Home':
        moveFocus(rows[0]?.id);
        break;
      case 'End':
        moveFocus(rows[rows.length - 1]?.id);
        break;
      case 'ArrowRight':
        if (entry.node.hasChildren && !expanded.has(id)) toggleExpand(id);
        else if (expanded.has(id)) moveFocus(entry.childIds?.[0]);
        break;
      case 'ArrowLeft':
        if (expanded.has(id)) toggleExpand(id);
        else if (entry.parentId) moveFocus(entry.parentId);
        break;
      case ' ':
        check(id);
        break;
      case 'Enter':
        toggleExpand(id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const rootLoading = loading.has(ROOT);
  const rootError = errors.get(ROOT);

  return (
    <div class="tree-picker">
      <div class="list-toolbar">
        <span class="list-count" aria-live="polite">
          {plural(selectedIds.length, 'item')} selected
        </span>
        <div class="list-bulk">
          <Button size="sm" variant="ghost" disabled={disabled || rows.length === 0} onClick={() => setModel(selectAllLoaded)}>
            Select all loaded
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || selectedIds.length === 0}
            onClick={() => {
              setPendingPreselect([]);
              setModel(clearChecked);
            }}
          >
            Clear
          </Button>
        </div>
      </div>
      <p class="hint">
        Expand items to load their children. Checking an item also checks its loaded sub-pages. Use the arrow keys to
        move, <kbd>Space</kbd> to check and <kbd>Enter</kbd> to expand.
      </p>

      {rootLoading ? (
        <div class="empty">
          <Spinner /> Loading the space…
        </div>
      ) : rootError ? (
        <div class="empty error-text">
          Could not load the space: {rootError}{' '}
          <button type="button" class="link-btn" onClick={() => void load(null)}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div class="empty">This space has no pages you can view.</div>
      ) : (
        <ul class="tree" role="tree" aria-label="Pages in this space" aria-multiselectable="true" ref={treeRef}>
          {rows.map(({ id, level }) => {
            const entry = model.nodes[id]!;
            const { node } = entry;
            const state = states.get(id) ?? 'unchecked';
            const isOpen = expanded.has(id);
            const isLoading = loading.has(id);
            const err = errors.get(id);
            return (
              <li
                key={id}
                role="treeitem"
                aria-level={level}
                aria-expanded={node.hasChildren ? isOpen : undefined}
                aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
                aria-busy={isLoading || undefined}
                tabIndex={id === activeId ? 0 : -1}
                class={`tree-row${id === activeId ? ' is-focus' : ''}`}
                style={{ paddingInlineStart: `${4 + (level - 1) * 18}px` }}
                ref={(el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusId(id);
                }}
                onKeyDown={(e) => {
                  if (e.target === e.currentTarget) onKeyDown(e, id);
                }}
              >
                <span class="tree-line">
                  {node.hasChildren ? (
                    <button
                      type="button"
                      class="twisty"
                      tabIndex={-1}
                      aria-hidden="true"
                      onClick={() => {
                        setFocusId(id);
                        toggleExpand(id);
                      }}
                    >
                      {isLoading ? <Spinner size={12} /> : <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} />}
                    </button>
                  ) : (
                    <span class="twisty-spacer" />
                  )}
                  <Checkbox
                    checked={state === 'checked'}
                    indeterminate={state === 'indeterminate'}
                    label={node.title}
                    disabled={disabled}
                    tabIndex={-1}
                    onChange={() => {
                      setFocusId(id);
                      check(id);
                    }}
                  />
                  <Icon name={TYPE_ICON[node.type]} class="row-icon" />
                  <span
                    class={`tree-title${isLinkOnlyType(node.type) ? ' muted' : ''}`}
                    onClick={() => {
                      setFocusId(id);
                      check(id);
                    }}
                  >
                    {node.title || 'Untitled'}
                  </span>
                  <TypeBadges type={node.type} />
                </span>
                {err ? (
                  <span class="tree-error">
                    {err}{' '}
                    <button type="button" class="link-btn" onClick={() => void load(id)}>
                      Retry
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
