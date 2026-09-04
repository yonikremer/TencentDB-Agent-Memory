/**
 * Entity reference existence validator.
 *
 * Used by v3-meta-router handler to validate input prefixed metadata IDs before business logic calls.
 * Checks if they exist in store; throws MetadataError (→ 404) if not found.
 *
 * Usage:
 *   await requireEntity(svc, EntityType.User, d.user_id);
 */

import { MetadataService, MetadataError } from "../service/metadata-service.js";

/** Metadata entity type enum, used for requireEntity calls. */
export const enum EntityType {
  User = "user",
  Team = "team",
  Agent = "agent",
  Task = "task",
  Asset = "asset",
  UserKey = "userKey",
  Acl = "acl",
}

const LOOKUP: Record<EntityType, (svc: MetadataService, id: string) => Promise<unknown>> = {
  [EntityType.User]: (svc, id) => svc.getUserById(id),
  [EntityType.Team]: (svc, id) => svc.getTeamById(id),
  [EntityType.Agent]: (svc, id) => svc.getAgentById(id),
  [EntityType.Task]: (svc, id) => svc.getTaskById(id),
  [EntityType.Asset]: (svc, id) => svc.getAssetById(id),
  [EntityType.UserKey]: (svc, id) => svc.rawStore.getUserKeyById(id),
  [EntityType.Acl]: (svc, id) => svc.rawStore.getAclById(id),
};

const ERROR_CODE: Record<EntityType, string> = {
  [EntityType.User]: "user_not_found",
  [EntityType.Team]: "team_not_found",
  [EntityType.Agent]: "agent_not_found",
  [EntityType.Task]: "task_not_found",
  [EntityType.Asset]: "asset_not_found",
  [EntityType.UserKey]: "user_key_not_found",
  [EntityType.Acl]: "acl_not_found",
};

/**
 * Validate existence of a single entity ID, throw MetadataError (mapped to 404) if not found.
 *
 * @param svc  MetadataService of current instance
 * @param type Entity type enum
 * @param id   Entity ID with prefix
 */
export async function requireEntity(
  svc: MetadataService,
  type: EntityType,
  id: string,
): Promise<void> {
  const entity = await LOOKUP[type](svc, id);
  if (!entity) {
    throw new MetadataError(ERROR_CODE[type], `not found: ${id}`);
  }
}
