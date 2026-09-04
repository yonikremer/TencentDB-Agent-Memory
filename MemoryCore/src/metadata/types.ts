/**
 * Metadata module — Entity types & shared contracts.
 *
 * Corresponds to design doc 08-metadata-migration-and-permission-design.md §2 / §6.
 *
 * This contains metadata entity type definitions migrated from team-memory-control to memory core.
 * Unlike the simplified entity_* types in core/store, this is the full business model
 * (including user_key / password / visibility / acl, etc.).
 */

// ============================
// Enums and Literal Types
// ============================

export type UserStatus = "active" | "inactive" | "invited";
export type UserType = "normal" | "system_admin";
export type TeamStatus = "active" | "archived";
export type TeamRole = "admin" | "member" | "reviewer";
export type MemberStatus = "active" | "removed";
export type AgentStatus = "active" | "inactive";
export type TaskStatus = "running" | "completed";
export type TaskSourceType = "manual" | "tapd" | "github" | "other";

export type AssetType = "skill" | "llm_wiki" | "code_graph" | "chat_memory";
export type AssetVisibility = "private" | "team" | "restricted" | "agent" | "task";
export type AssetStatus =
  | "draft"
  | "candidate"
  | "approved"
  | "deprecated"
  | "archived"
  | "failed";

export type InjectionMode = "direct" | "summary" | "tool" | "reference";

/** Permission actions (6 categories). */
export type Permission =
  | "read"
  | "write"
  | "delete"
  | "assign"
  | "share"
  | "use";

/** ACL subject type. */
export type AclSubjectType = "user" | "team_role" | "agent";

/** ACL effect (Phase 1 allow only, deny reserved). */
export type AclEffect = "allow" | "deny";

// ============================
// Entity Types
// ============================

export type UserKeyStatus = "active" | "revoked";

export interface UserEntity {
  user_id: string;
  /** Scrypt+pepper hashed password (`$scrypt$...`), nullable. */
  password?: string | null;
  auth_provider: string;
  external_id: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json: string;
  status: UserStatus;
  user_type: UserType;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamMemberEntity {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
  status: MemberStatus;
}

/** team-member/list · get response: member relationship + username JOINed on read (not persisted). */
export interface TeamMemberView extends TeamMemberEntity {
  username: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility: AssetVisibility;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type: TaskSourceType;
  source_url?: string | null;
  status: TaskStatus;
  auto_assign_floating_assets: boolean;
  risk_level?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskAgentEntity {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string | null;
  status: MemberStatus;
  created_at: string;
}

/** Task/Agent participation event log (append-only). */
export interface ParticipationLogEntity {
  id: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AppendParticipationLogInput {
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  created_at?: string;
  source?: string;
  metadata_json?: string;
}

export interface ParticipationLogFilter {
  team_id: string;
  task_id?: string;
  agent_id?: string;
  user_id?: string;
  created_after?: string;
  created_before?: string;
  /** Whether to deduplicate by user_id; default false. */
  dedupe?: boolean;
}

export interface AssetEntity {
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  version: number;
  visibility: AssetVisibility;
  status: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  usage_count: number;
  content_ref?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface FixedAssetBindingEntity {
  id: string;
  agent_id: string;
  asset_id: string;
  asset_type: AssetType;
  injection_mode: InjectionMode;
  priority: number;
  created_by: string;
  created_at: string;
}

/** Fixed asset binding count aggregated by asset_type (distinct asset_id). */
export interface FixedAssetTypeCounts {
  skill: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

/** Fixed asset allocation summary for a single agent. */
export interface AgentFixedAssetSummary {
  agent_id: string;
  counts: FixedAssetTypeCounts;
  /** Total count of matching binding rows for this agent (non-deduplicated). */
  total: number;
}

/** summary-by-agents response. */
export interface AgentFixedAssetSummaryResult {
  items: AgentFixedAssetSummary[];
  total: number;
}

/** Store/Service: aggregate fixed asset bindings grouped by multiple agents. */
export interface SummarizeAgentFixedAssetsParams {
  agent_ids: string[];
  /** Optional: count only rows bound to this asset; used for bound_agent_count. */
  asset_id?: string;
}

/** Store layer raw aggregated row (unpadded). */
export interface AgentFixedAssetCountRow {
  agent_id: string;
  asset_type: AssetType;
  cnt: number;
}

/** User API key row (storage layer, contains full key_value). */
export interface UserKeyEntity {
  key_id: string;
  user_id: string;
  key_value: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  metadata_json: string;
}

/** API sanitized structure (list / get). */
export interface UserKeyPublic {
  key_id: string;
  user_id: string;
  key_prefix: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
}

/** create response: returns full key_value once only. */
export interface UserKeyCreated extends UserKeyPublic {
  key_value: string;
}

export interface AclEntity {
  id: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect: AclEffect;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

// ============================
// Input Types (Create/Update)
// ============================

export interface UserPublic {
  user_id: string;
  user_type: UserType;
  username: string;
  created_at: string;
}

/** Public user/list optional filter (internal list-by-instance additionally contains status / user_type). */
export interface UserListFilter {
  user_ids?: string[];
  /** Exact username match (used for deduplication, etc.). */
  username?: string;
}

/** user/create response: does not contain username (see 08 §CreateUserResult). */
export interface CreateUserApiResult {
  user_id: string;
  user_type: UserType;
  created_at: string;
  default_user_key: string;
}

export interface InitAdminInput {
  username: string;
  user_key?: string;
}

export interface InitAdminResult {
  user_id: string;
  user_key: string;
}

export interface CreateUserInput {
  user_id?: string;
  /** Internal: init-admin can specify default user_key. */
  default_key_value?: string;
  /** Storage layer default `local` (not exposed by API). */
  auth_provider?: string;
  /** Storage layer default `user_id` (not exposed by API). */
  external_id?: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json?: string;
  status?: UserStatus;
  metadata_json?: string;
  /** Storage layer internal use only; API create fixed normal, init-admin fixed system_admin. */
  user_type?: UserType;
  /** v3.1: Always NULL for new users; written by store layer only. */
  password?: string | null;
}

export interface CreateUserKeyInput {
  user_id: string;
  key_value?: string;
  name?: string | null;
  expires_at?: string | null;
  is_default?: boolean;
  metadata_json?: string;
}

export interface CreateTeamInput {
  team_id?: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status?: TeamStatus;
  metadata_json?: string;
}

export interface AddTeamMemberInput {
  id?: string;
  team_id: string;
  user_id: string;
  role?: TeamRole;
  status?: MemberStatus;
}

export interface CreateAgentInput {
  agent_id?: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: AssetVisibility;
  status?: AgentStatus;
  metadata_json?: string;
}

export interface CreateTaskInput {
  task_id?: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type?: TaskSourceType;
  source_url?: string | null;
  status?: TaskStatus;
  auto_assign_floating_assets?: boolean;
  risk_level?: string | null;
  metadata_json?: string;
  /** Agents that can be linked simultaneously when creating a task. */
  linked_agents?: Array<{ agent_id: string; role_in_task?: string }>;
}

export interface CreateAssetInput {
  /** Provided by caller (external asset system), metadata module only logs and checks permission, does not generate asset_id. */
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  visibility?: AssetVisibility;
  status?: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  content_ref?: string | null;
  metadata_json?: string;
}

export interface FixedAssetBindingInput {
  asset_id: string;
  asset_type: AssetType;
  injection_mode?: InjectionMode;
  priority?: number;
  created_by: string;
}

export interface GrantAclInput {
  id?: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect?: AclEffect;
  granted_by: string;
}

// ============================
// Filter Types
// ============================

export interface AgentFilter {
  status?: AgentStatus;
  /**
   * Combined filter: when used with team_id indicates "agents owned by a user within the team".
   * Using owner_user_id alone routes to listAgentsByOwner, does not require team_id.
   */
  owner_user_id?: string;
  /** Exact match for agent name (used for deduplication, etc.). */
  name?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  creator_user_id?: string;
  /** Exact match for task title (used for deduplication, etc.). */
  title?: string;
}

/** team/list optional filter (used for deduplication, etc.). */
export interface TeamFilter {
  /** Exact match for team name. */
  name?: string;
}

export interface AssetFilter {
  asset_type?: AssetType;
  status?: AssetStatus;
  owner_user_id?: string;
  visibility?: AssetVisibility;
}

// ============================
// Common Result Types
// ============================

/** list API pagination input parameters (optional; defaults to limit=20, offset=0 on server if omitted). */
export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** Parsed pagination parameters (both limit and offset have concrete values). */
export interface PaginationParams {
  limit: number;
  offset: number;
}

/** list API pagination response envelope. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Store layer list query result (internal pagination slice + total count). */
export interface ListPage<T> {
  items: T[];
  total: number;
}

/** internal list-by-instance optional filter (extends UserListFilter). */
export interface InstanceUserListFilter extends UserListFilter {
  status?: UserStatus;
  user_type?: UserType;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

// ============================
// ConfigParam Types
// ============================

export type ConfigParamScope = "global" | "user";

export interface ConfigParamEntity {
  id: number;
  scope: ConfigParamScope;
  user_id: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertConfigParamInput {
  scope: ConfigParamScope;
  user_id?: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
}

export interface ListConfigParamsFilter {
  scope?: ConfigParamScope;
  module: string;
  userId?: string;
  paramNames?: string[];
}
