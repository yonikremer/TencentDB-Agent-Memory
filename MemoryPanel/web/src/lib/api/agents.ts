/**
 * api/agents.ts — Agent management (meta/agent/* + meta/agent-fixed-asset/*).
 */
import { getPanelSession } from '../panelSession';
import { metaPost, metaListAll, getCurrentUser, request, ApiError } from './base';
import type { MetaEnvelope, Agent, AssetType, AssetStatus, FixedAssetBinding } from './types';

// ========================= Default Agent Template =========================

export interface AgentTemplateAssetIds {
  /** Team skill ID (skl-xxx) */
  skills?: string[];
  /** Team code graph ID (code-xxx) */
  code_graphs?: string[];
  /** Team wiki ID (wiki-xxx) */
  wikis?: string[];
}

/**
 * Default Agent template configuration (the template structure for agent/get-default-template / set-default-template).
 * Note:
 *   - asset_ids is a snapshot of team asset IDs; only public assets with visibility=team are allowed to be selected;
 *   - Overwrite write: when setting, the complete template must be returned in a single response;
 *   - metadata_json is a JSON string, and ui.role_prompt / ui.rules_prompt store the split prompts.
 */
export interface AgentTemplateConfig {
  name: string;
  description?: string | null;
  prompt?: string | null;
  /** 'private' | 'team'(default) | 'restricted' */
  visibility?: string;
  metadata_json?: string;
  asset_ids?: AgentTemplateAssetIds;
}

export const agentsApi = {
  /**
   * List the agents under team.
   *
   * @param teamId team ID
   * @param params.owner_user_id Optional: only return agents of this user owner ("agent private visibility" scenario,
   *    such as the Skill panel fixed assets tab); if not passed, return all team-wide. `agent/list` supports
   *   `team_id + owner_user_id` combined filtering.
   */
  list: (teamId: string, params?: { owner_user_id?: string }) =>
    metaListAll<Agent>('agent/list', {
      team_id: teamId,
      status: 'active',
      owner_user_id: params?.owner_user_id,
    }),

  /** agent details */
  get: (agentId: string) => metaPost<Agent>('agent/get', { agent_id: agentId }),

  /** Create agent */
  create: async (
    teamId: string,
    data: { name: string; description?: string; prompt?: string; visibility?: string }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Agent>('agent/create', {
      team_id: teamId,
      owner_user_id: me.user_id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      visibility: data.visibility ?? 'team',
    });
  },

  /**
   * Update agent.
   *
   * `metadata_json` is the fallback channel for frontend custom relationships: display fields where the backend schema is not implemented
   * (such as UI-only fields like icon / accent / related user, etc.) can be serialized into this custom namespace.
   */
  update: (
    agentId: string,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      visibility?: string;
      status?: string;
      metadata_json?: string;
    }
  ) => metaPost<Agent>('agent/update', { agent_id: agentId, ...data }),

  /**
   * Delete agent: go through business routing /api/v1/agent/delete-cascade.
   *
   * This route first processes all active skills of the current agent with owner_agent_id via skill/delete,
   * Only after all are successfully deleted does it call meta/agent/archive; if any skill deletion fails, the process is interrupted, and the agent is not archived,
   * It throws SKILL_DELETE_FAILED so the caller can display it to the user (with the deleted skill_ids and failed skill_id included in the error data),
   * When archiving, the backend also cleans up the chat_memory asset.
   */
  delete: async (agentId: string) => {
    const session = getPanelSession();
    if (!session) {
      throw new ApiError(401, 'Unauthorized', 'no active panel session');
    }
    const envelope = await request<MetaEnvelope<{
      archived: boolean;
      agent_id: string;
      deleted_skill_count: number;
      deleted_skill_ids: string[];
    }>>('POST', '/api/v1/agent/delete-cascade', { agent_id: agentId }, {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    });
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
  },

  /** Get the aggregated asset view of the agent (binding + asset details).
   *  Fetch the full list using metaListAll with pagination (list-with-detail defaults to a limit of 20, so it can be truncated when there are many bound assets).
   *
   *  applyVisibilityFilter: defaults to true (hides private bindings for normal display).
   *  When managing your own assets from the owner's perspective, pass false — otherwise your owner's private skills
   *   will be filtered out by the interface, causing the fixed tab to miss their visibility, and the share/private toggle button to disappear. */
  getAssets: async (agentId: string, applyVisibilityFilter = true) => {
    const items = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      name: string;
      description?: string;
      status: AssetStatus;
      visibility: string;
      injection_mode: FixedAssetBinding['injection_mode'];
      priority: number;
      created_at: string;
    }>('agent-fixed-asset/list-with-detail', {
      agent_id: agentId,
      apply_visibility_filter: applyVisibilityFilter,
      touch_usage: false,
    });
    return items.map((item) => ({
      asset_id: item.asset_id,
      asset_type: item.asset_type,
      name: item.name,
      description: item.description,
      status: item.status,
      visibility: item.visibility,
      injection_mode: item.injection_mode ?? 'direct',
      priority: item.priority,
      created_at: item.created_at,
    }));
  },

  /** Get agent fixed asset binding (only binding field) */
  getFixedAssets: async (agentId: string) => {
    const rows = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      injection_mode?: FixedAssetBinding['injection_mode'];
      priority: number;
    }>('agent-fixed-asset/list', { agent_id: agentId });
    return rows.map((r) => ({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      injection_mode: r.injection_mode,
      priority: r.priority,
    }));
  },

  /** Set all agent fixed assets */
  setFixedAssets: async (agentId: string, bindings: FixedAssetBinding[]) => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('agent-fixed-asset/set', {
      agent_id: agentId,
      bindings: bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 0,
        created_by: me.user_id,
      })),
    });
  },

  /**
   * Read the current team's default Agent template (isolated by instance × team, no permission checks).
   * When not configured, the backend returns `{}`, and the caller determines "not configured" by checking whether `data.name` exists.
   */
  getDefaultTemplate: (teamId: string) =>
    metaPost<AgentTemplateConfig>('agent/get-default-template', { team_id: teamId }),

  /**
   * Configure/override the current team's default Agent template (system_admin only, otherwise 403 permission_denied).
   * Overwrite write: must return the complete template in a single response.
   */
  setDefaultTemplate: (teamId: string, template: AgentTemplateConfig) =>
    metaPost<{ ok: boolean }>('agent/set-default-template', { team_id: teamId, template }),
};
