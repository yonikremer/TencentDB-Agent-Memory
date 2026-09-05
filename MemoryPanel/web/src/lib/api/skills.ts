/**
 * api/skills.ts — Skill data surface (/api/v1/skill/*).
 *
 * Key difference with the meta link:
 *   - skill has independent storage and primary key skill_id (prefix skl-), readable within the team and writable by the owner agent;
 *   - Identity fields (user_id / team_id / agent_id) are placed in the body, not in the Header (the authentication Header
 *     is still X-Tdai-Service-Id + X-Tdai-User-Key, consistent with meta);
 *   - Write operations (create/update/patch/delete/files.*) require agent_id (= owner),
 *     and update/patch/delete/files.* also require expected_version optimistic locking;
 *   - Pagination uses nested pagination.{limit,offset}.
 *
 * The semantics of "Mount to Agent": the only mechanism for a skill to truly belong to a specific agent is fork — a copy
 * owner_agent_id=an independent copy of the target agent (see skillApi.forkToAgent). acl/grant only modify
 * the meta authorization layer, which is ineffective for the "Fixed Assets" tab and runtime injection (both based on owner_agent_id).
 */
import { getPanelSession } from '../panelSession';
import { request, getCurrentUser, ApiError, META_PAGE_SIZE } from './base';
import type { MetaEnvelope } from './types';

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillFileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

const SKILL_PREFIX = '/api/v1/skill';

/** skill data plane invocation: inject dual Headers, POST body, parse envelope (throw ApiError if code!=0). */
async function skillCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${SKILL_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty skill response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty skill response',
    });
  }
  return envelope.data;
}

async function skillPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return skillCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
}

export const skillApi = {
  /** List head skills under team (paginated to fetch all; optionally filter by owner agent / name prefix / status) */
  list: async (
    teamId: string,
    opts?: { ownerAgentId?: string; namePrefix?: string; status?: Array<'active' | 'archived'> }
  ): Promise<SkillSummary[]> => {
    const me = await getCurrentUser();
    const items: SkillSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await skillPost<{ items: SkillSummary[]; total: number }>('list', {
        user_id: me.user_id,
        team_id: teamId,
        filters: {
          owner_agent_id: opts?.ownerAgentId,
          name_prefix: opts?.namePrefix,
          status: opts?.status ?? ['active'],
        },
        pagination: { limit: META_PAGE_SIZE, offset },
      });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return items;
  },

  /** List the skills owned by a certain agent */
  listByAgent: (teamId: string, agentId: string): Promise<SkillSummary[]> =>
    skillApi.list(teamId, { ownerAgentId: agentId }),

  /** Get skill details (including SKILL.md body + resource list) */
  get: async (teamId: string, skillId: string): Promise<SkillDetail> => {
    const me = await getCurrentUser();
    return skillPost<SkillDetail>('get', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      include_content: true,
      include_manifest: true,
    });
  },

  /** Read the content of a single resource file */
  filesRead: async (teamId: string, skillId: string, path: string): Promise<SkillFileContent> => {
    const me = await getCurrentUser();
    return skillPost<SkillFileContent>('files/read', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      path,
    });
  },

  /** Create skill (agentId will become owner_agent_id) */
  create: async (
    teamId: string,
    agentId: string,
    data: { name: string; content: string; resources?: SkillResourcePayload[]; metadata?: Record<string, unknown> }
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('create', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      name: data.name,
      content: data.content,
      resources: data.resources,
      metadata: data.metadata,
    });
  },

  /** Soft delete (archive); requires owner agent_id + expected_version optimistic lock */
  delete: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number
  ): Promise<{ skill_id: string; archived: boolean }> => {
    const me = await getCurrentUser();
    return skillPost<{ skill_id: string; archived: boolean }>('delete', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
    });
  },

  /** Fully update the SKILL.md content; requires owner agent_id + expected_version */
  update: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number,
    content: string
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('update', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
      content,
    });
  },

  /** Team scope search skill */
  search: async (
    teamId: string,
    query: string,
    opts?: { topK?: number; scope?: 'team' }
  ): Promise<Array<SkillSummary & { score: number; snippet: string }>> => {
    const me = await getCurrentUser();
    const res = await skillPost<{ items: Array<SkillSummary & { score: number; snippet: string }> }>('search', {
      user_id: me.user_id,
      team_id: teamId,
      query,
      top_k: opts?.topK ?? 10,
      scope: opts?.scope ?? 'team',
    });
    return res.items;
  },

  /**
   * Fork skill to Agent —— Create an independent copy, `owner_agent_id` = target agent.
   *
   * Why use fork instead of meta authorization (acl/grant):
   *   - The "Fixed Assets" tab (SkillsPanel) filters and displays by `owner_agent_id`;
   *   - The `<available_skills>` (/skill/listing) injected during agent runtime is also filtered by
   *     `owner_agent_id`.
   * Both reads recognize `owner_agent_id`, while acl/grant only modify the meta authorization layer, which is ineffective for them.
   * Therefore, the only mechanism for a skill to truly belong to a specific agent is to copy a copy with owner=that agent.
   *
   * Name: the copy retains the **original name of the source skill**, without any suffix. The unique constraint for the skill is
   * (team_id, owner_agent_id, name): a single team allows multiple copies with the same name (belonging to different agents),
   * but duplicate names under the same agent will be rejected by the backend (42201) — in this case, throw an error upward, and let the caller prompt.
   *
   * Implement: getSkill (source body + manifest) → filesRead (per resource, skip on single failure) →
   *       create (name=original name, agent_id=target agent i.e. owner).
   */
  forkToAgent: async (
    teamId: string,
    sourceSkillId: string,
    targetAgentId: string
  ): Promise<SkillSummary> => {
    const detail = await skillApi.get(teamId, sourceSkillId);
    const resources: SkillResourcePayload[] = [];
    for (const entry of detail.manifest ?? []) {
      try {
        const f = await skillApi.filesRead(teamId, sourceSkillId, entry.path);
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type || undefined,
          is_executable: entry.is_executable || undefined,
        });
      } catch {
        /* If a single resource read fails, skip it and do not block the fork main flow */
      }
    }
    return skillApi.create(teamId, targetAgentId, {
      name: detail.name,
      content: detail.content,
      resources: resources.length ? resources : undefined,
      // Lineage: records which source skill it was forked from, for reverse lookup of the source from a copy and to avoid duplicate forks.
      metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
    });
  },
};
