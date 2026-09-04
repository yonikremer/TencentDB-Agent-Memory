/**
 * MetadataService - Metadata business orchestration layer.
 *
 * Corresponds to design doc §2 / §7 / §10. Overlays business constraints on top of IMetadataStore:
 *   - createAgent/createTask/createAsset verifies team existence
 *   - createTask linkAgents verifies agent belongs to the same team
 *   - setAgentFixedAssets uses canBindAsset to verify visibility
 *   - listAgentFixedAssetsWithDetail aggregates agent + detail + (optional) visibility filter + touchUsage
 *   - checkAssetPermission lazy loads ACL (bypasses table lookup when role defaults cover it)
 *   - user_key generation/refresh
 *
 * Agnostic to specific backend (SQLite / MongoDB), ensuring storage is switchable.
 */

import { DuplicateUserKeyError, type IMetadataStore } from "../store/interface.js";
import {
  checkPermission,
  canBindAsset,
  roleDefaultCovers,
  type PermCheckResult,
  type PermCheckLogger,
} from "./permission-checker.js";
import {
  maskUserKey, isUserKeyExpired, DEFAULT_MAX_ACTIVE_USER_KEYS,
} from "../utils/user-key.js";
import {
  lookupMemorySystemUser,
  isMemorySystemUserKey,
  toMemorySystemVerifyUser,
  type MemorySystemUserConfig,
} from "../system-user.js";
import { resolveUserId } from "./resolve-user-id.js";
import type { V3AuthContext } from "../router/auth.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_AUTH_PROVIDER } from "../constants.js";
import {
  canManageUsers,
  canViewUser,
  filterVisibleUsers,
  isSystemAdminUser,
  toPublicUser,
} from "./user-visibility.js";
import type {
  UserEntity,
  UserPublic,
  UserKeyEntity,
  UserKeyPublic,
  UserKeyCreated,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AgentFixedAssetSummary,
  AgentFixedAssetSummaryResult,
  FixedAssetTypeCounts,
  SummarizeAgentFixedAssetsParams,
  AclEntity,
  CreateUserInput,
  InitAdminInput,
  InitAdminResult,
  CreateUserApiResult,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  AssetFilter,
  BatchDeleteResult,
  AssetType,
  AssetVisibility,
  AssetStatus,
  InjectionMode,
  Permission,
  UserType,
  PaginatedResult,
  PaginationParams,
  InstanceUserListFilter,
  UserListFilter,
} from "../types.js";
import { formatListResult, paginateArray, resolvePagination, wrapPaginated, DEFAULT_PAGINATION } from "../pagination.js";
import { generateId, ID_PREFIX } from "../utils/id-generator.js";
import { buildChatMemoryAssetId, resolveChatMemoryAgentId } from "../utils/chat-memory-asset.js";

// ── Default Agent / Team Constants ──

const DEFAULT_TEAM_NAME = "default-team";
const DEFAULT_TEAM_DESCRIPTION = "Default team created automatically upon system initialization, used to store default agents";

const DEFAULT_AGENT_NAME = "default-agent";
const DEFAULT_AGENT_DESCRIPTION = "Default agent, can handle common development tasks and daily collaboration.";

// prompt concatenation format is identical to frontend manual Agent creation:
// [card.rolePrompt, card.rulesPrompt].filter(Boolean).join('\n\n')
const DEFAULT_AGENT_ROLE_PROMPT = "";
const DEFAULT_AGENT_RULES_PROMPT = "";
const DEFAULT_AGENT_PROMPT = [DEFAULT_AGENT_ROLE_PROMPT, DEFAULT_AGENT_RULES_PROMPT]
  .filter(Boolean)
  .join("\n\n");

// metadata_json stores the split role_prompt / rules_prompt,
// format matches the 'ui' namespace in frontend writeAgentUiMeta / readAgentUiMeta,
// ensuring that 'Role Positioning prompt' and 'Rule Fixing prompt' are displayed separately on the Agent details page.
const DEFAULT_AGENT_METADATA_JSON = JSON.stringify({
  ui: {
    role_prompt: DEFAULT_AGENT_ROLE_PROMPT,
    rules_prompt: DEFAULT_AGENT_RULES_PROMPT,
  },
});

/** Business validation error, with code mappable to HTTP status. */
export class MetadataError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MetadataError";
  }
}

/**
 * Clears the chat_memory content (L0/L1/L2/L3 + vectors + files) for a specific (team, agent).
 *
 * Implemented and injected by gateway assembly (see MetadataService.setChatMemoryContentCleaner),
 * because content is stored in IMemoryStore / StorageAdapter, not in metadata store.
 */
export type ChatMemoryContentCleaner = (params: {
  teamId: string;
  agentId: string;
}) => Promise<void>;

/** Detect unique constraint violation (SQLite UNIQUE or MongoDB E11000) on a specific column. */
function isUniqueViolation(err: unknown, column?: string): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (/UNIQUE constraint failed/.test(msg)) {
    return column ? msg.includes(column) : true;
  }
  if ((err as any).code === 11000) {
    if (!column) return true;
    const kp = (err as any).keyPattern;
    return kp ? column in kp : msg.includes(column);
  }
  return false;
}

export interface AgentBasicData {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  prompt: string | null;
  visibility: AssetVisibility;
  status: string;
}

export interface AgentAssetView {
  asset_id: string;
  asset_type: AssetType;
  name: string;
  description: string | null;
  status: AssetStatus;
  visibility: AssetVisibility;
  injection_mode: InjectionMode;
  priority: number;
  created_at: string;
}

export interface ListWithDetailParams {
  agent_id: string;
  apply_visibility_filter?: boolean;
  touch_usage?: boolean;
  limit?: number;
  offset?: number;
  /** Optional type filter: only return asset_type matching this list; omitted / empty array = no filter. */
  asset_types?: Array<"skill" | "llm_wiki" | "code_graph" | "chat_memory">;
}

export interface AgentFixedAssetDetailResult {
  agent: AgentBasicData;
  items: AgentAssetView[];
  total: number;
  limit: number;
  offset: number;
}

export interface CheckPermissionParams {
  user_id?: string;
  user_key?: string;
  asset_id: string;
  action: Permission;
  agent_id?: string;
}

export interface ListAccessibleAssetsParams {
  user_id?: string;
  user_key?: string;
  team_id?: string;
  action?: Permission;
  asset_type?: AssetType;
  agent_id?: string;
  /**
   * Optional visibility whitelist, used for secondary filtering after permission check.
   * Example: `["team"]` = only return team visible (used for management page "team assets" tab);
   * omitted = return all accessible (including own private).
   * Purpose: Prevents frontend from getting unneeded data in the HTTP response (security + reduced payload).
   */
  visibility?: AssetEntity["visibility"] | AssetEntity["visibility"][];
  limit?: number;
  offset?: number;
}

const FILTERED_STATUSES: AssetStatus[] = ["archived", "deprecated", "failed"];

export interface MetadataQuotaLimits {
  maxUsersPerInstance: number;
  maxTeamsPerInstance: number;
}

export const DEFAULT_METADATA_QUOTA_LIMITS: MetadataQuotaLimits = {
  maxUsersPerInstance: 500,
  maxTeamsPerInstance: 100,
};

export class MetadataService {
  private readonly quota: MetadataQuotaLimits;
  private readonly memorySystemUser?: MemorySystemUserConfig;
  private _configParams?: import("./config-param-service.js").IConfigParamService;

  /**
   * In-process LRU cache: set of confirmed chat_memory asset ids (existing in store).
   *
   * A hit skips three DB roundtrips: getAssetById + createAsset + addAgentFixedAsset.
   * A miss goes through the full ensure process and writes to cache upon success. Across processes/pods, each maintains its own
   * LRU — consistency is guaranteed by store primary key constraints.
   *
   * Uses Map insertion order + evicts oldest item when limit reached. Not strictly LRU (no touch upon read),
   * but sufficient for this 'write once, hit forever' scenario: once confirmed existing, the entry either continues
   * to hit or gets pushed out by newer team+agent and goes through DB again — cold eviction cost is just one DB query.
   * maxSize is controlled by CHAT_MEMORY_ENSURE_CACHE_SIZE.
   */
  private readonly ensuredChatMemoryAssets = new Map<string, true>();
  private static readonly CHAT_MEMORY_ENSURE_CACHE_SIZE = 4096;

  /**
   * In-process LRU for skill asset registration: key = skill_id (i.e. asset_id).
   * Semantics identical to ensuredChatMemoryAssets, short-circuits repeated create+bind in ensureSkillAsset.
   */
  private readonly ensuredSkillAssets = new Map<string, true>();
  private static readonly SKILL_ENSURE_CACHE_SIZE = 4096;

  /** Chat_memory content cleaner injected by gateway; if not injected, archiving only deletes asset without clearing content. */
  private _chatMemoryContentCleaner?: ChatMemoryContentCleaner;

  constructor(
    private readonly store: IMetadataStore,
    private readonly instanceId: string = DEFAULT_INSTANCE_ID,
    private readonly logger: PermCheckLogger = { debug: () => {} },
    quotaLimits?: Partial<MetadataQuotaLimits>,
    memorySystemUser?: MemorySystemUserConfig,
  ) {
    this.quota = { ...DEFAULT_METADATA_QUOTA_LIMITS, ...quotaLimits };
    this.memorySystemUser = memorySystemUser;
  }

  get scopedInstanceId(): string {
    return this.instanceId;
  }

  get configParams(): import("./config-param-service.js").IConfigParamService {
    if (!this._configParams) {
      throw new Error("ConfigParamService not initialized. Call setConfigParamService() after store.init().");
    }
    return this._configParams;
  }

  setConfigParamService(svc: import("./config-param-service.js").IConfigParamService): void {
    this._configParams = svc;
  }

  /**
   * Inject 'chat_memory content cleaner'.
   *
   * Why use an optional hook instead of direct store dependency: metadata layer only holds IMetadataStore
   * (metadata) and cannot access IMemoryStore / StorageAdapter (L0-L3 content). Archiving
   * an Agent needs to clear its memory content, which requires the gateway assembly to inject the cleaning capability
   * — same pattern as setConfigParamService, keeping dependency direction inverted.
   *
   * Without injection, archiveAgent degrades to original behavior (only deletes asset, does not clear content), thus
   * scenarios not assembling this hook (unit tests / migration scripts) are unaffected.
   */
  setChatMemoryContentCleaner(cleaner: ChatMemoryContentCleaner): void {
    this._chatMemoryContentCleaner = cleaner;
  }

  /** memory static key only used for auth/verify body, cannot be used for Header auth. */
  isConfiguredMemorySystemUserKey(userKey: string): boolean {
    return isMemorySystemUserKey(userKey, this.memorySystemUser);
  }

  private pag(input: { limit?: number; offset?: number }): PaginationParams {
    return resolvePagination(input);
  }

  private async allAclRecords(assetId: string): Promise<AclEntity[]> {
    const out: AclEntity[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = await this.store.listAclByAsset(assetId, { limit, offset });
      out.push(...page.items);
      if (offset + page.items.length >= page.total) break;
      offset += limit;
    }
    return out;
  }

  /** internal: list users by instance with pagination (includes system_admin, no masking). */
  async listUsersByInstance(
    instanceId: string,
    pagination: PaginationParams,
    filter?: InstanceUserListFilter,
  ): Promise<PaginatedResult<UserEntity>> {
    void instanceId;
    const page = await this.store.listUsers(pagination, filter);
    return formatListResult(page, pagination);
  }

  /** Validate user existence, otherwise throw not_found. */
  private async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.getUserById(userId);
    if (!user) throw new MetadataError("user_not_found", `user not found: ${userId}`);
    return user;
  }

  get rawStore(): IMetadataStore {
    return this.store;
  }

  private async assertUserQuota(): Promise<void> {
    const count = await this.store.countUsers();
    const limit = this._configParams
      ? await this._configParams.getEffectiveInt("quota", "max_users_per_instance")
      : this.quota.maxUsersPerInstance;
    if (count >= limit) {
      throw new MetadataError(
        "user_limit_exceeded",
        `user limit ${limit} reached for instance ${this.instanceId} (current: ${count})`,
      );
    }
  }

  private async assertTeamQuota(): Promise<void> {
    const count = await this.store.countTeams();
    const limit = this._configParams
      ? await this._configParams.getEffectiveInt("quota", "max_teams_per_instance")
      : this.quota.maxTeamsPerInstance;
    if (count >= limit) {
      throw new MetadataError(
        "team_limit_exceeded",
        `team limit ${limit} reached for instance ${this.instanceId} (current: ${count})`,
      );
    }
  }

  // ============================================================
  // User (including user_key generation/refresh)
  // ============================================================
  async initAdminUser(input: InitAdminInput): Promise<InitAdminResult> {
    if ((await this.store.countUsers()) > 0) {
      throw new MetadataError("already_initialized", "system already has users; init-admin requires empty database");
    }
    if ((await this.store.countSystemAdmins()) > 0) {
      throw new MetadataError("already_initialized", "system_admin already exists");
    }

    // Core operation: create admin user
    const created = await this.createUserWithType(
      { username: input.username, default_key_value: input.user_key },
      "system_admin",
    );

    // Auxiliary operation: auto-create default Team and Agent (failure does not block core flow)
    try {
      const team = await this.createTeam({
        name: DEFAULT_TEAM_NAME,
        description: DEFAULT_TEAM_DESCRIPTION,
        owner_user_id: created.user_id,
      });

      try {
        const agentName = `${DEFAULT_AGENT_NAME}-${input.username}`;
        await this.createAgent({
          team_id: team.team_id,
          owner_user_id: created.user_id,
          name: agentName,
          description: DEFAULT_AGENT_DESCRIPTION,
          prompt: DEFAULT_AGENT_PROMPT,
          metadata_json: DEFAULT_AGENT_METADATA_JSON,
          visibility: "team",
          status: "active",
        });
      } catch (err) {
        console.warn(
          `[init-admin] Default Agent creation failed, skipped (user=${created.user_id})`,
          err instanceof Error ? err.message : err,
        );
      }
    } catch (err) {
      console.warn(
        `[init-admin] Default Team creation failed, skipped (user=${created.user_id})`,
        err instanceof Error ? err.message : err,
      );
    }

    return { user_id: created.user_id, user_key: created.default_user_key };
  }

  async createNormalUser(input: CreateUserInput): Promise<CreateUserApiResult> {
    return this.createUserWithType(input, "normal");
  }

  /**
   * Only for /v3/meta/user/create-with-key: allows system_admin to explicitly specify user_key when creating account.
   *
   * Two-layer deduplication:
   *   1. Upfront getUserByKey: fast failure on normal path, no transaction entered
   *   2. Store layer UNIQUE constraint (DuplicateUserKeyError): TOCTOU / concurrency fallback
   *
   * Router layer must call assertCanManageUsers first for auth.
   */
  async createNormalUserWithKey(input: {
    username: string;
    user_key: string;
  }): Promise<CreateUserApiResult> {
    const existing = await this.store.getUserByKey(input.user_key);
    if (existing) {
      throw new MetadataError("duplicate_user_key", "user_key already exists");
    }
    try {
      return await this.createUserWithType(
        { username: input.username, default_key_value: input.user_key },
        "normal",
      );
    } catch (err) {
      if (err instanceof DuplicateUserKeyError) {
        throw new MetadataError("duplicate_user_key", "user_key already exists");
      }
      throw err;
    }
  }

  /** Fallback to default values (local / user_id) when auth_provider / external_id not passed. */
  private resolveCreateUserInput(
    input: CreateUserInput,
  ): CreateUserInput & { auth_provider: string; external_id: string } {
    const authProvider = input.auth_provider?.trim() || DEFAULT_AUTH_PROVIDER;
    const externalId = input.external_id?.trim();
    if (externalId) {
      return { ...input, auth_provider: authProvider, external_id: externalId };
    }
    const userId = input.user_id ?? generateId(ID_PREFIX.user);
    return { ...input, auth_provider: authProvider, user_id: userId, external_id: userId };
  }

  private async createUserWithType(input: CreateUserInput, userType: UserType): Promise<CreateUserApiResult> {
    const resolved = this.resolveCreateUserInput(input);
    await this.assertUserQuota();
    const user = await this.store.createUser({
      ...resolved,
      password: null,
      user_type: userType,
    });
    const defaultKey = await this.store.getDefaultUserKey(user.user_id);
    if (!defaultKey) {
      throw new MetadataError("internal_error", "default user key not created");
    }
    return {
      user_id: user.user_id,
      user_type: user.user_type,
      created_at: user.created_at,
      default_user_key: defaultKey.key_value,
    };
  }

  async getUserForCaller(userId: string, ctx: V3AuthContext): Promise<UserPublic> {
    const user = await this.getUserById(userId);
    if (!user || !canViewUser(user, ctx)) {
      throw new MetadataError("user_not_found", `user not found: ${userId}`);
    }
    return toPublicUser(user, ctx);
  }

  async getUserById(userId: string): Promise<UserEntity | null> {
    return this.store.getUserById(userId);
  }

  async getUserByKey(userKey: string): Promise<UserEntity | null> {
    return this.store.getUserByKey(userKey);
  }

  async getUserByExternalId(authProvider: string, externalId: string): Promise<UserEntity | null> {
    return this.store.getUserByExternalId(authProvider, externalId);
  }

  async deleteUsersForCaller(userIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    if (!canManageUsers(ctx)) {
      throw new MetadataError("permission_denied", "user management requires system admin");
    }
    let deletingSystemAdmins = 0;
    for (const id of userIds) {
      const u = await this.getUserById(id);
      if (u && isSystemAdminUser(u)) deletingSystemAdmins++;
    }
    const totalAdmins = await this.store.countSystemAdmins();
    if (totalAdmins > 0 && totalAdmins - deletingSystemAdmins < 1) {
      throw new MetadataError("last_system_admin", "cannot delete the last system_admin user");
    }
    return this.deleteUsers(userIds);
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteUsers(userIds);
  }

  async listUsersForCaller(
    input: { team_id?: string } & UserListFilter,
    ctx: V3AuthContext,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<UserPublic>> {
    const filtersPresent = !!(input.user_ids?.length || input.username);
    const storeFilter = this.buildUserListStoreFilter(input);

    if (!input.team_id) {
      if (!ctx.isSystemAdmin) {
        throw new MetadataError("missing_team_id", "team_id is required for non-system-admin callers");
      }
      const page = await this.store.listUsers(pagination, storeFilter);
      const items = filterVisibleUsers(page.items, ctx);
      return formatListResult({ items, total: page.total }, pagination);
    }

    const teamId = input.team_id;

    if (ctx.isSystemAdmin) {
      const page = await this.store.listUsersByTeam(teamId, pagination, storeFilter);
      const items = filterVisibleUsers(page.items, ctx);
      return formatListResult({ items, total: page.total }, pagination);
    }

    if (!ctx.userId) {
      throw new MetadataError("permission_denied", "authentication required");
    }

    const member = await this.store.getTeamMember(teamId, ctx.userId);
    if (!member || member.status !== "active") {
      throw new MetadataError("permission_denied", "not a team member");
    }

    const isTeamAdmin = member.role === "admin";
    if (isTeamAdmin) {
      const page = await this.store.listUsersByTeam(teamId, pagination, storeFilter);
      const items = filterVisibleUsers(page.items, ctx, { allowTeamPeers: true });
      return formatListResult({ items, total: page.total }, pagination);
    }

    if (filtersPresent) {
      throw new MetadataError("filter_not_allowed", "filters are not allowed for normal team members");
    }

    const self = await this.store.getUserById(ctx.userId);
    if (!self) {
      throw new MetadataError("user_not_found", `user not found: ${ctx.userId}`);
    }
    const visible = filterVisibleUsers([self], ctx);
    if (pagination.offset > 0) {
      return wrapPaginated([], 1, pagination);
    }
    return wrapPaginated(visible, 1, pagination);
  }

  private buildUserListStoreFilter(input: UserListFilter): InstanceUserListFilter | undefined {
    const filter: InstanceUserListFilter = {};
    if (input.user_ids?.length) filter.user_ids = input.user_ids;
    if (input.username) filter.username = input.username;
    return Object.keys(filter).length ? filter : undefined;
  }

  /** @deprecated use listUsersForCaller */
  async listUsersByTeamForCaller(
    teamId: string,
    ctx: V3AuthContext,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<UserPublic>> {
    return this.listUsersForCaller({ team_id: teamId }, ctx, pagination);
  }

  async listUsersByTeam(teamId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<UserEntity>> {
    const page = await this.store.listUsersByTeam(teamId, pagination);
    return formatListResult(page, pagination);
  }

  assertCanManageUsers(ctx: V3AuthContext): void {
    if (!canManageUsers(ctx)) {
      throw new MetadataError("permission_denied", "user management requires system admin");
    }
  }

  canManageUserScope(userId: string, ctx: V3AuthContext): boolean {
    return ctx.isAdmin || ctx.isSystemAdmin || ctx.userId === userId;
  }

  assertUserScope(userId: string, callerUserId?: string, isAdmin = false, isSystemAdmin = false): void {
    if (isAdmin || isSystemAdmin || userId === callerUserId) return;
    throw new MetadataError("permission_denied", "cannot access another user's keys");
  }

  assertCallerIsOwner(targetUserId: string, callerId: string): void {
    if (targetUserId !== callerId) {
      throw new MetadataError("permission_denied", "user_id does not match caller");
    }
  }

  async verifyAuthForCaller(userKey: string, ctx: V3AuthContext): Promise<{ valid: boolean; user: UserPublic | null }> {
    const user = await this.verifyAuth(userKey);
    if (!user) return { valid: false, user: null };
    const visibilityCtx: V3AuthContext = ctx.userId
      ? ctx
      : {
          token: userKey,
          userId: user.user_id,
          isAdmin: false,
          isSystemAdmin: user.user_type === "system_admin",
        };
    if (!canViewUser(user, visibilityCtx)) {
      return { valid: true, user: null };
    }
    if (this.memorySystemUser && user.user_id === this.memorySystemUser.userId) {
      return {
        valid: true,
        user: {
          user_id: user.user_id,
          user_type: user.user_type,
          username: user.username,
          created_at: user.created_at,
        },
      };
    }
    return { valid: true, user: toPublicUser(user, visibilityCtx) };
  }

  /** Validate user_key and return corresponding user (returns null if invalid). */
  async verifyAuth(userKey: string): Promise<UserEntity | null> {
    if (!userKey) return null;
    const configured = lookupMemorySystemUser(userKey, this.instanceId, this.memorySystemUser);
    if (configured) return configured;
    return this.store.getUserByKey(userKey);
  }

  toPublicUserKey(entity: UserKeyEntity): UserKeyPublic {
    return {
      key_id: entity.key_id,
      user_id: entity.user_id,
      key_prefix: maskUserKey(entity.key_value),
      name: entity.name ?? null,
      status: entity.status,
      is_default: entity.is_default,
      last_used_at: entity.last_used_at ?? null,
      expires_at: entity.expires_at ?? null,
      created_at: entity.created_at,
      revoked_at: entity.revoked_at ?? null,
    };
  }

  async createUserKey(
    userId: string,
    input: { name?: string | null; expires_at?: string | null },
  ): Promise<UserKeyCreated> {
    await this.requireUser(userId);

    const active = await this.store.countActiveUserKeys(userId);
    if (active >= this.maxActiveUserKeys) {
      throw new MetadataError("key_limit_exceeded", `active user key limit ${this.maxActiveUserKeys} reached`);
    }

    const entity = await this.store.createUserKey({
      user_id: userId,
      name: input.name,
      expires_at: input.expires_at,
      is_default: false,
    });
    return { ...this.toPublicUserKey(entity), key_value: entity.key_value };
  }

  async listUserKeys(userId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<UserKeyPublic>> {
    await this.requireUser(userId);
    const page = await this.store.listUserKeys(userId, pagination);
    const items = page.items.map((k) => this.toPublicUserKey(k));
    return formatListResult({ items, total: page.total }, pagination);
  }

  async getUserKey(keyId: string): Promise<UserKeyPublic> {
    const entity = await this.store.getUserKeyById(keyId);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    return this.toPublicUserKey(entity);
  }

  /** Validate caller has access to this key (self, system_admin or bootstrap), returns masked details. */
  async getUserKeyForCaller(
    keyId: string,
    callerUserId?: string,
    isAdmin = false,
    isSystemAdmin = false,
  ): Promise<UserKeyPublic> {
    const entity = await this.store.getUserKeyById(keyId);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    const owner = await this.getUserById(entity.user_id);
    if (!owner) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }
    if (!isAdmin && !isSystemAdmin && entity.user_id !== callerUserId) {
      throw new MetadataError("permission_denied", "cannot access another user's key");
    }
    if (isSystemAdminUser(owner) && !isAdmin && callerUserId !== owner.user_id) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }
    return this.toPublicUserKey(entity);
  }

  async revokeUserKey(keyId: string): Promise<void> {
    const entity = await this.store.getUserKeyById(keyId);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    if (!(await this.getUserById(entity.user_id))) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }

    const active = await this.store.countActiveUserKeys(entity.user_id);
    if (active <= 1) {
      throw new MetadataError("last_key_cannot_revoke", "cannot revoke the last active user key");
    }

    console.info(
      `[META] revokeUserKey: user_id=${entity.user_id} key_id=${entity.key_id} key_prefix=${maskUserKey(entity.key_value)}`,
    );
    await this.store.revokeUserKey(keyId, { promoteNextDefault: true });
  }

  async updateUserKey(
    keyId: string,
    patch: { name?: string | null; expires_at?: string | null },
  ): Promise<UserKeyPublic> {
    const existing = await this.store.getUserKeyById(keyId);
    if (!existing) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    if (!(await this.getUserById(existing.user_id))) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }

    const updated = await this.store.updateUserKey(keyId, patch);
    if (!updated) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    return this.toPublicUserKey(updated);
  }

  private get maxActiveUserKeys(): number {
    const fromEnv = Number(process.env.TDAI_USER_KEY_MAX_ACTIVE);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_ACTIVE_USER_KEYS;
  }

  // ============================================================
  // Team
  // ============================================================
  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    await this.assertTeamQuota();
    return this.store.createTeam(input);
  }

  async getTeamById(teamId: string): Promise<TeamEntity | null> {
    return this.store.getTeamById(teamId);
  }

  async updateTeam(teamId: string, patch: Partial<TeamEntity>): Promise<TeamEntity> {
    if (!(await this.getTeamById(teamId))) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    const updated = await this.store.updateTeam(teamId, patch);
    if (!updated) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    return updated;
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteTeams(teamIds);
  }

  async listTeamsByUser(userId: string, pagination: PaginationParams = DEFAULT_PAGINATION, filter?: { name?: string }): Promise<PaginatedResult<TeamEntity>> {
    const page = await this.store.listTeamsByUser(userId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  // ============================================================
  // TeamMember
  // ============================================================
  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMemberEntity> {
    const team = await this.getTeamById(input.team_id);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${input.team_id}`);
    const reqRole = input.role ?? "member";
    // owner is fixed to admin by createTeam; prevent downgrade via add upsert, otherwise
    // 'still owner but role!=admin' happens - 403 when acting as admin or team-member/add.
    if (input.user_id === team.owner_user_id && reqRole !== "admin") {
      throw new MetadataError("permission_denied", "cannot demote team owner");
    }
    const existing = await this.store.getTeamMember(input.team_id, input.user_id);
    if (existing?.status === "active" && existing.role === reqRole) {
      throw new MetadataError(
        "member_already_exists",
        `member already exists: ${input.team_id}/${input.user_id}`,
      );
    }

    // Core operation: add user to Team
    const result = await this.store.addTeamMember({ ...input, role: reqRole });

    return result;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.store.removeTeamMember(teamId, userId);
  }

  async listTeamMembers(teamId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<TeamMemberEntity>> {
    const page = await this.store.listTeamMembers(teamId, pagination);
    return formatListResult(page, pagination);
  }

  async getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity | null> {
    return this.store.getTeamMember(teamId, userId);
  }

  // ============================================================
  // Agent (validate team existence)
  // ============================================================
  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    await this.assertTeamExists(input.team_id);
    const agent = await this.store.createAgent(input);
    // Outside the same transaction boundary of agent creation, immediately mint the agent's chat_memory asset +
    // bind to fixed_assets. avoids Bug 2: asset doesn't exist when first conversation is triggered →
    // profile-memory-injector first session prewarm falls back to tools-only,
    // and under session_init caching strategy, L3 is never read during the session.
    //
    // Idempotent: ensureChatMemoryAsset uses no-op internally for existing asset / existing binding.
    // Failure is non-fatal: agent created successfully, chat_memory is just 'prepared earlier',
    // even if it fails here, the /conversation/add path will still retry ensure, hence only log warn here.
    try {
      await this.ensureChatMemoryAsset({
        team_id: agent.team_id,
        agent_id: agent.agent_id,
      });
    } catch (err) {
      // No dedicated warn logger here (service layer only has PermCheckLogger.debug),
      // use console.warn to be consistent with similar catch in v2-router.handleConversationAdd.
      console.warn(
        `[META] createAgent: ensureChatMemoryAsset failed (agent=${agent.agent_id} team=${agent.team_id}): ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
    return agent;
  }

  async getAgentById(agentId: string): Promise<AgentEntity | null> {
    return this.store.getAgentById(agentId);
  }

  async updateAgent(agentId: string, patch: Partial<AgentEntity>): Promise<AgentEntity> {
    if (!(await this.getAgentById(agentId))) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const updated = await this.store.updateAgent(agentId, patch);
    if (!updated) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    return updated;
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteAgents(agentIds);
  }

  async listAgentsByTeam(
    teamId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: AgentFilter,
  ): Promise<PaginatedResult<AgentEntity>> {
    const page = await this.store.listAgentsByTeam(teamId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  async listAgentsByOwner(
    userId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: AgentFilter,
  ): Promise<PaginatedResult<AgentEntity>> {
    const page = await this.store.listAgentsByOwner(userId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  /**
   * Archive (soft close) agent.
   *
   * Order is critical — **clear content first, then delete asset**:
   *   1. status → inactive
   *   2. Clear the agent's chat_memory content (L0/L1/L2/L3 + vectors + files)
   *   3. Delete its own chat_memory asset record (and cascade clear borrowed bindings from other agents)
   *
   * If the order is reversed (delete asset then clear content), once the asset record is gone, we can no longer locate
   * (team, agent) from asset_id, and the content becomes **permanently unreachable orphan data**
   * left in the database — this is exactly the issue fixed here.
   *
   * If content cleanup fails, **abort archiving** and throw upward: better to let caller retry than leave
   * an inconsistent state of 'asset deleted, content remains'. When cleaner is not injected (unit tests / migration
   * scripts), skip step 2 and degrade to original behavior.
   */
  async archiveAgent(agentId: string): Promise<AgentEntity> {
    const existing = await this.getAgentById(agentId);
    if (!existing) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const archived = await this.updateAgent(agentId, { status: "inactive" });

    if (this._chatMemoryContentCleaner) {
      await this._chatMemoryContentCleaner({
        teamId: existing.team_id,
        agentId: existing.agent_id,
      });
    }

    const selfMemoryAssetId = buildChatMemoryAssetId(existing.team_id, existing.agent_id);
    await this.store.deleteAssets([selfMemoryAssetId]);
    return archived;
  }

  // ============================================================
  // Task (validate team existence + linked agents in same team)
  // ============================================================
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    await this.assertTeamExists(input.team_id);
    for (const link of input.linked_agents ?? []) {
      const agent = await this.getAgentById(link.agent_id);
      if (!agent) {
        throw new MetadataError("agent_not_found", `agent not found: ${link.agent_id}`);
      }
      if (agent.team_id !== input.team_id) {
        throw new MetadataError(
          "agent_team_mismatch",
          `agent ${link.agent_id} not in team ${input.team_id}`,
        );
      }
    }
    return this.store.createTask(input);
  }

  async getTaskById(taskId: string): Promise<TaskEntity | null> {
    return this.store.getTaskById(taskId);
  }

  async updateTask(taskId: string, patch: Partial<TaskEntity>): Promise<TaskEntity> {
    if (!(await this.getTaskById(taskId))) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    const updated = await this.store.updateTask(taskId, patch);
    if (!updated) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    return updated;
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteTasks(taskIds);
  }

  async listTasksByTeam(
    teamId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: TaskFilter,
  ): Promise<PaginatedResult<TaskEntity>> {
    const page = await this.store.listTasksByTeam(teamId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  async listTasks(filter: TaskFilter, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<TaskEntity>> {
    const page = await this.store.listTasks(filter, pagination);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  /** Archive (soft close) task: status → completed. */
  async archiveTask(taskId: string): Promise<TaskEntity> {
    return this.updateTask(taskId, { status: "completed" });
  }

  // ============================================================
  // TaskAgent
  // ============================================================
  async linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): Promise<TaskAgentEntity> {
    const task = await this.getTaskById(taskId);
    if (!task) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    if (agent.team_id !== task.team_id) {
      throw new MetadataError("agent_team_mismatch", `agent ${agentId} not in team ${task.team_id}`);
    }
    return this.store.linkTaskAgent(taskId, agentId, roleInTask);
  }

  async unlinkTaskAgent(taskId: string, agentId: string): Promise<void> {
    if (!(await this.getTaskById(taskId))) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    await this.store.unlinkTaskAgent(taskId, agentId);
  }

  async listTaskAgents(taskId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<TaskAgentEntity>> {
    const page = await this.store.listTaskAgents(taskId, pagination);
    return formatListResult(page, pagination);
  }

  // ============================================================
  // ParticipationLog
  // ============================================================
  async appendParticipationLog(input: AppendParticipationLogInput): Promise<ParticipationLogEntity> {
    await this.assertParticipationContext(input.team_id, input.task_id, input.agent_id, input.user_id);
    return this.store.appendParticipationLog(input);
  }

  async listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<ParticipationLogEntity>> {
    const page = await this.store.listParticipationLogs(filter, pagination);
    return formatListResult(page, pagination);
  }

  private async assertParticipationContext(
    teamId: string,
    taskId: string,
    agentId: string,
    userId: string,
  ): Promise<void> {
    await this.assertTeamExists(teamId);
    const task = await this.getTaskById(taskId);
    if (!task) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    if (task.team_id !== teamId) {
      throw new MetadataError("permission_denied", `task ${taskId} not in team ${teamId}`);
    }
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    // if (agent.team_id !== teamId) {
    //   throw new MetadataError("agent_team_mismatch", `agent ${agentId} not in team ${teamId}`);
    // }
    const member = await this.getTeamMember(teamId, userId);
    if (!member || member.status !== "active") {
      throw new MetadataError("member_not_found", `member not found: ${teamId}/${userId}`);
    }
    // const links = await this.store.listTaskAgents(taskId, { limit: 1000, offset: 0 });
    // if (!links.items.some((l) => l.agent_id === agentId)) {
    //   throw new MetadataError("task_agent_not_linked", `task ${taskId} not linked to agent ${agentId}`);
    // }
  }

  // ============================================================
  // Asset (main table only)
  // ============================================================
  async createAsset(input: CreateAssetInput): Promise<AssetEntity> {
    await this.assertTeamExists(input.team_id);
    return this.store.createAsset(input);
  }

  async getAssetById(assetId: string): Promise<AssetEntity | null> {
    return this.store.getAssetById(assetId);
  }

  async updateAsset(assetId: string, patch: Partial<AssetEntity>): Promise<AssetEntity> {
    if (!(await this.getAssetById(assetId))) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    const updated = await this.store.updateAsset(assetId, patch);
    if (!updated) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    return updated;
  }

  async deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.store.deleteAssets(assetIds);
    // Clear ensure cache to avoid short-circuit falsely judging 'still exists' after deletion
    for (const id of result.deleted_ids) {
      this.ensuredSkillAssets.delete(id);
      this.ensuredChatMemoryAssets.delete(id);
    }
    return result;
  }

  async listAssetsByTeam(
    teamId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: AssetFilter,
  ): Promise<PaginatedResult<AssetEntity>> {
    const page = await this.store.listAssetsByTeam(teamId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  async touchAssetUsage(assetId: string): Promise<void> {
    if (!(await this.getAssetById(assetId))) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    await this.store.touchAssetUsage(assetId);
  }

  async listAgentFixedAssets(
    agentId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<FixedAssetBindingEntity>> {
    const page = await this.store.listAgentFixedAssets(agentId, pagination);
    return formatListResult(page, pagination);
  }

  /**
   * Multiple agent fixed asset allocation summary. Missing agent / type filled with 0; items order matches requested agent_ids.
   * Optional asset_id: only count rows bound to this asset (used for bound_agent_count).
   */
  async summarizeAgentFixedAssetsByAgents(
    params: SummarizeAgentFixedAssetsParams,
  ): Promise<AgentFixedAssetSummaryResult> {
    const agentIds = [...new Set(params.agent_ids.filter((id) => id.length > 0))];
    if (agentIds.length === 0) {
      return { items: [], total: 0 };
    }

    const emptyCounts = (): FixedAssetTypeCounts => ({
      skill: 0,
      code_graph: 0,
      llm_wiki: 0,
      chat_memory: 0,
    });

    const rows = await this.store.summarizeAgentFixedAssetsByAgents(agentIds, {
      assetId: params.asset_id,
    });

    const byAgent = new Map<string, FixedAssetTypeCounts>();
    const totals = new Map<string, number>();
    for (const id of agentIds) {
      byAgent.set(id, emptyCounts());
      totals.set(id, 0);
    }
    for (const row of rows) {
      const counts = byAgent.get(row.agent_id);
      if (!counts) continue;
      if (row.asset_type in counts) {
        counts[row.asset_type] = row.cnt;
      }
      totals.set(row.agent_id, (totals.get(row.agent_id) ?? 0) + row.cnt);
    }

    const items: AgentFixedAssetSummary[] = agentIds.map((agent_id) => ({
      agent_id,
      counts: byAgent.get(agent_id) ?? emptyCounts(),
      total: totals.get(agent_id) ?? 0,
    }));

    return { items, total: items.length };
  }

  // ============================================================
  // AgentFixedAsset (canBindAsset validation + detail aggregation)
  // ============================================================
  async setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): Promise<void> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);

    for (const b of bindings) {
      const asset = await this.getAssetById(b.asset_id);
      if (!asset) {
        throw new MetadataError("asset_not_found", `asset not found: ${b.asset_id}`);
      }
      if (!canBindAsset(agent, asset)) {
        throw new MetadataError(
          "asset_not_bindable",
          `asset ${b.asset_id} (visibility=${asset.visibility}) cannot bind to agent ${agentId}`,
        );
      }
    }
    await this.store.setAgentFixedAssets(agentId, bindings);
  }

  /**
   * Append an agent binding (keep existing bindings). Used for incremental scenarios like
   * auto-registering chat_memory asset; different from full replacement in setAgentFixedAssets.
   *
   * Validation: agent / asset must both be in current instance; canBindAsset must pass.
   * Idempotency: store layer relies on (agent_id, asset_id) unique constraint, repeated calls have no side effects.
   */
  async addAgentFixedAsset(agentId: string, b: FixedAssetBindingInput): Promise<void> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const asset = await this.getAssetById(b.asset_id);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${b.asset_id}`);
    if (!canBindAsset(agent, asset)) {
      throw new MetadataError(
        "asset_not_bindable",
        `asset ${b.asset_id} (visibility=${asset.visibility}) cannot bind to agent ${agentId}`,
      );
    }
    await this.store.addAgentFixedAsset(agentId, b);
  }

  /**
   * Idempotently ensure the chat_memory asset for (team, agent) exists and is bound to the agent.
   *
   * First call will synchronously complete three things (strict order):
   *   1. createAsset({asset_type:'chat_memory', visibility:'private',
   *      owner_user_id: agent.owner_user_id})
   *   2. store.addAgentFixedAsset(agent, {asset_id, injection_mode:'summary'})
   *   3. Write to in-process LRU cache, subsequent requests for same (team, agent) short-circuit directly
   *
   * Idempotency guarantees:
   *   - asset_id = chat_memory-{team}-{agent} is stable and deterministic
   *   - meta_assets.asset_id is primary key → concurrency create conflicts trigger readback
   *   - meta_agent_fixed_assets (agent_id, asset_id) is unique → repeated
   *     addAgentFixedAsset is absorbed by store layer as no-op
   *
   * Failure strategy: This method **will throw errors** (agent_not_found / team_mismatch / DB failure).
   * Caller (handleConversationAdd in v2-router) is responsible for catch + logging warn only,
   * without blocking main flow conversation writing.
   */
  async ensureChatMemoryAsset(params: {
    team_id: string;
    agent_id: string;
  }): Promise<AssetEntity> {
    const assetId = buildChatMemoryAssetId(params.team_id, params.agent_id);

    // 1. Cache short-circuit: if confirmed exists, return lightweight placeholder directly (only query store if caller needs entity)
    //    In practice caller doesn't consume return value (fire-and-forget), doesn't query store on cache hit.
    if (this.ensuredChatMemoryAssets.has(assetId)) {
      const cached = await this.getAssetById(assetId);
      if (cached) return cached;
      // Cache is dirty (deleted externally) — clear and start over
      this.ensuredChatMemoryAssets.delete(assetId);
    }

    // 2. Fetch agent, get owner + team for create + canBindAsset
    //    Fetching agent first ensures team_mismatch validation in all paths, and later bind
    //    needs owner_user_id as created_by.
    const agent = await this.getAgentById(params.agent_id);
    if (!agent) {
      throw new MetadataError(
        "agent_not_found",
        `cannot ensure chat_memory asset: agent ${params.agent_id} not found`,
      );
    }
    if (agent.team_id !== params.team_id) {
      throw new MetadataError(
        "team_mismatch",
        `cannot ensure chat_memory asset: agent ${params.agent_id} belongs to team ` +
        `${agent.team_id}, not ${params.team_id}`,
      );
    }

    // 3. Fetch or create asset: check if already in store first (cold start / created by other pod), otherwise create.
    //    createAsset primary key conflict = concurrency race, readback as fallback.
    let asset = await this.getAssetById(assetId);
    if (!asset) {
      try {
        asset = await this.createAsset({
          asset_id: assetId,
          team_id: params.team_id,
          asset_type: "chat_memory",
          name: `Memory of ${agent.name}`,
          owner_user_id: agent.owner_user_id,
          source_type: "auto",
          visibility: "private",
          status: "active",
        });
      } catch (err) {
        const raced = await this.getAssetById(assetId);
        if (raced) {
          asset = raced;
        } else {
          throw err;
        }
      }
    }

    // 4. Whether asset is newly created or pre-existing, **idempotently** append binding once.
    //    Previous attempt might have only completed create, failing at bind stage; bind has UNIQUE constraint, repeated
    //    calls have no side effects. Directly call store here skipping addAgentFixedAsset's repeated validation
    //    — we already queried agent / asset above.
    await this.store.addAgentFixedAsset(params.agent_id, {
      asset_id: assetId,
      asset_type: "chat_memory",
      injection_mode: "summary",
      priority: 50,
      created_by: agent.owner_user_id,
    });

    this.rememberEnsuredChatMemoryAsset(assetId);
    return asset;
  }

  /** LRU-ish record: evict earliest written entry when limit reached. */
  private rememberEnsuredChatMemoryAsset(assetId: string): void {
    if (this.ensuredChatMemoryAssets.has(assetId)) return;
    if (this.ensuredChatMemoryAssets.size >= MetadataService.CHAT_MEMORY_ENSURE_CACHE_SIZE) {
      const oldest = this.ensuredChatMemoryAssets.keys().next().value;
      if (oldest !== undefined) this.ensuredChatMemoryAssets.delete(oldest);
    }
    this.ensuredChatMemoryAssets.set(assetId, true);
  }

  //  ============================================================
  //  Skill Asset — Same ensure pattern
  //  ============================================================

  /**
   * Register skill asset and bind to agent. Same 5-step structure as ensureChatMemoryAsset:
   *
   *   1. LRU short-circuit (key = skill_id, i.e. asset_id)
   *   2. Query agent to get owner + validate team
   *   3. Idempotent createAsset (asset_id = skill_id)
   *   4. Idempotent addAgentFixedAsset (injection_mode = reference)
   *   5. Record to LRU
   *
   * Idempotency guarantees:
   *   - asset_id is external skill_id (core layer generates skl-xxxx), stable and unique
   *   - meta_assets.asset_id primary key → readback on concurrency create conflict
   *   - meta_agent_fixed_assets (agent_id, asset_id) UNIQUE → bind idempotent
   *
   * Failure strategy:
   *   - v1 creation path (onSkillCreated context): throws exception to interrupt create,
   *     avoiding 'skill saved to DB but invisible in frontend' unrecoverable state
   *   - read self-healing path (onSkillAccessed context): handled via try/catch by caller,
   *     does not affect skill returning
   */
  async ensureSkillAsset(params: {
    skill_id: string;
    team_id: string;
    agent_id: string;
    name: string;
  }): Promise<AssetEntity> {
    const assetId = params.skill_id; // skill_id === asset_id (convention)

    // 1. LRU short-circuit
    if (this.ensuredSkillAssets.has(assetId)) {
      const cached = await this.getAssetById(assetId);
      if (cached) return cached;
      this.ensuredSkillAssets.delete(assetId);
    }

    // 2. Fetch agent to get owner + validate team
    const agent = await this.getAgentById(params.agent_id);
    if (!agent) {
      throw new MetadataError(
        "agent_not_found",
        `cannot ensure skill asset: agent ${params.agent_id} not found`,
      );
    }
    if (agent.team_id !== params.team_id) {
      throw new MetadataError(
        "team_mismatch",
        `cannot ensure skill asset: agent ${params.agent_id} belongs to team ` +
        `${agent.team_id}, not ${params.team_id}`,
      );
    }

    // 3. Idempotent createAsset
    //
    // Default visibility = "private" (2026-07 change):
    //   - Newly created skill is strictly private, visible only to owner and team admin.
    //   - To make readable to everyone in team → user explicitly changes to 'shared' in management page (asset/update visibility=team).
    //   - To make readable to specific user/agent → use acl/grant + visibility=restricted.
    //
    // Why not "team": Skill content often includes internal knowledge, scripts, credential comments, etc.,
    // "visible to entire team by default" is not secure enough for privacy-sensitive scenarios (e.g., skill for personal debugging).
    // Private → active sharing mindset is more intuitive.
    let asset = await this.getAssetById(assetId);
    if (!asset) {
      try {
        asset = await this.createAsset({
          asset_id: assetId,
          team_id: params.team_id,
          asset_type: "skill",
          name: params.name,
          owner_user_id: agent.owner_user_id,
          source_type: "extracted",
          visibility: "private",
          status: "active",
        });
      } catch (err) {
        const raced = await this.getAssetById(assetId);
        if (raced) {
          asset = raced;
        } else {
          throw err;
        }
      }
    }

    // 4. Idempotent addAgentFixedAsset
    await this.store.addAgentFixedAsset(params.agent_id, {
      asset_id: assetId,
      asset_type: "skill",
      injection_mode: "reference",
      priority: 50,
      created_by: agent.owner_user_id,
    });

    this.rememberEnsuredSkillAsset(assetId);
    return asset;
  }

  /** LRU-ish record: evict earliest written entry when limit reached. */
  private rememberEnsuredSkillAsset(assetId: string): void {
    if (this.ensuredSkillAssets.has(assetId)) return;
    if (this.ensuredSkillAssets.size >= MetadataService.SKILL_ENSURE_CACHE_SIZE) {
      const oldest = this.ensuredSkillAssets.keys().next().value;
      if (oldest !== undefined) this.ensuredSkillAssets.delete(oldest);
    }
    this.ensuredSkillAssets.set(assetId, true);
  }

  async listAgentFixedAssetsWithDetail(
    params: ListWithDetailParams,
  ): Promise<AgentFixedAssetDetailResult> {
    const agent = await this.getAgentById(params.agent_id);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${params.agent_id}`);

    const pagination = this.pag(params);
    const assetTypes = params.asset_types && params.asset_types.length > 0
      ? params.asset_types
      : undefined;
    const bindingPage = await this.store.listAgentFixedAssets(params.agent_id, pagination, { assetTypes });
    const items: AgentAssetView[] = [];

    for (const b of bindingPage.items) {
      const asset = await this.getAssetById(b.asset_id);
      if (!asset) continue;

      if (FILTERED_STATUSES.includes(asset.status)) continue;

      if (params.apply_visibility_filter && !canBindAsset(agent, asset)) continue;

      if (params.touch_usage) {
        await this.store.touchAssetUsage(asset.asset_id);
      }

      items.push({
        asset_id: asset.asset_id,
        asset_type: asset.asset_type,
        name: asset.name,
        description: asset.description ?? null,
        status: asset.status,
        visibility: asset.visibility,
        injection_mode: b.injection_mode,
        priority: b.priority,
        created_at: asset.created_at,
      });
    }

    return {
      agent: {
        agent_id: agent.agent_id,
        team_id: agent.team_id,
        owner_user_id: agent.owner_user_id,
        prompt: agent.prompt ?? null,
        visibility: agent.visibility,
        status: agent.status,
      },
      items,
      total: bindingPage.total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  // ============================================================
  // ACL
  // ============================================================
  async grantAcl(input: GrantAclInput): Promise<AclEntity> {
    const asset = await this.getAssetById(input.asset_id);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${input.asset_id}`);
    return this.store.grantAcl(input);
  }

  async revokeAcl(id: string): Promise<void> {
    await this.store.revokeAcl(id);
  }

  async listAclByAsset(assetId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<AclEntity>> {
    const page = await this.store.listAclByAsset(assetId, pagination);
    return formatListResult(page, pagination);
  }

  // ============================================================
  // Permission checking (lazy-loaded ACL)
  // ============================================================
  async checkAssetPermission(params: CheckPermissionParams): Promise<PermCheckResult> {
    const userId = await resolveUserId(this, params);
    const asset = await this.getAssetById(params.asset_id);
    if (!asset || asset.status === "archived") {
      return { allowed: false, reason: "asset_not_available" };
    }

    // owner short-circuit, no need to check members/ACL
    if (asset.owner_user_id === userId) {
      return { allowed: true, reason: "owner" };
    }

    const membership = await this.store.getTeamMember(asset.team_id, userId);

    // Run through with empty ACL first: if role default matches, allow immediately, no table lookup needed
    const action = params.action;
    const fast = checkPermission({
      user: { user_id: userId },
      asset,
      membership,
      action,
      aclRecords: [],
      agentId: params.agent_id,
      logger: this.logger,
    });
    if (fast.allowed) return fast;

    // Only when 'passes prerequisite gate but role default doesn't cover' (no_permission) requires lazy-loaded ACL re-check
    if (fast.reason !== "no_permission") return fast;
    if (membership && roleDefaultCovers(membership.role, action)) return fast;

    const aclRecords = await this.allAclRecords(params.asset_id);
    return checkPermission({
      user: { user_id: userId },
      asset,
      membership,
      action,
      aclRecords,
      agentId: params.agent_id,
      logger: this.logger,
    });
  }

  /** Filter asset list accessible by user (offset pagination after permission aggregation). */
  async listAccessibleAssets(params: ListAccessibleAssetsParams): Promise<PaginatedResult<AssetEntity>> {
    const userId = await resolveUserId(this, params);
    const action = params.action ?? "read";
    const pagination = this.pag(params);

    // visibility whitelist (server-side filtering to prevent frontend from receiving restricted data)
    const visFilter: Set<AssetEntity["visibility"]> | null = params.visibility
      ? new Set(Array.isArray(params.visibility) ? params.visibility : [params.visibility])
      : null;

    let teamIds: string[];
    if (params.team_id) {
      const member = await this.store.getTeamMember(params.team_id, userId);
      if (!member || member.status !== "active") {
        return paginateArray([], pagination);
      }
      teamIds = [params.team_id];
    } else {
      const allTeams: TeamEntity[] = [];
      let offset = 0;
      const limit = 100;
      while (true) {
        const page = await this.store.listTeamsByUser(userId, { limit, offset });
        allTeams.push(...page.items);
        if (offset + page.items.length >= page.total) break;
        offset += limit;
      }
      teamIds = allTeams.map((t) => t.team_id);
    }

    const result: AssetEntity[] = [];
    const seen = new Set<string>();

    for (const teamId of teamIds) {
      let offset = 0;
      const limit = 100;
      while (true) {
        const page = await this.store.listAssetsByTeam(
          teamId,
          { limit, offset },
          { asset_type: params.asset_type },
        );
        for (const asset of page.items) {
          if (seen.has(asset.asset_id)) continue;
          if (FILTERED_STATUSES.includes(asset.status)) continue;
          // visibility whitelist filtering (exclude before permission checking to save checkAssetPermission overhead)
          if (visFilter && !visFilter.has(asset.visibility)) continue;
          const perm = await this.checkAssetPermission({
            user_id: userId,
            asset_id: asset.asset_id,
            action,
            agent_id: params.agent_id,
          });
          if (perm.allowed) {
            seen.add(asset.asset_id);
            result.push(asset);
          }
        }
        if (offset + page.items.length >= page.total) break;
        offset += limit;
      }
    }

    result.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return paginateArray(result, pagination);
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async assertTeamExists(teamId: string): Promise<void> {
    const team = await this.store.getTeamById(teamId);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
  }

  private requireCallerId(ctx: V3AuthContext): string {
    if (!ctx.userId) {
      throw new MetadataError("permission_denied", "authentication required");
    }
    return ctx.userId;
  }

  private assertCallerIsResourceOwner(ctx: V3AuthContext, ownerUserId: string): void {
    const callerId = this.requireCallerId(ctx);
    if (callerId !== ownerUserId) {
      throw new MetadataError("permission_denied", "caller is not resource owner");
    }
  }

  private async requireActiveTeamMember(ctx: V3AuthContext, teamId: string): Promise<TeamMemberEntity> {
    const callerId = this.requireCallerId(ctx);
    const member = await this.store.getTeamMember(teamId, callerId);
    if (!member || member.status !== "active") {
      throw new MetadataError("permission_denied", "not a team member");
    }
    return member;
  }

  private async assertCallerIsTeamAdmin(ctx: V3AuthContext, teamId: string): Promise<void> {
    const member = await this.requireActiveTeamMember(ctx, teamId);
    if (member.role !== "admin") {
      throw new MetadataError("permission_denied", "caller is not team admin");
    }
  }

  private async assertCallerIsTeamOwnerOrAdmin(ctx: V3AuthContext, teamId: string): Promise<TeamEntity> {
    const callerId = this.requireCallerId(ctx);
    const team = await this.getTeamById(teamId);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    if (team.owner_user_id === callerId) return team;
    await this.assertCallerIsTeamAdmin(ctx, teamId);
    return team;
  }

  private async assertCallerIsAgentOwner(ctx: V3AuthContext, agentId: string): Promise<AgentEntity> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    this.assertCallerIsResourceOwner(ctx, agent.owner_user_id);
    return agent;
  }

  /**
   * Write permission for agent fixed assets: owner themselves, or team admin of the agent's team.
   * Used for cold start scenarios like 'admin mounts default Agent asset for new user' (referencing asset's
   * assertCallerIsAssetOwnerOrTeamAdmin precedent, allows team admin).
   */
  private async assertCallerIsAgentOwnerOrTeamAdmin(ctx: V3AuthContext, agentId: string): Promise<AgentEntity> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const callerId = this.requireCallerId(ctx);
    if (agent.owner_user_id === callerId) return agent;
    await this.assertCallerIsTeamAdmin(ctx, agent.team_id);
    return agent;
  }

  private async assertCallerIsTaskCreator(ctx: V3AuthContext, taskId: string): Promise<TaskEntity> {
    const task = await this.getTaskById(taskId);
    if (!task) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    this.assertCallerIsResourceOwner(ctx, task.creator_user_id);
    return task;
  }

  private async assertCallerIsAssetOwner(ctx: V3AuthContext, assetId: string): Promise<AssetEntity> {
    const asset = await this.getAssetById(assetId);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    this.assertCallerIsResourceOwner(ctx, asset.owner_user_id);
    return asset;
  }

  private async assertCallerIsAssetOwnerOrTeamAdmin(ctx: V3AuthContext, assetId: string): Promise<AssetEntity> {
    const asset = await this.getAssetById(assetId);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    const callerId = this.requireCallerId(ctx);
    if (asset.owner_user_id === callerId) return asset;
    await this.assertCallerIsTeamAdmin(ctx, asset.team_id);
    return asset;
  }

  // ============================================================
  // Caller-scoped mutations（L-12 / L-14）
  // ============================================================
  async createTeamForCaller(input: CreateTeamInput, ctx: V3AuthContext): Promise<TeamEntity> {
    this.assertCallerIsResourceOwner(ctx, input.owner_user_id);
    return this.createTeam(input);
  }

  async updateTeamForCaller(
    teamId: string,
    patch: Partial<TeamEntity>,
    ctx: V3AuthContext,
  ): Promise<TeamEntity> {
    await this.assertCallerIsTeamOwnerOrAdmin(ctx, teamId);
    return this.updateTeam(teamId, patch);
  }

  async deleteTeamsForCaller(teamIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    for (const teamId of teamIds) {
      await this.assertCallerIsTeamOwnerOrAdmin(ctx, teamId);
    }
    return this.deleteTeams(teamIds);
  }

  async addTeamMemberForCaller(input: AddTeamMemberInput, ctx: V3AuthContext): Promise<TeamMemberEntity> {
    await this.assertCallerIsTeamAdmin(ctx, input.team_id);
    const callerId = this.requireCallerId(ctx);
    // 'Add member' shouldn't be used to change own role; selecting self + role=member would downgrade admin.
    if (input.user_id === callerId) {
      throw new MetadataError("permission_denied", "cannot add yourself as a team member");
    }
    return this.addTeamMember(input);
  }

  async removeTeamMemberForCaller(teamId: string, userId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertCallerIsTeamAdmin(ctx, teamId);
    const team = await this.getTeamById(teamId);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    if (userId === team.owner_user_id) {
      throw new MetadataError("permission_denied", "cannot remove team owner");
    }
    return this.removeTeamMember(teamId, userId);
  }

  async listTeamMembersForCaller(
    teamId: string,
    ctx: V3AuthContext,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<TeamMemberView>> {
    await this.requireActiveTeamMember(ctx, teamId);
    const page = await this.store.listTeamMembersWithProfile(teamId, pagination);
    return formatListResult(page, pagination);
  }

  async getTeamMemberForCaller(
    teamId: string,
    userId: string,
    ctx: V3AuthContext,
  ): Promise<TeamMemberView> {
    await this.requireActiveTeamMember(ctx, teamId);
    const member = await this.store.getTeamMemberWithProfile(teamId, userId);
    if (!member) {
      throw new MetadataError("member_not_found", `member not found: ${teamId}/${userId}`);
    }
    return member;
  }

  async createAgentForCaller(input: CreateAgentInput, ctx: V3AuthContext): Promise<AgentEntity> {
    await this.assertTeamExists(input.team_id);
    await this.requireActiveTeamMember(ctx, input.team_id);
    // owner themselves, or team admin of the team (admin creating default Agent for new user)
    const callerId = this.requireCallerId(ctx);
    if (input.owner_user_id !== callerId) {
      await this.assertCallerIsTeamAdmin(ctx, input.team_id);
    }
    return this.createAgent(input);
  }

  async updateAgentForCaller(
    agentId: string,
    patch: Partial<AgentEntity>,
    ctx: V3AuthContext,
  ): Promise<AgentEntity> {
    await this.assertCallerIsAgentOwner(ctx, agentId);
    return this.updateAgent(agentId, patch);
  }

  async deleteAgentsForCaller(agentIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    for (const agentId of agentIds) {
      await this.assertCallerIsAgentOwner(ctx, agentId);
    }
    return this.deleteAgents(agentIds);
  }

  async archiveAgentForCaller(agentId: string, ctx: V3AuthContext): Promise<AgentEntity> {
    await this.assertCallerIsAgentOwner(ctx, agentId);
    return this.archiveAgent(agentId);
  }

  async createTaskForCaller(input: CreateTaskInput, ctx: V3AuthContext): Promise<TaskEntity> {
    await this.assertTeamExists(input.team_id);
    await this.requireActiveTeamMember(ctx, input.team_id);
    this.assertCallerIsResourceOwner(ctx, input.creator_user_id);
    return this.createTask(input);
  }

  async updateTaskForCaller(
    taskId: string,
    patch: Partial<TaskEntity>,
    ctx: V3AuthContext,
  ): Promise<TaskEntity> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.updateTask(taskId, patch);
  }

  async deleteTasksForCaller(taskIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    for (const taskId of taskIds) {
      await this.assertCallerIsTaskCreator(ctx, taskId);
    }
    return this.deleteTasks(taskIds);
  }

  async archiveTaskForCaller(taskId: string, ctx: V3AuthContext): Promise<TaskEntity> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.archiveTask(taskId);
  }

  async linkTaskAgentForCaller(
    taskId: string,
    agentId: string,
    roleInTask: string | undefined,
    ctx: V3AuthContext,
  ): Promise<TaskAgentEntity> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.linkTaskAgent(taskId, agentId, roleInTask);
  }

  async unlinkTaskAgentForCaller(taskId: string, agentId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.unlinkTaskAgent(taskId, agentId);
  }

  async appendParticipationLogForCaller(
    input: AppendParticipationLogInput,
    ctx: V3AuthContext,
  ): Promise<ParticipationLogEntity> {
    await this.requireActiveTeamMember(ctx, input.team_id);
    const callerId = this.requireCallerId(ctx);
    if (input.user_id !== callerId) {
      await this.assertCallerIsTeamAdmin(ctx, input.team_id);
    }
    return this.appendParticipationLog(input);
  }

  async listParticipationLogsForCaller(
    filter: ParticipationLogFilter,
    ctx: V3AuthContext,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<ParticipationLogEntity>> {
    await this.requireActiveTeamMember(ctx, filter.team_id);
    return this.listParticipationLogs(filter, pagination);
  }

  async createAssetForCaller(input: CreateAssetInput, ctx: V3AuthContext): Promise<AssetEntity> {
    await this.assertTeamExists(input.team_id);
    await this.requireActiveTeamMember(ctx, input.team_id);
    this.assertCallerIsResourceOwner(ctx, input.owner_user_id);
    return this.createAsset(input);
  }

  async updateAssetForCaller(
    assetId: string,
    patch: Partial<AssetEntity>,
    ctx: V3AuthContext,
  ): Promise<AssetEntity> {
    await this.assertCallerIsAssetOwner(ctx, assetId);
    return this.updateAsset(assetId, patch);
  }

  async deleteAssetsForCaller(assetIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    // Skip owner check for non-existent ids (aligned with store layer idempotency success); existing ones must be owner.
    for (const assetId of assetIds) {
      const existing = await this.getAssetById(assetId);
      if (!existing) continue;
      await this.assertCallerIsAssetOwner(ctx, assetId);
    }
    return this.deleteAssets(assetIds);
  }

  async touchAssetUsageForCaller(assetId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertCallerIsAssetOwner(ctx, assetId);
    return this.touchAssetUsage(assetId);
  }

  /**
   * Bulk upfront parsing for `/v3/chat-memory/clear`: maps asset_id to (team, agent).
   *
   * Semantics (aligned with requirement 'reject bulk if any memory_id is invalid'):
   *   - Every id must exist and asset_type === "chat_memory";
   *   - Must be able to locate corresponding agent under the asset's team;
   *   - If any condition unmet, throws MetadataError immediately, bulk not executed.
   *
   * **Does not perform user-level Owner check**: internal data plane trust model is Bearer +
   * x-tdai-service-id i.e., admin-level credentials (consistent with L0-L3 delete APIs).
   * "Only asset Owner can operate" is done by panel backend before forwarding.
   *
   * Only performs validation and reading, **does not modify any asset fields** — clear only deletes content, leaves asset untouched.
   */
  async resolveChatMemoryTargets(
    assetIds: string[],
  ): Promise<Array<{ asset_id: string; team_id: string; agent_id: string }>> {
    const targets: Array<{ asset_id: string; team_id: string; agent_id: string }> = [];
    // Agent list for same team will be reused repeatedly in bulk scenario, cache by team once.
    const agentIdsByTeam = new Map<string, string[]>();

    for (const assetId of assetIds) {
      const asset = await this.getAssetById(assetId);
      if (!asset) {
        throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
      }
      if (asset.asset_type !== "chat_memory") {
        throw new MetadataError(
          "asset_type_mismatch",
          `asset ${assetId} is not a chat_memory asset (got ${asset.asset_type})`,
        );
      }

      let agentIds = agentIdsByTeam.get(asset.team_id);
      if (!agentIds) {
        agentIds = await this.listAllAgentIdsByTeam(asset.team_id);
        agentIdsByTeam.set(asset.team_id, agentIds);
      }

      const agentId = resolveChatMemoryAgentId(assetId, asset.team_id, agentIds);
      if (!agentId) {
        throw new MetadataError(
          "agent_not_found",
          `cannot resolve owning agent for chat_memory asset ${assetId} in team ${asset.team_id}`,
        );
      }
      targets.push({ asset_id: assetId, team_id: asset.team_id, agent_id: agentId });
    }
    return targets;
  }

  /**
   * Fetch all agent_ids under a team (paginated traversal, max 100 per page).
   * Added hard limit to prevent abnormally large teams from exhausting memory.
   */
  private async listAllAgentIdsByTeam(teamId: string): Promise<string[]> {
    const PAGE = 100;
    const MAX_AGENTS = 10_000;
    const ids: string[] = [];
    for (let offset = 0; offset < MAX_AGENTS; offset += PAGE) {
      const page = await this.store.listAgentsByTeam(teamId, { limit: PAGE, offset });
      for (const agent of page.items) ids.push(agent.agent_id);
      if (page.items.length < PAGE) break;
    }
    return ids;
  }

  async setAgentFixedAssetsForCaller(
    agentId: string,
    bindings: FixedAssetBindingInput[],
    ctx: V3AuthContext,
  ): Promise<void> {
    await this.assertCallerIsAgentOwnerOrTeamAdmin(ctx, agentId);
    return this.setAgentFixedAssets(agentId, bindings);
  }

  async grantAclForCaller(input: GrantAclInput, ctx: V3AuthContext): Promise<AclEntity> {
    await this.assertCallerIsAssetOwner(ctx, input.asset_id);
    const callerId = this.requireCallerId(ctx);
    if (input.granted_by !== callerId) {
      throw new MetadataError("permission_denied", "granted_by must match caller");
    }
    return this.grantAcl(input);
  }

  async revokeAclForCaller(id: string, ctx: V3AuthContext): Promise<void> {
    const acl = await this.store.getAclById(id);
    if (!acl) throw new MetadataError("acl_not_found", `acl not found: ${id}`);
    await this.assertCallerIsAssetOwner(ctx, acl.asset_id);
    return this.revokeAcl(id);
  }

  async listAclByAssetForCaller(
    assetId: string,
    ctx: V3AuthContext,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<AclEntity>> {
    await this.assertCallerIsAssetOwnerOrTeamAdmin(ctx, assetId);
    return this.listAclByAsset(assetId, pagination);
  }
}
