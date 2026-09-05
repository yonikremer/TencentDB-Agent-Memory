/**
 * services/index.ts — Domain Service Facade
 *
 * Components are uniformly imported from @/services.
 * Team / Agent / Task have been switched to backend pipeline A (services/backendStore.ts,
 * internally calling the meta interface of @/lib/teamApi);
 * The rest (accounts / user profile / api key / asset scope / user asset / agent template)
 * have no corresponding backend capabilities for now, and still use the local localStorage demo layer (split into separate files according to responsibilities), to be replaced one by one later.
 */

// ===== Types =====
export type {
  TeamMember,
  Team,
  Task,
  TaskStatus,
  TaskSourceType,
  Agent,
} from './backendStore';
export type { AgentTemplate } from './agent-template-store';
export type { AssetKind, AssetConfigScope, AssetScopeRecord } from './asset-scope-store';
export type { UserAssetKind, UserAsset } from './user-asset-store';
export type { MockAccount } from './account-store';

// ===== Team / Agent / Task service (Chain A, Backend Persistence) =====
export {
  readActiveTeamId,
  writeActiveTeamId,
  useTeams,
  useAgents,
  useTasks,
  readActiveTeamAgents,
  isTeamAdmin,
  isTeamMember,
  roleInTeam,
  canManageAsset,
  canEditTask,
  canDeleteTask,
  invalidateBackendCache,
  clearBackendCache,
  invalidateTeamCache,
  writeAgentUiMeta,
  createTaskAsync as createTask,
  deleteTaskAsync as deleteTask,
  updateTaskAsync as updateTask,
  updateTaskStatusAsync as updateTaskStatus,
} from './backendStore';

// ===== Agent template service =====
export {
  readAgentTemplates,
  createAgentTemplate,
  deleteAgentTemplate,
} from './agent-template-store';

// ===== Account service =====
export {
  findAccountByEmail,
  findAccountByUsername,
  verifyAccountCredentials,
  createAccount,
  batchCreateAccounts,
  changePassword,
  setAccountPassword,
  updateAccountEmail,
  getAllAccounts,
} from './account-store';

// ===== User display name service =====
export {
  useUserDisplayName,
  seedDisplayNameCache,
} from './user-profile-store';

// ===== API Key service (Link A auxiliary REST, see @/lib/teamApi's userKeysApi, ApiKeyPanel calls directly)=====

// ===== Asset scope service =====
export {
  getAssetConfigScope,
  setAssetConfigScope,
  canManageAssetScope,
  useAssetConfigScopes,
} from './asset-scope-store';

// ===== User asset service =====
export {
  createUserAsset,
  updateUserAsset,
  deleteUserAsset,
  getUserAssetsByOwner,
  getTeamVisibleAssets,
} from './user-asset-store';

// ===== Permission helpers (global admin check, pure frontend auth state implementation, no backend concept) =====
export { isGlobalAdmin } from './permissions';

// ===== Role hook =====
export { useCurrentRole } from './useCurrentRole';
export type { TeamRole } from './useCurrentRole';
