/**
 * asset-common —— Shared types and pure utility functions for asset (Wiki / Code / Skill / Memory) pages.
 *
 * Previously, these types and utility functions were defined separately in wiki-constants.ts / code-constants.ts /
 * memory types.ts, and here they are consolidated, with page files maintaining their original import paths
 * via re-export.
 */

/** List view switching: card / table */
export type ViewMode = 'card' | 'list';

/** List Status Filter */
export type StatusFilter = 'all' | 'ready' | 'processing' | 'error';

/** Asset Page Sub-view: List / Detail */
export type SubView = 'list' | 'detail';

/** Asset scope: team pool / fixed assets */
export type ScopeTab = 'team' | 'fixed';

/**
 * ISO time string → panel display format (local timezone, 'MM/DD HH:MM').
 * If input is empty or invalid → return '—'.
 * This was previously implemented identically in wiki-constants.ts and code-constants.ts, converging to this.
 */
export function formatShortTime(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
