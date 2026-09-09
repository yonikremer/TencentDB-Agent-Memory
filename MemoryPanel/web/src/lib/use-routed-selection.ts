import { useEffect } from 'react';
import { navigateIfDiff } from './asset-routes';

/**
 * useRoutedSelection — shared URL↔state sync for asset list/detail pages.
 *
 * Selection state lives in each page's hook, but the URL is the source of
 * truth so back/forward, refresh, and deep links work. Pages only supply
 * enter/exit state transitions; this owns the sync pattern.
 */
export function useRoutedSelection(args: {
  navigate: (path: string) => void;
  /** Decoded route param ('' = list). */
  routeId: string;
  /** Currently selected id (null = list). */
  selectedId: string | null;
  /** List URL, e.g. '/wiki'. */
  listPath: string;
  /** Detail URL builder, e.g. (id) => wikiPath(id, 'overview'). */
  detailPath: (id: string) => string;
  /** State transition into detail (set ids, reset subtabs, fetch). No navigation. */
  onEnter: (id: string) => void;
  /** State transition back to list. No navigation. */
  onExit: () => void;
}): {
  openDetail: (id: string) => void;
  closeDetail: () => void;
} {
  const { navigate, routeId, selectedId, listPath, detailPath, onEnter, onExit } = args;

  // URL → state: direct load, refresh, or browser back/forward.
  // Branches no-op once synced, so changing onEnter/onExit identities are harmless.
  useEffect(() => {
    if (routeId && routeId !== selectedId) onEnter(routeId);
    else if (!routeId && selectedId) onExit();
  }, [routeId, selectedId, onEnter, onExit]);

  return {
    // Same-id reopen is a no-op (no duplicate history entry, no refetch).
    openDetail: (id: string) => {
      if (id === selectedId) return;
      navigateIfDiff(navigate, detailPath(id));
      onEnter(id);
    },
    closeDetail: () => navigateIfDiff(navigate, listPath),
  };
}
