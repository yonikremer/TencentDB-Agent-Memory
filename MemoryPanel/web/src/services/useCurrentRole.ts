/**
 * useCurrentRole — Get the role of the currently logged-in user
 *
 * Return 'admin' | 'member' | 'reviewer' | null (null = not logged in).
 *
 * Role model (the sole authoritative standard, do not revert to "determine admin by team member table"):
 *   - admin is a **global role**, unrelated to whether they have created or joined any team (even if there are currently no teams, they are always admin).
 *     The responsibility of admin is to manage teams (create teams, input members), not to manage specific resources.
 *   - member is a **role within a team**, i.e., a member of a specific team, responsible for managing resources within the team (agent/skill/wiki/code/memory).
 *   - Therefore, the judgment order must be: first determine if it is a global admin; if not, then check the member role in their active team.
 *     The reverse approach of "first check the team member table, and if not found, treat as having no role" is wrong—it will lead to "when an admin account has no teams
 *     Misjudged as non-admin (even null)".
 */
import { useMemo } from 'react';
import { useTeams, roleInTeam, isGlobalAdmin } from '@/services';
import { useAuthStore } from '@/stores/auth';

export type TeamRole = 'admin' | 'member' | 'reviewer';

export function useCurrentRole(): TeamRole | null {
  const { auth } = useAuthStore();
  const { activeTeam } = useTeams();
  return useMemo(() => {
    if (!auth) return null;
    // Global admin: independent of team, always admin (does not depend on activeTeam / team.members query results)
    // isAdmin comes from auth/verify's user_type === 'system_admin', which is the sole authoritative field.
    if (isGlobalAdmin(auth.user, auth.isAdmin)) return 'admin';
    // Non-admin: role depends on their member record in the current active team (usually 'member')
    return roleInTeam(activeTeam, auth.user_id);
  }, [activeTeam, auth]);
}
