/**
 * chat-memory-governance.ts —— chat_memory asset-specific ownership/shared data model.
 *
 * Not shared with skill / wiki / code: each asset has a different ownership model, and hard abstractions will constrain future development.
 *
 * Data shape:
 *    Each Agent has a ChatMemoryAgentRel attached (shared switch + borrow ≤ 2)
 *
 * Persistence:
 *    The backend schema hasn't been finalized for the real fields in chat_memory_rel; for the demo phase, put it in
 *   The "chat_memory" namespace of Agent.metadata_json shares the same contract with the frontend.
 *   After adding the backend field, switch the implementation of readChatMemoryRel / writeChatMemoryRel to the real field.
 */

/** Borrowing Limit —— Exclusive to chat_memory. If other assets have a borrowing concept in the future, define it yourself. */
export const MAX_IMPORTED_AGENTS = 2;

export interface ChatMemoryAgentRel {
  /** Whether one's own memory is visible to the entire team. In this phase, the UI is locked to true ("display globally if any exists"). */
  memory_shared_with_team: boolean;
  /** The borrowed agent_id (≤ MAX_IMPORTED_AGENTS, must be in the same team, not including oneself, deduplicated). */
  imported_agent_ids: string[];
}

export const DEFAULT_CHAT_MEMORY_REL: ChatMemoryAgentRel = {
  memory_shared_with_team: true,
  imported_agent_ids: [],
};

export type ValidateResult = { ok: true } | { ok: false; reason: string };

/** Validate the rules for borrowed self ids; shared by frontend and backend. */
export function validateImportedAgents(
  selfId: string,
  ids: string[],
  teamAgents: Array<{ agent_id: string }>,
): ValidateResult {
  if (!Array.isArray(ids)) return { ok: false, reason: 'imported_agent_ids must be an array' };
  if (ids.length > MAX_IMPORTED_AGENTS) {
    return { ok: false, reason: `At most ${MAX_IMPORTED_AGENTS} agents can be borrowed` };
  }
  const teamSet = new Set(teamAgents.map((a) => a.agent_id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || typeof id !== 'string') return { ok: false, reason: 'Invalid agent_id exists' };
    if (id === selfId) return { ok: false, reason: 'Cannot borrow your own memory' };
    if (!teamSet.has(id)) return { ok: false, reason: `agent_id "${id}" is not in the current team` };
    if (seen.has(id)) return { ok: false, reason: 'Duplicate agent exists in the borrow list' };
    seen.add(id);
  }
  return { ok: true };
}

const METADATA_NS = 'chat_memory';

interface AgentLike {
  agent_id: string;
  metadata_json?: string;
}

/** Read chat_memory_rel from Agent; return default value when missing. Never throw exceptions. */
export function readChatMemoryRel(agent: AgentLike): ChatMemoryAgentRel {
  if (!agent.metadata_json) return { ...DEFAULT_CHAT_MEMORY_REL };
  try {
    const meta = JSON.parse(agent.metadata_json) as Record<string, unknown>;
    const slot = meta?.[METADATA_NS];
    if (slot && typeof slot === 'object') {
      return normalizeRel(slot as Partial<ChatMemoryAgentRel>);
    }
  } catch {
    /* Invalid old value, use default */
  }
  return { ...DEFAULT_CHAT_MEMORY_REL };
}

/** Merge chat_memory_rel back into metadata_json, returning the new JSON string (without modifying the input parameter). */
export function writeChatMemoryRel(
  prevMetadataJson: string | undefined,
  rel: ChatMemoryAgentRel,
): string {
  let meta: Record<string, unknown> = {};
  if (prevMetadataJson) {
    try {
      const parsed = JSON.parse(prevMetadataJson);
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* Discard */
    }
  }
  meta[METADATA_NS] = normalizeRel(rel);
  return JSON.stringify(meta);
}

function normalizeRel(input: Partial<ChatMemoryAgentRel>): ChatMemoryAgentRel {
  return {
    memory_shared_with_team:
      typeof input.memory_shared_with_team === 'boolean'
        ? input.memory_shared_with_team
        : DEFAULT_CHAT_MEMORY_REL.memory_shared_with_team,
    imported_agent_ids: Array.isArray(input.imported_agent_ids)
      ? Array.from(new Set(input.imported_agent_ids.filter((x) => typeof x === 'string'))).slice(
          0,
          MAX_IMPORTED_AGENTS,
        )
      : [],
  };
}
