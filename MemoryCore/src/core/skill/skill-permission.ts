/**
 * skill-permission — Pure permission validation functions
 *
 * Three assertions:
 *   - assertOwner: whether agent is the owner of head
 *   - assertTeamMatch: whether row belongs to requested team (mismatch -> 404 to avoid leaking existence)
 *   - assertVersionFresh: optimistic lock check
 *
 * Error codes aligned with design document §3.6.
 */

import type { Skill } from "./types.js";

export type SkillPermissionErrorCode =
  | "SKILL_NOT_OWNER"     // 40301
  | "SKILL_TEAM_MISMATCH" // 40302 (external behavior same as NOT_FOUND to avoid existence side-channel)
  | "SKILL_NOT_FOUND"     // 40401
  | "SKILL_VERSION_STALE"; // 40901

export class SkillPermissionError extends Error {
  constructor(public readonly code: SkillPermissionErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillPermissionError";
  }
}

/**
 * The (teamId, agentId) tuple must match headRow; otherwise throws 40301.
 *
 * team_id + agent_id uniquely identifies an agent's ownership—
 * identical agent_id values may appear across different teams, so checking agent_id alone is insufficient.
 */
export function assertOwner(headRow: Skill, agentId: string, teamId?: string): void {
  if (teamId && headRow.team_id !== teamId) {
    throw new SkillPermissionError(
      "SKILL_NOT_OWNER",
      `team ${teamId} does not match (actual=${headRow.team_id})`,
    );
  }
  if (headRow.owner_agent_id !== agentId) {
    throw new SkillPermissionError(
      "SKILL_NOT_OWNER",
      `agent ${agentId} is not the owner (owner=${headRow.owner_agent_id})`,
    );
  }
}

/**
 * row.team_id must equal the requested teamId; mismatch is treated as NOT_FOUND (does not leak existence).
 */
export function assertTeamMatch(row: Skill | null, teamId: string): asserts row is Skill {
  if (!row || row.team_id !== teamId) {
    throw new SkillPermissionError("SKILL_NOT_FOUND");
  }
}

/**
 * Optimistic lock: expected_version is required and must strictly match head.version.
 * Throws SKILL_VERSION_STALE on mismatch, rejecting writes to prevent concurrent overwrites.
 */
export function assertVersionFresh(headRow: Skill, expected: number): void {
  if (expected !== headRow.version) {
    throw new SkillPermissionError(
      "SKILL_VERSION_STALE",
      `expected version ${expected}, head is ${headRow.version}`,
    );
  }
}
