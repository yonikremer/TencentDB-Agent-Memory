/**
 * asset-scope-store.ts — Unified configurable scope overlay for assets (local localStorage).
 *
 * Extract from the original demoStore.ts (independent responsibility: persistence method for the team/agent/task ontology
 *, a layer of general product semantics superimposed on the 5 asset categories).
 *
 * Requirement: Each owner can manage "their own assets", and the selection of such an asset is
 *   - team     Configurable within the team: all team members can configure / edit this asset
 *   - private  Private to self only: only the owner (plus team admin / global admin) can configure / edit
 *
 * This layer covers all 5 asset types (agent / skill / code / wiki / memory). Different asset
 * Different underlying data sources (backendStore / mock / backend knowledgeApi), but the "configurable scope"
 * This is a unified product semantics, so we extract a lightweight overlay separately: by `${kind}:${asset_id}`
 * Store a record, decoupled from the asset itself. After the backend goes live, it can be replaced by an asset_acl table, no UI changes needed.
 */

import type { Team } from './backendStore';
import { isTeamAdmin, isTeamMember } from './backendStore';
import { emitChange, safeParse, useChangeNotifier } from './storage-utils';

const ASSET_SCOPES_KEY = 'tdai-memory.assetScopes.v1';

export type AssetKind = 'agent' | 'skill' | 'code' | 'wiki' | 'memory';
export type AssetConfigScope = 'team' | 'private';

export interface AssetScopeRecord {
  scope: AssetConfigScope;
  /** The owner of this asset — who has the right to modify its configurable scope. The first person to set up an unowned asset becomes the owner. */
  owner_user_id: string;
  updated_at_ms: number;
}

type AssetScopeMap = Record<string, AssetScopeRecord>;

function scopeKey(kind: AssetKind, asset_id: string): string {
  return `${kind}:${asset_id}`;
}

function readAssetScopeMap(): AssetScopeMap {
  if (typeof window === 'undefined') return {};
  return safeParse<AssetScopeMap>(localStorage.getItem(ASSET_SCOPES_KEY), {});
}

function writeAssetScopeMap(map: AssetScopeMap): void {
  try {
    localStorage.setItem(ASSET_SCOPES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  emitChange();
}

/**
 * Read the configurable scope of a certain asset.
 * For assets not explicitly configured, the default is `team` (configurable within the team) — consistent with the current state (shared team pool),
 * owner falls back to the owner bundled with the asset (fallbackOwner).
 */
export function getAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  fallbackOwner = ''
): { scope: AssetConfigScope; owner_user_id: string } {
  const rec = readAssetScopeMap()[scopeKey(kind, asset_id)];
  if (rec) return { scope: rec.scope, owner_user_id: rec.owner_user_id || fallbackOwner };
  return { scope: 'team', owner_user_id: fallbackOwner };
}

/**
 * Set the configurable scope of a certain asset.
 * owner is fixed once determined (take existing record → asset's built-in owner → current operator).
 * The caller should first use canManageAssetScope for UI interception; no repeated authentication here (demo stage).
 */
export function setAssetConfigScope(
  kind: AssetKind,
  asset_id: string,
  scope: AssetConfigScope,
  actor: string,
  fallbackOwner = ''
): void {
  const map = readAssetScopeMap();
  const key = scopeKey(kind, asset_id);
  const owner = map[key]?.owner_user_id || fallbackOwner || actor;
  map[key] = { scope, owner_user_id: owner, updated_at_ms: Date.now() };
  writeAssetScopeMap(map);
}

/**
 * Who can modify the configurable range of an asset:
 *   - Global admin / team admin → can modify (governance requires)
 *   - The owner themselves → can modify ("managing their own assets")
 *   - Assets without an owner (ownerUserId is empty, e.g., backend Code/Wiki has no owner concept)
 *     → Any team member can set it, and the first setter becomes the owner
 */
export function canManageAssetScope(
  ownerUserId: string,
  team: Team | null | undefined,
  user_id: string,
  isAdmin?: boolean
): boolean {
  if (!user_id) return false;
  // The global admin no longer automatically gains asset management privileges, consistent with regular members:
  // Only the owner or team admin can modify the configurable scope of assets.
  // The isAdmin parameter is retained only for backward compatibility with existing caller signatures (can be removed in future cleanup).
  void isAdmin;
  if (team && isTeamAdmin(team, user_id)) return true;
  if (!ownerUserId) return isTeamMember(team, user_id);
  return ownerUserId === user_id;
}

/**
 * Subscribe to changes in the configurable scope of subscribed assets.
 * The component uses it to automatically re-render after setAssetConfigScope (the return value is an incrementing tick, used only to trigger a refresh).
 */
export function useAssetConfigScopes(): number {
  return useChangeNotifier();
}
