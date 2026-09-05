/**
 * api/tasks.ts — Task + ParticipationLog（meta/task/* + meta/task-agent/* + meta/participation-log/*）。
 */
import { getPanelSession } from '../panelSession';
import { metaPost, metaListAll, getCurrentUser, request, ApiError } from './base';
import type { MetaEnvelope } from './types';

export type TaskStatus = 'running' | 'completed';
export type TaskSourceType = 'manual' | 'tapd' | 'github' | 'other';

export interface BackendTask {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string;
  source_type: TaskSourceType;
  source_url?: string;
  status: TaskStatus;
  auto_assign_floating_assets: number;
  risk_level?: 'low' | 'medium' | 'high';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface BackendTaskAgent {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string;
  status: 'active' | 'removed';
  created_at: string;
}

export interface BackendTaskWithAgents extends BackendTask {
  agents: BackendTaskAgent[];
}

export const tasksApi = {
  /** List all tasks under team */
  list: (teamId: string) => metaListAll<BackendTask>('task/list', { team_id: teamId }),

  /** Get task details (including linked agents) */
  get: async (taskId: string) => {
    const task = await metaPost<BackendTask>('task/get', { task_id: taskId });
    const agents = await metaListAll<BackendTaskAgent>('task-agent/list', { task_id: taskId });
    return { ...task, agents };
  },

  /**
   * Batch fetch tasks and their linked agents under team (Panel layer aggregation interface).
   *
   * Backend pagination: pass limit + offset, Panel passes it through to the kernel task/list,
   * The kernel only returns the current page's tasks + the full total. Panel then fetches linked_agents in parallel.
   * The frontend only receives the data for the current page, and memory and rendering only handle one page.
   */
  listWithAgents: async (
    teamId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{ items: BackendTaskWithAgents[]; total: number }> => {
    const session = getPanelSession();
    if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
    const body: Record<string, unknown> = { team_id: teamId };
    if (params?.limit) body.limit = params.limit;
    if (params?.offset != null) body.offset = params.offset;
    const envelope = await request<MetaEnvelope<{ items: BackendTaskWithAgents[]; total: number }>>(
      'POST',
      '/api/v1/task/list-with-agents',
      body,
      {
        'X-Tdai-Service-Id': session.instanceId,
        'X-Tdai-User-Key': session.userKey,
      },
    );
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
    return { items: envelope.data?.items ?? [], total: envelope.data?.total ?? 0 };
  },

  /** Create task */
  create: async (
    teamId: string,
    data: {
      title: string;
      description?: string;
      source_type?: TaskSourceType;
      source_url?: string;
      risk_level?: 'low' | 'medium' | 'high';
      linked_agents?: string[];
    }
  ) => {
    const me = await getCurrentUser();
    return metaPost<BackendTask>('task/create', {
      team_id: teamId,
      creator_user_id: me.user_id,
      title: data.title,
      description: data.description,
      source_type: data.source_type ?? 'manual',
      source_url: data.source_url,
      risk_level: data.risk_level,
      linked_agents: data.linked_agents?.map((agent_id) => ({ agent_id })),
    });
  },

  /** Update task (title / status / description / risk_level / source_url) */
  update: (
    taskId: string,
    data: Partial<{
      title: string;
      description: string;
      status: TaskStatus;
      risk_level: 'low' | 'medium' | 'high';
      source_url: string;
    }>
  ) => metaPost<BackendTask>('task/update', { task_id: taskId, ...data }),

  /** Delete task (meta task/delete, field is task_ids array) */
  delete: async (taskId: string) => {
    await metaPost<{ deleted_ids: string[] }>('task/delete', { task_ids: [taskId] });
  },

  /** Associated agent */
  linkAgent: (taskId: string, agentId: string, roleInTask?: string) =>
    metaPost<BackendTaskAgent>('task-agent/link', {
      task_id: taskId,
      agent_id: agentId,
      role_in_task: roleInTask,
    }),

  /** Remove agent association */
  unlinkAgent: async (taskId: string, agentId: string) => {
    await metaPost<{ ok: boolean }>('task-agent/unlink', { task_id: taskId, agent_id: agentId });
  },
};

// ========================= Participation Logs（meta/participation-log/*）=========================
//
// When the Session starts, an event (team, task, agent, user) is appended; the board uses it to
// Display "Actual Participating User / Agent". Complementary in semantics with `task-agent/link` (manually declared relationship):
//   - `linked_agents` = intent (who should do this task)
//   - participation_log = observation (who actually started a session)
//
// Backend `dedupe:true` only applies to user_id, and the agent dimension needs to be deduped by the frontend.

export interface ParticipationLogEntity {
  id?: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source?: string;
  metadata_json?: string;
  created_at?: string;
}

export const participationLogsApi = {
  /**
   * Fetch the original participation logs for the specified task (do not go through the kernel `dedupe` — it only deduplicates by user_id, which will lose
   * agent dimension information). The calling side dedupes by user_id / agent_id respectively to obtain two display lists.
   */
  listByTask: (teamId: string, taskId: string) =>
    metaListAll<ParticipationLogEntity>('participation-log/list', {
      team_id: teamId,
      task_id: taskId,
    }),

  /**
   * Fetch the raw participation logs for all tasks under team. The list page uses a single request to cover N tasks'
   * Statistics, avoiding fanout; the frontend buckets by task_id and then dedupes each separately.
   */
  listByTeam: (teamId: string) =>
    metaListAll<ParticipationLogEntity>('participation-log/list', {
      team_id: teamId,
    }),
};
