/**
 * chat_memory asset ID generation rules.
 *
 * Convention: Each (team, agent) combination corresponds to **one** stable chat_memory asset, asset_id
 * is constructed from team_id and agent_id:
 *
 *     chat_memory-{team_id}-{agent_id}
 *
 * This deterministic ID makes the write path automatically idempotent — no matter how many times same (team, agent) is requested,
 * the calculated asset_id is identical, and store layer primary key constraints naturally intercept duplicate inserts.
 *
 * Forward concatenation doesn't need reversing. `/v3/chat-memory/clear` needs to locate (team, agent) from asset_id
 * to clear content, but **does not split string** — team_id / agent_id internally
 * might contain `-`, splitting causes ambiguity. Reverse locating uniformly uses `resolveChatMemoryAgentId`:
 * concatenating asset's known team_id + candidate agent_id and comparing, confirming upon match.
 */

/** chat_memory asset ID prefix. */
export const CHAT_MEMORY_ASSET_PREFIX = "chat_memory-";

/** Stably generate a chat_memory asset ID corresponding to (team, agent). */
export function buildChatMemoryAssetId(teamId: string, agentId: string): string {
  return `${CHAT_MEMORY_ASSET_PREFIX}${teamId}-${agentId}`;
}

/**
 * Find the agent_id matching assetId from candidate agent list.
 *
 * Uses forward concatenation comparison instead of string splitting, so it's still correct when team_id / agent_id contains `-`.
 *
 * @param assetId    chat_memory asset ID
 * @param teamId     team_id on the asset record (authoritative value, not guessed from assetId)
 * @param agentIds   candidate agent_id list under the team
 * @returns          matched agent_id; undefined if no match
 */
export function resolveChatMemoryAgentId(
  assetId: string,
  teamId: string,
  agentIds: Iterable<string>,
): string | undefined {
  for (const agentId of agentIds) {
    if (buildChatMemoryAssetId(teamId, agentId) === assetId) return agentId;
  }
  return undefined;
}
