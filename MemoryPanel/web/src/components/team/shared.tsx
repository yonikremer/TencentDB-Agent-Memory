/**
 * Public display component:
 *   - Mounted: "Mounted Assets" count chip on the Agent card
 *   - LightField: Lightweight form field (label + hint + children)
 *   - CollapseGroup: Collapsible group (skills / code_graph / llm_wiki / chat_memory checkbox list container)
 *   - AssetCheckList: Asset checkbox list rendered within the group
 *
 * All are purely display components, without business logic or data requests.
 */

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from 'tea-component';
import { ChevronRightIcon } from 'tea-icons-react';
import type { MountableAsset } from './types';

/** Whether an asset is selectable/mountable: only selectable when stateless (skill) or status is ready; other statuses (pending/failed/...) are considered unavailable. */
export function isAssetSelectable(a: MountableAsset): boolean {
  return !a.status || a.status === 'ready';
}

/** Filter out all selectable asset keys (for use in "Select All", ensuring consistency with the list's selection disabled state). */
export function selectableAssetKeys(assets: MountableAsset[]): string[] {
  return assets.filter(isAssetSelectable).map((a) => a.key);
}

export function Mounted({ label, count, loading = false }: { label: string; count: number; loading?: boolean }) {
  // When the count is still loading, replace only the number area with skeleton placeholders, leaving the label untouched.
  // Make the agent card's main body immediately visible (to avoid the abrupt transition from "4 skeleton → 1 real card"),
  // only placeholder the uncertain count data, which is smoother than keeping the skeleton for the entire grid.
  return (
    <div className={`_memory-mounted-chip${loading ? ' _memory-mounted-chip--loading' : ''}`}>
      <span className="_memory-mounted-chip-label">{label}</span>
      {loading ? (
        <span className="_memory-mounted-chip-count _memory-mounted-chip-count--loading" aria-label="loading" />
      ) : (
        <span className="_memory-mounted-chip-count">{count}</span>
      )}
    </div>
  );
}

export function LightField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="_memory-light-field">
      <div className="_memory-light-field-label">{label}</div>
      {hint && <div className="_memory-light-field-hint">{hint}</div>}
      {children}
    </label>
  );
}

export function CollapseGroup({
  icon,
  title,
  selectedCount,
  totalCount,
  open,
  onToggle,
  hideTotal = false,
  loading = false,
  children,
}: {
  icon: ReactNode;
  title: string;
  selectedCount: number;
  totalCount: number;
  open: boolean;
  onToggle: () => void;
  /** Only display the bound count, do not display the total team pool count (used for read-only detail scenarios). */
  hideTotal?: boolean;
  /**
   * Loading state: replace the count number area with skeleton placeholders (preserve the structure of label/title, etc., to avoid layout jitter).
   * Used for scenarios where asset binding has not been fully fetched when the detail popup is opened, to avoid the abrupt transition from "Selected 0/Total 0 → real numbers".
   */
  loading?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className={`_memory-collapse-group${loading ? ' _memory-collapse-group--loading' : ''}`}>
      <button type="button" onClick={onToggle} className="_memory-collapse-group-header" disabled={loading}>
        <ChevronRightIcon
          size={12}
          className={`_memory-collapse-group-chevron${open ? ' _memory-collapse-group-chevron--open' : ''}`}
        />
        <span className="_memory-collapse-group-icon">{icon}</span>
        <span className="_memory-collapse-group-title">{title}</span>
        {loading ? (
          // Loading: keep icon + title, replace only the count area with skeleton; disable button to prevent "empty panel" from clicking during loading
          <span className="_memory-collapse-group-count _memory-collapse-group-count--loading" aria-label="loading" />
        ) : (
          <span className="_memory-collapse-group-count">
            {hideTotal ? t('shared.bound', { count: selectedCount }) : t('shared.selected', { selected: selectedCount, total: totalCount })}
          </span>
        )}
      </button>
      {open && !loading && <div className="_memory-collapse-group-body">{children}</div>}
    </div>
  );
}

export function AssetCheckList({
  assets,
  checkedKeys,
  onToggle,
  readOnly = false,
  disabledKeys = new Set<string>(),
}: {
  assets: MountableAsset[];
  checkedKeys: string[];
  onToggle: (key: string) => void;
  readOnly?: boolean;
  disabledKeys?: Set<string>;
}) {
  const { t } = useTranslation();
  const groups = new Map<string, MountableAsset[]>();
  for (const a of assets) {
    if (!groups.has(a.group)) groups.set(a.group, []);
    groups.get(a.group)!.push(a);
  }
  return (
    <div className="_memory-asset-check-groups">
      {Array.from(groups.entries()).map(([group, items]) => (
        <div key={group}>
          <div className="_memory-asset-check-group-label">{group}</div>
          <ul className="_memory-asset-check-list">
            {items.map((a) => {
              const checked = checkedKeys.includes(a.key);
              const notReady = !isAssetSelectable(a);
              const disabled = readOnly || disabledKeys.has(a.key) || notReady;
              return (
                <li key={a.key} className="_memory-asset-check-item">
                  <Checkbox value={checked} disabled={disabled} onChange={() => { if (!disabled) onToggle(a.key); }}>
                    <span className="_memory-asset-check-item-row">
                      <span className="_memory-asset-check-item-title">{a.title}</span>
                      <span className="_memory-asset-check-item-slug">
                        {a.slug}{disabledKeys.has(a.key) ? t('shared.selfMemory') : notReady ? ` · ${a.status}` : ''}
                      </span>
                    </span>
                  </Checkbox>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
