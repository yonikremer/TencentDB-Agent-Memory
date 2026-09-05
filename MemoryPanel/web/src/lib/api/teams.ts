/**
 * api/teams.ts — Team + TeamMember（meta/team/* + meta/team-member/*）。
 */
import { metaPost, metaListAll, getCurrentUser } from './base';
import type { Team, TeamMember } from './types';

export const teamsApi = {
  /**
   * List the current user's teams as an active member.
   * meta/team/list requires body to include user_id or user_key; identity in the header alone is insufficient.
   * admin also passes their own user_id (the backend currently has no "instance-level listing of all teams" like user/list).
   */
  list: async () => {
    const me = await getCurrentUser();
    return metaListAll<Team>('team/list', { user_id: me.user_id });
  },

  /** team details */
  get: (teamId: string) => metaPost<Team>('team/get', { team_id: teamId }),

  /** Create team */
  create: async (data: { name: string; description?: string }) => {
    const me = await getCurrentUser();
    return metaPost<Team>('team/create', {
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
    });
  },

  /** Update team */
  update: (teamId: string, data: { name?: string; description?: string }) =>
    metaPost<Team>('team/update', { team_id: teamId, ...data }),

  /**
   * Delete team (meta team/delete).
   * Note: the backend schema requires a `team_ids` array (multiple teams can be deleted at once); passing a single `team_id`
   * will be silently stripped by zod and fail validation due to missing `team_ids` → 400. Deletion is a cascading operation,
   * which will also delete the team's members, agents, tasks, and all assets.
   */
  delete: (teamId: string) => metaPost<{ ok: boolean }>('team/delete', { team_ids: [teamId] }),
};

export const membersApi = {
  /** List team members */
  list: (teamId: string) => metaListAll<TeamMember>('team-member/list', { team_id: teamId }),

  /**
   * Add member (add to team based on known user_id).
   *
   * "Open account" (obtaining user_key) and "joining a team" are two independent matters: the user holds it themselves
   * user_key can be used to get your own user_id from auth/verify after login; team admins only need
   * Given this user_id, you can invoke team-member/add (standard meta action).
   * No equivalent capability of "create account by username" — to find user_id by username, use `usersApi.list`
   * Pass `{ username }` for exact matching.
   */
  add: (teamId: string, data: { user_id: string; role: 'admin' | 'member' | 'reviewer' }) =>
    metaPost<TeamMember>('team-member/add', { team_id: teamId, user_id: data.user_id, role: data.role }),

  /** Remove member */
  remove: async (teamId: string, userId: string) => {
    await metaPost<{ ok: boolean }>('team-member/remove', { team_id: teamId, user_id: userId });
  },
};
