/**
 * StatusTag —— General "Status Tag" component.
 *
 * Previously, Wiki (WikiStatusBadge) and Code (statusLabel) each implemented the rendering of status → Tea Tag
 * (theme + variant="soft" + optional hint), with completely identical structure. Here, we unify the handling,
 * and each asset page is only responsible for providing the business mapping of "status → label/theme".
 */
import { Tag } from 'tea-component';

export type StatusTheme = 'default' | 'success' | 'warning' | 'error';

export function StatusTag({
  label,
  theme = 'default',
  hint,
  className,
}: {
  /** Translated status text (or original status fallback) */
  label: string;
  /** Tea Tag semantic theme (soft variant) */
  theme?: StatusTheme;
  /** Optional status supplementary description (e.g., "processing, may take a few minutes") */
  hint?: string;
  /** Outer container class (default _asset-status) */
  className?: string;
}) {
  return (
    <span className={className ?? '_asset-status'}>
      <Tag theme={theme} variant="soft" size="sm">
        {label}
      </Tag>
      {hint && <span className="_asset-status-hint">{hint}</span>}
    </span>
  );
}
