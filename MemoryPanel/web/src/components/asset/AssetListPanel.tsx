/**
 * AssetListPanel — General left-side panel for asset management page.
 *
 * Unify the left navigation list container for assets such as Skills / Memory, providing:
 *   - Panel title + item count statistics
 *   - Loading skeleton screen
 *   - Empty state prompt
 *   - Selection state management (light brand background, no border)
 *   - Unified list item 4-row structure (title / description / badge / metadata)
 *
 * List item content is filled by each asset page via render prop,
 * Maintaining decoupling between the container and business logic.
 */

import type { ReactNode } from 'react';
import './asset-list-panel.css';

/* ── Panel ── */

interface AssetListPanelProps<T> {
  /** Panel Title */
  title: ReactNode;
  /** Count statistics text */
  count?: ReactNode;
  /** Loading? */
  loading?: boolean;
  /** Data item */
  items: T[];
  /** Selected item id */
  selectedId?: string | null;
  /** Extract unique id from data item */
  getItemId: (item: T) => string;
  /** Selection callback */
  onSelect: (item: T) => void;
  /** Render the content of a single list item (excluding the outer selected state container) */
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  /** Determine whether an item is disabled (not clickable) */
  isItemDisabled?: (item: T) => boolean;
  /** Empty state text */
  emptyText?: ReactNode;
}

export function AssetListPanel<T>({
  title,
  count,
  loading,
  items,
  selectedId,
  getItemId,
  onSelect,
  renderItem,
  isItemDisabled,
  emptyText,
}: AssetListPanelProps<T>) {
  return (
    <div className="_alp">
      <div className="_alp-header">
        <span className="_alp-title">{title}</span>
        {!loading && count != null && <span className="_alp-count">{count}</span>}
      </div>

      {loading ? (
        <div className="_alp-items">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="_alp-item _alp-skeleton">
              <div className="_alp-skeleton-line _alp-skeleton-primary" />
              <div className="_alp-skeleton-line _alp-skeleton-secondary" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="_alp-empty">{emptyText}</div>
      ) : (
        <ul className="_alp-items">
          {items.map((item) => {
            const id = getItemId(item);
            const isSelected = selectedId === id;
            const disabled = isItemDisabled?.(item) ?? false;
            return (
              <li
                key={id}
                className={[
                  '_alp-item',
                  isSelected ? '_alp-item--selected' : '',
                  disabled ? '_alp-item--disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  className="_alp-item-btn"
                  onClick={() => !disabled && onSelect(item)}
                  disabled={disabled}
                >
                  {renderItem(item, isSelected)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── List Item Content Area — Standardized 4-Line Structure ── */

/** Title line: main identifier + optional action buttons */
export function AssetItemHeader({ children }: { children: ReactNode }) {
  return <div className="_alp-item-header">{children}</div>;
}

/** Name / Title Text */
export function AssetItemName({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="_alp-item-name" title={title}>
      {children}
    </span>
  );
}

/** Asset real id —— weakened display, attached next to the name, for easy identification of assets with ID-based naming (name + id combination) */
export function AssetItemId({ children }: { children: ReactNode }) {
  return (
    <span className="_alp-item-id" title={typeof children === 'string' ? children : undefined}>
      {children}
    </span>
  );
}

/** Description text (2 lines truncated) */
export function AssetItemDesc({ children }: { children: ReactNode }) {
  return <p className="_alp-item-desc">{children}</p>;
}

/** Badge Row Container */
export function AssetItemBadges({ children }: { children: ReactNode }) {
  return <div className="_alp-item-badges">{children}</div>;
}

/** Plain text badge — alternative to light Tag */
export function AssetBadge({
  icon,
  children,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="_alp-badge" title={title}>
      {icon}
      {children}
    </span>
  );
}

/** "You"/"You" identifier — brand color plain text */
export function AssetBadgeYou({ children }: { children: ReactNode }) {
  return <span className="_alp-badge-you">{children}</span>;
}

/** Metadata row container */
export function AssetItemMeta({ children }: { children: ReactNode }) {
  return <div className="_alp-item-meta">{children}</div>;
}

/** Metadata time on the right */
export function AssetItemTime({ children }: { children: ReactNode }) {
  return <span className="_alp-item-time">{children}</span>;
}
