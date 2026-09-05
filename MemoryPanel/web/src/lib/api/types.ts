/**
 * api/types.ts — Shared type definitions across modules.
 *
 * Only place types referenced by more than 2 API modules; place types exclusive to a single module near their corresponding module file.
 */

/** meta / control envelope format */
export interface MetaEnvelope<T> {
  code: number;
  message: string;
  request_id: string;
  data: T | null;
}

/** Kernel paging response (task/list, agent/list, etc.) */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * The common user structure returned by `auth/verify`, `user/get`, and `user/list`.
 * `user_type === 'system_admin'` is the sole authoritative field for determining whether the current logged-in user is an admin.
 */
export interface PublicUser {
  user_id: string;
  auth_provider: string;
  external_id: string;
  username: string;
  display_name?: string;
  email?: string;
  status: 'active' | 'inactive' | 'invited';
  created_at: string;
  updated_at: string;
  /**
   * Global user type (returned by auth/verify, user/get, user/list),
   * 'system_admin' = the globally unique admin identity, independent of team; the rest (e.g., 'user') are regular users.
   * This is the sole authoritative field for determining "whether the currently logged-in user is an admin" — do not use username === 'admin' as a fallback guess.
   */
  user_type?: 'system_admin' | 'user' | string;
}

export interface Team {
  team_id: string;
  name: string;
  description?: string;
  owner_user_id: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'admin' | 'member' | 'reviewer';
  joined_at: string;
  status: 'active' | 'removed';
  /** team-member/list · get response includes (read-time JOIN) */
  username?: string;
}

export interface Agent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string;
  prompt?: string;
  visibility: 'private' | 'task' | 'agent' | 'team' | 'restricted';
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export type AssetType = 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';
export type AssetStatus = 'draft' | 'candidate' | 'approved' | 'deprecated' | 'archived';

export interface Asset {
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string;
  owner_user_id: string;
  source_type: 'uploaded' | 'url' | 'extracted' | 'synced';
  source_ref?: string;
  version: number;
  visibility: 'private' | 'task' | 'agent' | 'team' | 'restricted';
  status: AssetStatus;
  confidence?: number;
  expires_at?: string;
  last_used_at?: string;
  usage_count: number;
  content_ref?: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface AgentAssetView {
  asset_id: string;
  asset_type: AssetType;
  name: string;
  description?: string;
  status: AssetStatus;
  visibility: string;
  injection_mode: 'direct' | 'summary' | 'tool' | 'reference';
  priority: number;
  created_at: string;
}

export interface FixedAssetBinding {
  asset_id: string;
  asset_type: AssetType;
  injection_mode?: 'direct' | 'summary' | 'tool' | 'reference';
  priority?: number;
}
