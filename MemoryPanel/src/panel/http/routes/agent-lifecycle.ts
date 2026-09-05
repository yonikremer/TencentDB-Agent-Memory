/**
 * /api/v1/agent/delete-cascade —— When deleting an agent, first cascade clean up the skills under that agent.
 *
 * Background (division of work with the kernel archiveAgent):
 *   - The kernel `archiveAgent` (metadata-service.ts) will archive the agent itself in the same call
 *     chat_memory asset + clear the bindings of other agents borrowing this memory; skill is completely unrelated.
 *   - Result: directly calling meta/agent/archive leaves owner_agent_id = the deleted agent's
 *     active skill dirty data (frontend only filters by status, so it appears to disappear but still exists in the table).
 *
 * The approach of this route (business-level cascading closure at the control layer, without modifying the kernel):
 *   1. auth/verify reverse-lookup caller
 *   2. agent/get to obtain the agent, strictly validate owner_user_id === caller (admins are not allowed to delete on behalf in this phase)
 *   3. skill/list to fetch all with pagination based on owner_agent_id + active
 *   4. skill/delete one by one —— if any fails, immediately interrupt, return 500 + deleted list + failed skill_id
 *      + kernel error message; in this case agent/archive will not be called, caller needs to fix and retry
 *   5. After all skills are successfully archived, call meta/agent/archive
 *      —— The kernel cleans chat_memory in the same archive (keep this as is)
 *
 * Why not do admin proxy deletion: the kernel skill/delete requires the caller to be the owner_agent's owner;
 * Admin proxy deletion requires obtaining the owner's user_key via impersonation or control layers, which is not done in this phase.
 *
 * Frontend support: agentsApi.delete needs to switch from meta/agent/archive to this route; if you want to skip the cascade
 * Old logic (e.g., migration tools) can continue to directly call /api/v1/meta/agent/archive (preserving the escape pod).
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../envelope.js';
import type { MetaEnvelope } from '../../kernel/envelope.js';
import type { MetaCallContext } from '../../kernel/types.js';
import {
  buildCtx,
  extractListItems,
  okEnvelope,
  readJson,
  resolveCallerUserId,
  str,
} from './knowledge/common.js';

/** skill/list page 100 items —— aligned with the pagination step of knowledge fetchAllMetaListItems. */
const SKILL_LIST_PAGE = 100;

interface AgentRaw {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  status?: string;
  name?: string;
}

interface SkillRow {
  skill_id: string;
  version: number;
  owner_agent_id?: string;
}

/** skill/list fetch all active skills under this agent with pagination. */
async function listAgentSkills(
  deps: PanelDeps,
  ctx: MetaCallContext,
  callerId: string,
  teamId: string,
  agentId: string,
): Promise<{ ok: true; items: SkillRow[] } | { ok: false; envelope: MetaEnvelope<unknown> }> {
  const all: SkillRow[] = [];
  let offset = 0;
  for (;;) {
    const env = await deps.skillKernel.invoke(
      'list',
      {
        user_id: callerId,
        team_id: teamId,
        agent_id: agentId,
        filters: { status: ['active'] },
        pagination: { limit: SKILL_LIST_PAGE, offset },
      },
      ctx,
    );
    if (env.code !== 0) return { ok: false, envelope: env };
    const batch = extractListItems<SkillRow>(env);
    all.push(...batch);
    const total = (env.data as { total?: number } | null)?.total ?? all.length;
    if (batch.length === 0 || all.length >= total) break;
    offset += SKILL_LIST_PAGE;
  }
  return { ok: true, items: all };
}

export function registerAgentLifecycleRoutes(api: Hono, deps: PanelDeps): void {
  const mw = validatePanelMetaHeaders(deps);

  api.post('/agent/delete-cascade', mw, async (c) => {
    const ctx = buildCtx(c);
    const body = await readJson(c);
    const agentId = str(body, 'agent_id');
    if (!agentId) return respondControlError(c, 400, 'MISSING_AGENT_ID');

    // 1. caller
    const callerId = await resolveCallerUserId(deps, ctx);
    if (!callerId) return respondControlError(c, 401, 'INVALID_USER_KEY');

    // 2. agent + owner strong validation
    const agentEnv = await deps.metaKernel.invoke('agent/get', { agent_id: agentId }, ctx);
    if (agentEnv.code === 404 || (agentEnv.code === 0 && !agentEnv.data)) {
      return respondControlError(c, 404, 'AGENT_NOT_FOUND');
    }
    if (agentEnv.code !== 0) return respondEnvelope(c, agentEnv);
    const agent = agentEnv.data as AgentRaw;
    if (agent.owner_user_id !== callerId) {
      return respondControlError(c, 403, 'NOT_YOUR_AGENT');
    }

    // 3. skill list
    const listRes = await listAgentSkills(deps, ctx, callerId, agent.team_id, agent.agent_id);
    if (!listRes.ok) return respondEnvelope(c, listRes.envelope);
    const skills = listRes.items;

    // 4. Skill/delete one by one —— Interrupt immediately on any failure, agent does not archive
    const deletedIds: string[] = [];
    for (const s of skills) {
      const delEnv = await deps.skillKernel.invoke(
        'delete',
        {
          user_id: callerId,
          team_id: agent.team_id,
          agent_id: agent.agent_id,
          skill_id: s.skill_id,
          expected_version: s.version,
        },
        ctx,
      );
      if (delEnv.code !== 0) {
        return respondEnvelope(c, {
          code: 500,
          message: 'SKILL_DELETE_FAILED',
          request_id: c.get('reqId') ?? '',
          data: {
            failed_skill_id: s.skill_id,
            kernel_code: delEnv.code,
            kernel_message: delEnv.message,
            deleted_skill_ids: deletedIds,
          },
        });
      }
      deletedIds.push(s.skill_id);
    }

    // 5. agent/archive —— the kernel will still clean chat_memory by itself
    const archiveEnv = await deps.metaKernel.invoke('agent/archive', { agent_id: agentId }, ctx);
    if (archiveEnv.code !== 0) return respondEnvelope(c, archiveEnv);

    return respondEnvelope(
      c,
      okEnvelope(c, {
        archived: true,
        agent_id: agentId,
        deleted_skill_count: deletedIds.length,
        deleted_skill_ids: deletedIds,
      }),
    );
  });
}
