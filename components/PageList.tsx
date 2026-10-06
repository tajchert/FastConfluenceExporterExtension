import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { ContentType, PageRef } from '../lib/types';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { TYPE_LABEL, branchEnd, isLinkOnlyType, plural } from './logic';

export const TYPE_ICON: Record<ContentType, IconName> = {
  page: 'page',
  blogpost: 'blog',
  folder: 'folder',
  whiteboard: 'board',
  database: 'table',
  embed: 'link',
};

export function TypeBadges({ type }: { type: ContentType }): JSX.Element | null {
  if (type === 'folder') return <span class="badge badge-folder" title="Exported as a section heading">Folder</span>;
  if (type === 'blogpost') return <span class="badge">Blog post</span>;
  if (isLinkOnlyType(type)) {
    return (
      <span class="badge badge-linkonly" title="Included in the table of contents as a link only">
        {TYPE_LABEL[type]} · link only
      </span>
    );
  }
  return null;
}

export interface PageListProps {
  pages: readonly PageRef[];
  excluded: ReadonlySet<string>;
  onChange: (excluded: Set<string>) => void;
  /** Rows are in tree order: indent by depth and allow toggling whole branches. */
  tree?: boolean;
  /** Disable all inputs (e.g. while starting the export). */
  disabled?: boolean;
}

const MAX_INDENT = 10;

/** FR-7: the pages that will be exported, with checkboxes to drop individual pages or branches. */
export function PageList({ pages, excluded, onChange, tree = false, disabled = false }: PageListProps): JSX.Element {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const all = pages.map((page, index) => ({ page, index }));
    if (!needle) return all;
    return all.filter(
      ({ page }) =>
        page.title.toLowerCase().includes(needle) ||
        (page.breadcrumb ?? []).some((b) => b.toLowerCase().includes(needle)),
    );
  }, [pages, needle]);

  const selectedCount = pages.length - pages.filter((p) => excluded.has(p.id)).length;

  const setMany = (ids: string[], include: boolean) => {
    const next = new Set(excluded);
    for (const id of ids) (include ? next.delete(id) : next.add(id));
    onChange(next);
  };

  const toggleBranch = (index: number) => {
    const end = branchEnd(pages, index);
    const ids = pages.slice(index, end).map((p) => p.id);
    const anyIncluded = ids.some((id) => !excluded.has(id));
    setMany(ids, !anyIncluded);
  };

  return (
    <div class="page-list">
      <div class="list-toolbar">
        <div class="search">
          <Icon name="search" size={14} />
          <input
            type="search"
            class="input"
            placeholder="Filter pages"
            aria-label="Filter pages by title"
            value={query}
            onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <span class="list-count" aria-live="polite">
          {selectedCount.toLocaleString()} of {plural(pages.length, 'item')} selected
        </span>
        <div class="list-bulk">
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setMany(rows.map((r) => r.page.id), true)}
          >
            {needle ? 'Select shown' : 'Select all'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setMany(rows.map((r) => r.page.id), false)}
          >
            {needle ? 'Deselect shown' : 'Deselect all'}
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div class="empty">No pages match “{query.trim()}”.</div>
      ) : (
        <ul class="rows" aria-label="Pages to export">
          {rows.map(({ page, index }) => {
            const included = !excluded.has(page.id);
            const end = tree ? branchEnd(pages, index) : index + 1;
            const subCount = end - index - 1;
            const indent = tree ? Math.min(page.depth, MAX_INDENT) : 0;
            const crumb = page.breadcrumb?.length ? page.breadcrumb.join(' › ') : '';
            return (
              <li
                key={page.id}
                class={`row${included ? '' : ' is-excluded'}`}
                style={indent ? { paddingInlineStart: `${8 + indent * 16}px` } : undefined}
              >
                <label class="row-main">
                  <input
                    type="checkbox"
                    class="checkbox"
                    checked={included}
                    disabled={disabled}
                    onChange={(e) => setMany([page.id], (e.currentTarget as HTMLInputElement).checked)}
                  />
                  <Icon name={TYPE_ICON[page.type]} class="row-icon" />
                  <span class="row-text">
                    <span class="row-title">{page.title || 'Untitled'}</span>
                    {crumb && (!tree || needle) ? <span class="row-crumb">{crumb}</span> : null}
                  </span>
                </label>
                <span class="row-badges">
                  <TypeBadges type={page.type} />
                  {page.reason === 'linked' ? (
                    <span class="badge badge-linked" title="Linked from an exported page">
                      Linked
                    </span>
                  ) : null}
                  {page.status && page.status !== 'current' ? <span class="badge">{page.status}</span> : null}
                </span>
                {tree && subCount > 0 && !needle ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="branch"
                    disabled={disabled}
                    label={`${included ? 'Exclude' : 'Include'} “${page.title}” and ${plural(subCount, 'sub-page')}`}
                    onClick={() => toggleBranch(index)}
                  />
                ) : null}
                <a
                  class="row-open"
                  href={page.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open in Confluence"
                  aria-label={`Open “${page.title}” in Confluence`}
                >
                  <Icon name="external" size={14} />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
