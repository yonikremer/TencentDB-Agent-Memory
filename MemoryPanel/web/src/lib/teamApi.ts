/**
 * teamApi.ts — Control API barrel re-export。
 *
 * Original 1400+ line file has been split by business domain into lib/api/:
 *   - api/base.ts           Infrastructure (ApiError / request / metaPost / metaListAll / …)
 *   - api/types.ts          Cross-module shared types
 *   - api/meta-instances    Select instance before login
 *   - api/auth.ts           Login verification + environment binding
 *   - api/teams.ts         Team + Member
 *   - api/agents.ts        Agent
 *   - api/tasks.ts         Task + ParticipationLog
 *   - api/users.ts         User + UserKey + UserConfig
 *   - api/assets.ts        Asset
 *   - api/skills.ts        Skill data
 *   - api/chat-memory.ts   Chat Memory
 *
 * External consumers can continue to `import { xxx } from '@/lib/teamApi'`; no path changes are needed.
 * For new code, it is recommended to import directly from `@/lib/api/xxx`, referencing as needed, to reduce bundle size.
 */

// ── Infrastructure ──
export { ApiError, onUnauthorized, clearSessionCache, PANEL_CAPABILITIES } from './api/base';

// ── Meta Instances ──
export { metaInstancesApi, type MetadataInstance } from './api/meta-instances';

// ── Auth + Environment Bindings ──
export { authVerifyApi, environmentBindingsApi, type EnvironmentBinding } from './api/auth';

// ── Teams + Members ──
export { teamsApi, membersApi } from './api/teams';

// ── Agents ──
export {
  agentsApi,
  type AgentTemplateConfig,
  type AgentTemplateAssetIds,
} from './api/agents';

// ── Tasks + Participation Logs ──
export {
  tasksApi,
  participationLogsApi,
  type TaskStatus,
  type TaskSourceType,
  type BackendTask,
  type BackendTaskAgent,
  type BackendTaskWithAgents,
  type ParticipationLogEntity,
} from './api/tasks';

// ── Users + UserKeys + UserConfig ──
export {
  usersApi,
  userKeysApi,
  userConfigApi,
  type CreateUserResult,
  type UserKey,
  type AssetCapabilityKey,
  type UserConfigItem,
  type UserConfigView,
  type AssetCapabilityConfig,
} from './api/users';

// ── Assets ──
export { assetsApi } from './api/assets';

// ── Skills ──
export {
  skillApi,
  type SkillSummary,
  type SkillManifestEntry,
  type SkillDetail,
  type SkillResourcePayload,
  type SkillFileContent,
} from './api/skills';

// ── Chat Memory ──
export {
  chatMemoryApi,
  type ChatMemoryBlock,
  type ChatMemoryLayerItem,
  type ChatMemorySearchHit,
} from './api/chat-memory';

// ── Shared Types (Passed through from types.ts) ──
export type {
  MetaEnvelope,
  PaginatedResult,
  PublicUser,
  Team,
  TeamMember,
  Agent,
  AssetType,
  AssetStatus,
  Asset,
  AgentAssetView,
  FixedAssetBinding,
} from './api/types';
