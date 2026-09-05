/**
 * AssetSplitLayout — Universal split layout for the asset management page.
 *
 * Unify the "left list + right details" split layout structure for assets such as Skills / Memory:
 * - The left and right widths can be adjusted via dragging, and the ratio is remembered in localStorage (retained in the same browser on the next visit)
 * - Set a maximum height for the right-side details; when content exceeds it, scroll within the details area internally, without expanding the outer page height
 *   (No scrollbar appears in the outer container)
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './asset-split-layout.css';

interface AssetSplitLayoutProps {
  sidebar: ReactNode;
  detail: ReactNode;
  /** Persistence key for drag width (independent across pages); not persisted if not provided */
  storageKey?: string;
}

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;

function clampWidth(w: number): number {
  return Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));
}

function readStoredWidth(storageKey?: string): number {
  if (!storageKey) return DEFAULT_SIDEBAR;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_SIDEBAR;
  } catch {
    return DEFAULT_SIDEBAR;
  }
}

export function AssetSplitLayout({ sidebar, detail, storageKey }: AssetSplitLayoutProps) {
  const { t } = useTranslation();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredWidth(storageKey));
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag process: calculate the width of the left column based on the left boundary of the container, limited to [MIN, MAX]
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setSidebarWidth(clampWidth(e.clientX - rect.left));
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Disable text selection during dragging to avoid selecting list content
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging]);

  // Persist the final width after dragging
  useEffect(() => {
    if (dragging || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(sidebarWidth));
    } catch {
      /* Silently ignore when localStorage is unavailable, only affecting memory capability */
    }
  }, [dragging, sidebarWidth, storageKey]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`_asset-split${dragging ? ' _asset-split--dragging' : ''}`}
      style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
    >
      <section className="_asset-split-sidebar">{sidebar}</section>
      <button
        type="button"
        className="_asset-split-resizer"
        aria-label={t('assetSplit.resizer.label')}
        onMouseDown={onHandleMouseDown}
        onKeyDown={(e) => {
          // Keyboard accessible: left and right arrows adjust the left column width in 16px steps
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w - 16));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w + 16));
          }
        }}
      >
        <span className="_asset-split-resizer-bar" />
      </button>
      <section className="_asset-split-detail">{detail}</section>
    </div>
  );
}
