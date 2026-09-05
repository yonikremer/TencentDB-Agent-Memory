/**
 * OwnerLabel —— General "Asset Owner Display" component.
 *
 * Previously, Wiki (WikiOwnerLabel) and Code (CodeOwnerLabel) each implemented exactly the same
 * The logic of "@displayName + current user appending 'you' marker" (both rely on the global useUserDisplayName
 * (Sub-component structure that cannot call hooks in a loop within .map under cache + Rules of Hooks constraints).
 * Here the unified closing; title / youText / youClassName are injected by the caller to support i18n and styling across pages.
 */
import { useUserDisplayName } from '@/services/user-profile-store';

export function OwnerLabel({
  userId,
  currentUserId,
  title,
  youText,
  youClassName,
}: {
  userId: string;
  currentUserId: string;
  /** hover hint text (the caller is responsible for i18n, usually contains userId interpolation) */
  title: string;
  /** "You" label text (displayed for current user) */
  youText: string;
  /** The class marked by "you" (each page can inject its own style class) */
  youClassName?: string;
}) {
  const name = useUserDisplayName(userId);
  return (
    <span title={title}>
      @{name || userId}
      {userId === currentUserId && (
        <span className={youClassName ?? '_owner-label-you'}>{youText}</span>
      )}
    </span>
  );
}
