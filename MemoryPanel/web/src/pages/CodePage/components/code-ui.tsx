/**
 * code-ui —— A small display component for the Code asset page.
 * Extracted from CodeSourcesPanel.tsx: Owner label / Status label.
 */
import { useTranslation } from 'react-i18next';
import { StatusTag, type StatusTheme } from '@/components/StatusTag';
import { OwnerLabel } from '@/components/OwnerLabel';

/**
 * Owner Display —— Reuse the generic OwnerLabel (uses the global cache from user-profile-store, with multiple lines sharing the same owner).
 * Extracting a sub-component is required by the Rules of Hooks (cannot call hooks in a .map loop).
 */
export function CodeOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const { t } = useTranslation();
  return (
    <OwnerLabel
      userId={userId}
      currentUserId={currentUserId}
      title={t('code.detail.owner', { userId })}
      youText={t('code.detail.you')}
      youClassName="_codelist-card-meta-you"
    />
  );
}

// Status → Tea Tag Semantic Theme Mapping (soft variant), aligned with Memory's statusTheme.
export function statusLabel(t: (key: string, options?: Record<string, unknown>) => string, s: string) {
  const map: Record<string, [string, StatusTheme]> = {
    ready: [t('code.status.ready'), 'success'],
    pending: [t('code.status.pending'), 'warning'],
    processing: [t('code.status.processing'), 'warning'],
    failed: [t('code.status.failed'), 'error'],
    cloning: [t('code.status.cloning'), 'warning'],
    indexing: [t('code.status.indexing'), 'warning'],
    syncing: [t('code.status.syncing'), 'warning'],
    error: [t('code.status.error'), 'error'],
    missing: [t('code.status.missing'), 'error'],
  };
  const [label, theme] = map[s] ?? [s, 'default'];
  const hint = s === 'pending' || s === 'processing' ? t('code.statusHint.processing') : '';
  return <StatusTag label={label} theme={theme} hint={hint} />;
}
