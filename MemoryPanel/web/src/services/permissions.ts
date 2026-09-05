/**
 * permissions.ts — The sole authoritative implementation for global permission checks.
 *
 * Extracted from the original demoStore.ts. isGlobalAdmin is the sole "global admin" determination across the entire site.
 * Entry point (independent of the backend implementation for team/agent/task, purely a frontend auth state determination).
 */

/**
 * Global admin check: admin has all permissions and can see all content.
 *
 * The sole authoritative source: `auth/verify` response's `user.user_type === 'system_admin'`,
 * Written by LoginGate into `AuthState.isAdmin` during login.
 *
 * Remove the `username === 'admin'` string fallback — this fallback is a leftover from the early demo phase,
 * It causes ordinary users whose `display_name` / `username` happen to be "admin" to be mistakenly judged as global admins,
 * Especially when a "user has no affiliation with any team" or "a team only has themselves",
 * `roleInTeam` returns null, and the UI renders according to admin logic (e.g., ResourcePage shows AdminResourceLock),
 * causing normal/member users to see the admin lock page.
 */
export function isGlobalAdmin(_currentUser: string, isAdminFlag?: boolean): boolean {
  return isAdminFlag === true;
}
