/**
 * backendStore.ts — Team / Agent / Task backend data layer (Pipeline A).
 *
 * Replace the original localStorage implementation for team/agent/task in demoStore.ts:
 *   - Team     uses teamApi.teamsApi + teamApi.membersApi
 *   - Agent    uses teamApi.agentsApi
 *   - Task     uses teamApi.tasksApi
 *
 * UI-specific fields not present in the backend schema (icon / accent / role_prompt / rules_prompt /
 * skills / code_graphs / llm_wikis / chat_memories / task.participants, etc.)
 * are uniformly serialized into the "ui" namespace of agent.metadata_json / task.metadata_json,
 * ensuring these fields are not lost after refreshing the page — once the corresponding assets/fields are
 * implemented on the backend, just replace the read/write targets in readXxxUiMeta / writeXxxUiMeta with the real fields, no component changes needed.
 *
 * Caching strategy:
 *   - Module-level cache + in-flight promise deduplication: multiple simultaneous useTeams()/useAgents() only send one request;
 *   - invalidateBackendCache(): called after all write operations, clears the cache and broadcasts BACKEND_REFRESH_EVENT;
 *   - useTeams/useAgents/useTasks listen to this event to automatically refetch.
 */

import {
  tasksApi,
  type Team as BackendTeam,
  type Agent as BackendAgent,
  type TeamMember as BackendMember,
  type BackendTask,
} from '@/lib/teamApi';
import { invalidateBackendCache } from '@/stores/backend';

// ========================= Types (Frontend display shapes, try to align with the old demoStore, minimize changes to callers) =========================

export interface TeamMember {
  user_id: string;
  role: 'admin' | 'member' | 'reviewer';
  joined_at_ms: number;
  username?: string;
}

export interface Team {
  team_id: string;
  name: string;
  description: string;
  owner_user_id: string;
  created_at_ms: number;
  members: TeamMember[];
}

export interface Agent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description: string;
  role_prompt: string;
  rules_prompt: string;
  icon: string;
  accent: 'blue' | 'purple' | 'orange' | 'emerald' | 'rose' | 'slate';
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
  /** Backend metadata_json pass-through (when writing back, merge with the old value rather than overwriting entirely) */
  metadata_json?: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export type TaskStatus = 'running' | 'completed';
export type TaskSourceType = 'manual' | 'tapd';

export interface Task {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  participants: string[];
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
  status: TaskStatus;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json?: string;
}

// ========================= metadata_json fallback read/write ("ui" namespace) =========================

interface AgentUiMeta {
  role_prompt: string;
  rules_prompt: string;
  icon: string;
  accent: Agent['accent'];
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
}

const ACCENT_CYCLE: Agent['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
const ICON_CYCLE = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];

function defaultAgentUiMeta(index: number): AgentUiMeta {
  return {
    role_prompt: '',
    rules_prompt: '',
    icon: ICON_CYCLE[index % ICON_CYCLE.length],
    accent: ACCENT_CYCLE[index % ACCENT_CYCLE.length],
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
  };
}

function readAgentUiMeta(metadataJson: string | undefined, index: number): AgentUiMeta {
  const fallback = defaultAgentUiMeta(index);
  if (!metadataJson) return fallback;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const slot = meta?.ui;
    if (slot && typeof slot === 'object') {
      return { ...fallback, ...(slot as Partial<AgentUiMeta>) };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** Merge the ui-specific fields into metadata_json (preserving other namespaces, such as chat_memory). */
export function writeAgentUiMeta(prevMetadataJson: string | undefined, patch: Partial<AgentUiMeta>): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* Invalid old value, discard directly */
    }
  }
  const prevUi = (meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) as Partial<AgentUiMeta>;
  meta.ui = { ...prevUi, ...patch };
  return JSON.stringify(meta);
}

interface TaskUiMeta {
  participants: string[];
}

function readTaskUiMeta(metadataJson: string | undefined, fallbackParticipant: string): TaskUiMeta {
  const fallback: TaskUiMeta = { participants: fallbackParticipant ? [fallbackParticipant] : [] };
  if (!metadataJson) return fallback;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const slot = meta?.ui as Partial<TaskUiMeta> | undefined;
    if (slot && Array.isArray(slot.participants)) {
      return { participants: Array.from(new Set([...(slot.participants as string[]), fallbackParticipant].filter(Boolean))) };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function writeTaskUiMeta(prevMetadataJson: string | undefined, patch: Partial<TaskUiMeta>): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }
  const prevUi = (meta.ui && typeof meta.ui === 'object' ? meta.ui : {}) as Partial<TaskUiMeta>;
  meta.ui = { ...prevUi, ...patch };
  return JSON.stringify(meta);
}

// ========================= Adapters (exported for use by stores/backend.ts) =========================

export function adaptTeam(bt: BackendTeam, members: TeamMember[]): Team {
  return {
    team_id: bt.team_id,
    name: bt.name,
    description: bt.description ?? '',
    owner_user_id: bt.owner_user_id,
    created_at_ms: new Date(bt.created_at).getTime(),
    members,
  };
}

export function adaptMember(bm: BackendMember): TeamMember {
  return {
    user_id: bm.user_id,
    role: bm.role,
    joined_at_ms: new Date(bm.joined_at).getTime(),
    username: bm.username,
  };
}

export function adaptAgent(ba: BackendAgent, index: number): Agent {
  const ui = readAgentUiMeta(ba.metadata_json, index);
  // prompt fallback: when metadata_json does not contain ui.role_prompt (the agent may be created directly via a backend API,
  // rather than through the frontend UI), fall back to the backend prompt field. The prompt is the complete text combining role+rules,
  // and when there is no ui splitting, it is placed entirely into role_prompt, while rules_prompt remains empty.
  const rolePrompt = ui.role_prompt || ba.prompt || '';
  return {
    agent_id: ba.agent_id,
    team_id: ba.team_id,
    owner_user_id: ba.owner_user_id,
    name: ba.name,
    description: ba.description ?? '',
    role_prompt: rolePrompt,
    rules_prompt: ui.rules_prompt,
    icon: ui.icon,
    accent: ui.accent,
    // Asset binding is no longer read from metadata_json.ui (the .ui is deprecated as the asset storage).
    // Real binding reads skill table owner_agent_id / agent-fixed-asset table:
    // list count goes through agent-overview/bootstrap.counts, detail popup goes through skillApi.listByAgent
    // + knowledgeApi.agentFixed + chatMemoryApi.agentFixed. These fields are retained only for type compatibility.
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    metadata_json: ba.metadata_json,
    created_at_ms: new Date(ba.created_at).getTime(),
    updated_at_ms: new Date(ba.updated_at).getTime(),
  };
}

function normalizeTaskStatus(backend: BackendTask['status']): TaskStatus {
  return backend === 'completed' ? 'completed' : 'running';
}

export function adaptTask(bt: BackendTask, linkedAgents: string[]): Task {
  const ui = readTaskUiMeta(bt.metadata_json, bt.creator_user_id);
  return {
    task_id: bt.task_id,
    team_id: bt.team_id,
    creator_user_id: bt.creator_user_id,
    participants: ui.participants,
    title: bt.title,
    description: bt.description ?? '',
    source_type: bt.source_type === 'tapd' ? 'tapd' : 'manual',
    source_url: bt.source_url ?? '',
    linked_agents: linkedAgents,
    status: normalizeTaskStatus(bt.status),
    created_at_ms: new Date(bt.created_at).getTime(),
    updated_at_ms: new Date(bt.updated_at).getTime(),
    metadata_json: bt.metadata_json,
  };
}

// ========================= Active team id (Client UI state, persisted in localStorage) =========================

const ACTIVE_TEAM_KEY = 'tdai-memory.activeTeam.v1';
const LOCAL_CHANGE_EVENT = 'tdai-memory.demo-store-change';

export function readActiveTeamId(): string | null {
  try { return localStorage.getItem(ACTIVE_TEAM_KEY); } catch { return null; }
}

export function writeActiveTeamId(teamId: string | null): void {
  try {
    if (teamId) localStorage.setItem(ACTIVE_TEAM_KEY, teamId);
    else localStorage.removeItem(ACTIVE_TEAM_KEY);
  } catch { /* ignore */ }
  try { window.dispatchEvent(new Event(LOCAL_CHANGE_EVENT)); } catch { /* ignore */ }
}

/** After the teams are loaded, ensure that activeTeamId points to a valid team (otherwise select the first / clear). */
export function ensureValidActiveTeamId(teams: Team[]): void {
  const cur = readActiveTeamId();
  if (cur && teams.some((t) => t.team_id === cur)) return;
  if (teams.length === 0) {
    if (cur) writeActiveTeamId(null);
    return;
  }
  writeActiveTeamId(teams[0].team_id);
}

// ========================= Hooks & cache (migrated to stores/backend.ts) =========================
//
// The old module-level variables (_cachedTeams / _cachedAgentsMap / _inflightTeams ...) have all been
// migrated to the zustand store (stores/backend.ts), reading data and triggering fetch via useTeams / useAgents / useTasks
// from the store, so multiple components share the same state and no longer make repeated requests.
//
// invalidateBackendCache / clearBackendCache are also provided by the new store, so they are re-exported here
// to keep callers from needing to change their import paths.

export {
  useTeams,
  useAgents,
  useTasks,
  readActiveTeamAgents,
  invalidateBackendCache,
  clearBackendCache,
  invalidateTeamCache,
} from '@/stores/backend';

// ========================= Permissions =========================

export function roleInTeam(team: Team | null | undefined, userId: string): 'admin' | 'member' | 'reviewer' | null {
  if (!team) return null;
  const member = team.members.find((m) => m.user_id === userId);
  if (member) return member.role;
  // If the team owner is not in the members list (the backend owner may not appear in the members array),
  // it is treated as a 'member' by default — the owner can manage resources within the team and should be able to see the resource page.
  // 'admin' is not returned because the 'admin' returned by useCurrentRole has the semantics of "global admin" (cannot see the resource page),
  // and team owner is not a global admin, so it should not be locked by AdminResourceLock.
  if (team.owner_user_id === userId) return 'member';
  return null;
}

export function isTeamAdmin(team: Team | null | undefined, userId: string): boolean {
  if (!team) return false;
  if (team.owner_user_id === userId) return true;
  return team.members.some((m) => m.user_id === userId && m.role === 'admin');
}

export function isTeamMember(team: Team | null | undefined, userId: string): boolean {
  return roleInTeam(team, userId) !== null;
}

export function canManageAsset(
  asset: { owner_user_id: string; team_id: string },
  team: Team | null | undefined,
  userId: string,
  _isGlobalAdminFlag?: boolean
): boolean {
  if (!userId) return false;
  // admin no longer has global privileges, consistent with member: can only operate assets of their own owner.
  if (asset.owner_user_id === userId) return true;
  if (team && team.team_id === asset.team_id && isTeamAdmin(team, userId)) return true;
  return false;
}

export function canEditTask(task: Task, team: Team | null | undefined, userId: string): boolean {
  if (!userId) return false;
  if (!team || team.team_id !== task.team_id) return false;
  return isTeamMember(team, userId);
}

export function canDeleteTask(task: Task, team: Team | null | undefined, userId: string): boolean {
  return canManageAsset({ owner_user_id: task.creator_user_id, team_id: task.team_id }, team, userId);
}

// ========================= Task mutations (async, wrapping with diff/participant logic) =========================

export async function createTaskAsync(input: {
  team_id: string;
  creator_user_id: string;
  title: string;
  description: string;
  source_type: TaskSourceType;
  source_url: string;
  linked_agents: string[];
}): Promise<Task> {
  const created = await tasksApi.create(input.team_id, {
    title: input.title,
    description: input.description,
    source_type: input.source_type,
    source_url: input.source_url || undefined,
    linked_agents: input.linked_agents.length > 0 ? input.linked_agents : undefined,
  });
  invalidateBackendCache();
  return adaptTask(created, input.linked_agents);
}

export async function deleteTaskAsync(taskId: string): Promise<void> {
  await tasksApi.delete(taskId);
  invalidateBackendCache();
}

export async function updateTaskStatusAsync(taskId: string, status: TaskStatus, actorUserId?: string): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (actorUserId) {
    // Participant trace: read the current task details once, merge the actor into participants, then write back to metadata_json
    try {
      const current = await tasksApi.get(taskId);
      const ui = readTaskUiMeta(current.metadata_json, current.creator_user_id);
      if (!ui.participants.includes(actorUserId)) {
        patch.metadata_json = writeTaskUiMeta(current.metadata_json, {
          participants: [...ui.participants, actorUserId],
        });
      }
    } catch { /* Participant trace failure does not block state switching */ }
  }
  await tasksApi.update(taskId, patch as Parameters<typeof tasksApi.update>[1]);
  invalidateBackendCache();
}

export async function updateTaskAsync(
  taskId: string,
  patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>,
  actorUserId?: string
): Promise<void> {
  const current = await tasksApi.get(taskId);
  const updatePayload: Record<string, unknown> = {};
  if (patch.title !== undefined) updatePayload.title = patch.title;
  if (patch.description !== undefined) updatePayload.description = patch.description;
  if (patch.source_url !== undefined) updatePayload.source_url = patch.source_url;

  const ui = readTaskUiMeta(current.metadata_json, current.creator_user_id);
  const nextParticipants = actorUserId && !ui.participants.includes(actorUserId)
    ? [...ui.participants, actorUserId]
    : ui.participants;
  if (nextParticipants !== ui.participants) {
    updatePayload.metadata_json = writeTaskUiMeta(current.metadata_json, { participants: nextParticipants });
  }
  if (Object.keys(updatePayload).length > 0) {
    await tasksApi.update(taskId, updatePayload as Parameters<typeof tasksApi.update>[1]);
  }

  if (patch.linked_agents) {
    const before = new Set(current.agents.filter((a) => a.status === 'active').map((a) => a.agent_id));
    const after = new Set(patch.linked_agents);
    const toLink = [...after].filter((id) => !before.has(id));
    const toUnlink = [...before].filter((id) => !after.has(id));
    await Promise.all([
      ...toLink.map((id) => tasksApi.linkAgent(taskId, id)),
      ...toUnlink.map((id) => tasksApi.unlinkAgent(taskId, id)),
    ]);
  }
  invalidateBackendCache();
}
