/**
 * Kernel /v3/skill/* data plane action list (14 items, all POST).
 *
 * tdai-memory-openclaw-plugin/docs/skill-api-for-frontend.md
 *
 * Differences from /v3/meta/*:
 *   - The skill data plane has independent storage of its own (with the skl- prefix for skill_id); it is readable within the team and writable by the owner agent;
 *   - Identity fields (user_id / team_id / agent_id / task_id) are placed in the body, not in the Header;
 *   - Pagination uses a nested pagination.{limit,offset}, not top-level limit/offset, so the meta's
 *     sanitizeBody logic is not needed, and the body can be passed through as-is.
 */

/** Read operation (optional agent_id); this is only for documentation annotation, passed through without distinction. */
export const SKILL_LIST_ACTIONS = new Set(['list', 'search', 'versions']);

export const SKILL_ACTIONS = [
  'create',
  'update',
  'patch',
  'delete',
  'get',
  'list',
  'search',
  'versions',
  'files/write',
  'files/remove',
  'files/read',
  'listing',
  'extract',
  'export',
  'conversation/add',
] as const;

export type SkillAction = (typeof SKILL_ACTIONS)[number];

export const ALLOWED_SKILL_ACTIONS = new Set<string>(SKILL_ACTIONS);

export function isAllowedSkillAction(action: string): action is SkillAction {
  return ALLOWED_SKILL_ACTIONS.has(action);
}
