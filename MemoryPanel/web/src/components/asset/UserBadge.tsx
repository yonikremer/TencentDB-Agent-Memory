/**
 * UserBadge —— General "User Badge" component.
 *
 * Previously, Skills (SkillOwnerTag) and Memory (UploaderBadge) each implemented the same
 * "AssetBadge + UserIcon + displayName display + current user appended 'you' marker" structure.
 * Here, it is unified; displayName is obtained via global caching from useUserDisplayName, and title /
 * youText / getTitle are injected by the caller to accommodate i18n across pages.
 */
import { UserIcon } from 'tea-icons-react';
import { useUserDisplayName } from '@/services/user-profile-store';
import { AssetBadge, AssetBadgeYou } from './AssetListPanel';

export function UserBadge({
  userId,
  isCurrentUser,
  title,
  youText,
  getTitle,
}: {
  userId: string;
  /** Whether it is the current user (determines whether to append the "you" marker) */
  isCurrentUser: boolean;
  /** hover hint text; default userId. If you need to construct based on displayName (e.g., skills), use getTitle */
  title?: string;
  /** "You" marker text */
  youText: string;
  /** Callback to generate hover tooltip based on displayName (preferred over title) */
  getTitle?: (displayName: string) => string;
}) {
  const displayName = useUserDisplayName(userId);
  const resolvedTitle = getTitle
    ? getTitle(displayName || userId)
    : (title ?? userId);
  return (
    <AssetBadge icon={<UserIcon size={10} />} title={resolvedTitle}>
      {displayName || userId}
      {isCurrentUser && <AssetBadgeYou>{youText}</AssetBadgeYou>}
    </AssetBadge>
  );
}
