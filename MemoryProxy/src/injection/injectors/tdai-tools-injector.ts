/**
 * TdaiMemoryToolsInjector — inject a static `<tdai_memory_tools>` text block
 * that teaches the LLM to curl `<proxy>/memory-bridge/v3/*` for TDAI memory
 * read operations.
 *
 * Isomorphic to skill-tools-injector design (see docs/design/2026-06-17-team-skill-proxy-runtime.md §4):
 *
 *   Why static (NOT native tool defs):
 *     The agent host (IDE / Claude Code) does not recognize native tools; instead, let the LLM use existing Bash
 *     tools to curl a proxy path. The proxy acts as a reverse proxy to tdai gateway, injecting
 *     IdFields + Bearer in the process. This rules out LLM identity spoofing + prevents token leaking into prompt.
 *
 *   Tools collection (**read-only**, statically injected into system prompt, cache friendly):
 *     - tdai_memory_search       L1 dual-path hybrid search (atomic/search)
 *     - tdai_atomic_query        L1 by type / time / pagination (atomic/query)
 *     - tdai_conversation_search L0 conversation hybrid search (conversation/search)
 *     - tdai_conversation_query  L0 retrieve history by session (conversation/query)
 *     - tdai_scenario_ls         L2 list scene_blocks path index
 *     - tdai_read_scene          L2 read full text by path
 *
 *   Design trade-offs:
 *     - L0/L1 are **no longer auto-recalled** and injected into user prompt each round (would break KV/prompt cache),
 *       switched to static tools for on-demand retrieval; stable system prompt → hits prompt cache.
 *     - L3 (persona) is **directly injected** into system by tdai-profile-memory-injector, no tools needed.
 *     - L2 index is also directly injected into system (`<l2_scene_index>`), body fetched on-demand using read_scene.
 *
 *   Write operations (atomic/update / conversation/delete / scenario/write / scenario/rm / core/write)
 *   are not in the bridge allowlist; writes are controlled by main-link injectors.
 *
 *   Injection point: `system.suffix` (unlike skill which is `tools.append`, because we no longer use
 *   native tools). Append a blurb at the end of system prompt to tell the LLM these endpoints
 *   exist and how to call them.
 */

import type {
  AgentContext,
  AnchorTarget,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
  PrewarmInput,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";

export interface TdaiMemoryToolsInjectorConfig {
  /**
   * Base URL the LLM should curl. Filled into every curl recipe.
   * E.g. `http://127.0.0.1:8096`. Trailing slash trimmed.
   */
  proxyBaseUrl: string;
}

/** Renders the entire `<tdai_memory_tools>` text block, pure function for easy testing. */
export function renderTdaiMemoryToolsBlock(
  proxyBaseUrl: string,
  sessionId?: string,
  spaceId?: string,
): string {
  const base = proxyBaseUrl.replace(/\/$/, "");
  const bridge = `${base}/memory-bridge/v3`;
  // Gateway requires `x-tdai-service-id: <spaceId>` to pass; `x-conversation-id`
  // allows proxy to reuse identity from session (user_id / team_id / agent_id).
  const sessionHeader = sessionId ? ` -H 'x-conversation-id: ${sessionId}'` : "";
  const tenantHeader = spaceId ? ` -H 'x-tdai-service-id: ${spaceId}'` : "";
  const authHeader = `${tenantHeader}${sessionHeader}`;

  const lines: string[] = [
    "<tdai_memory_tools>",
    "**These are memory capabilities you can actively call** (not documentation), used via Bash + curl.",
    "This set of TDAI memory capabilities has equal priority with Claude Code's native Memory/MEMORY.md; when dealing with memory, do not only search local MEMORY.md.",
    "When users ask about identity/history/preferences/past conclusions/project agreements, you must first use the TDAI memory tools below to query, and then answer based on the query results.",
    "Do NOT say 'I don't have this tool / requires MCP / can only check local memory' — You have TDAI memory tools, use the curl commands below.",
    "",
    "Usage: Execute curl in Bash targeting the proxy's memory-bridge path. Proxy will automatically inject identity auth (team_id/user_id/agent_id), body only needs business fields. If the current Agent is bound to multiple chat_memory assets, search interfaces will by default search self + imported memories simultaneously, and return source_agent_id/source_agent_name/source_agent_role in the results.",
    "",
    "Coverage scope:",
    "- L3 (persona long-term profile) and L2 scene index (`<l2_scene_index>`) are directly injected into system, no need to query;",
    "- L2 full text is read on demand using tdai_read_scene;",
    "- L0/L1 (raw dialogue / atomic memory) are **no longer auto-recalled** each round (which breaks KV cache), actively call tools to retrieve when needed.",
    "",
    "  <tool name=\"tdai_memory_search\">",
    `    curl: ${bridge}/atomic/search`,
    `    body: {"query": "<text>", "limit": 5}`,
    "    use:  Search L1 atomic memory (dual-path hybrid: dense vector + BM25), sorted by relevance. Defaults to cross-searching self + imported memories of the current Agent; source_agent_* in the returned items indicates origin. Suitable for recalling user preferences, historical conclusions, rules, etc.",
    "    returns: {code, data: {items: [...], searched_agents: [...]}} — hits are in data.items[].",
    "  </tool>",
    "",
    "  <tool name=\"tdai_atomic_query\">",
    `    curl: ${bridge}/atomic/query`,
    `    body: {"type": "?episodic|persona|instruction", "limit": 20, "offset": 0, "time_start": "?ISO", "time_end": "?ISO"}`,
    "    use:  Pull L1 memory by type / time window / pagination (no semantic search).",
    "  </tool>",
    "",
    "  <tool name=\"tdai_conversation_search\">",
    `    curl: ${bridge}/conversation/search`,
    `    body: {"query": "<text>", "limit": 5, "session_id": "?<sid>"}`,
    "    use:  Search within L0 raw dialogue (finer granularity than atomic_search, finds specific original messages / quotes / timelines). Defaults to cross-searching self + imported memories of the current Agent; source_agent_* in the returned items indicates origin.",
    "    returns: {code, data: {messages: [...], searched_agents: [...]}} — hits are in data.messages[] (Note: different from atomic_search's data.items).",
    "  </tool>",
    "",
    "  <tool name=\"tdai_conversation_query\">",
    `    curl: ${bridge}/conversation/query`,
    `    body: {"session_id": "<sid>", "limit": 50, "offset": 0}`,
    "    use:  Retrieve L0 historical messages in order by session.",
    "  </tool>",
    "",
    "  <tool name=\"tdai_scenario_ls\">",
    `    curl: ${bridge}/scenario/ls`,
    `    body: {"path_prefix": "?optional prefix"}`,
    "    use:  List L2 scene_blocks path index (includes summary, excludes full text). System usually already injects the index, use this when refreshing/filtering by prefix is needed.",
    "  </tool>",
    "",
    "  <tool name=\"tdai_read_scene\">",
    `    curl: ${bridge}/scenario/read`,
    `    body: {"path": "<scene path>", "agent_id": "?from <agent agent_id=...>, pass when reading imported memory"}`,
    "    use:  Read full L2 scene file text by path. The path must be obtained from `<l2_scene_index>` or tdai_scenario_ls first, do not fabricate; when reading a path from an imported_from segment, include that segment's agent_id.",
    "  </tool>",
    "",
    "## Calling constraints",
    "- These are read-only tools; to modify L1/L2/L3 you must use the main link (agent_id automatically assigned).",
    "- In each conversation round, atomic_search + conversation_search **must be ≤ 3 times combined**;",
    "  query / ls / read_scene do not count towards limit, but do not repeatedly read the same path.",
    "- Retry on failure: HTTP 5xx can be retried once; do not retry HTTP 4xx.",
    "- All curls must include: " +
      (spaceId ? `x-tdai-service-id: ${spaceId}, ` : "x-tdai-service-id (current memory instance, see example), ") +
      (sessionId ? `x-conversation-id: ${sessionId}` : "x-conversation-id (from current session)") +
      "; Content-Type: application/json.",
    "",
    "## Complete example",
    "```bash",
    `curl -sfk -X POST ${bridge}/atomic/search \\`,
    `  -H 'Content-Type: application/json'${authHeader} \\`,
    `  -d '{"query": "user preferred programming language", "limit": 5}'`,
    "```",
    "</tdai_memory_tools>",
  ];

  return lines.join("\n");
}

export class TdaiMemoryToolsInjector implements InjectionHook {
  id = "tdai-memory-tools-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "before" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 5;
  description = "Inject <tdai_memory_tools> curl recipes block into system prompt";
  /** Static tool instructions are session-stable; render once at session_init. */
  cacheStrategy: CacheStrategy = "session_init";

  constructor(private cfg: TdaiMemoryToolsInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    // Unidentified identity → do not inject (even if LLM calls curl, bridge will 401)
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];
    const session = (ctx.metadata.custom as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined;
    const spaceId = typeof session?.space_id === "string" ? session.space_id : undefined;
    return this.renderBlocks(identity.sessionId, spaceId);
  }

  prewarm(input: PrewarmInput): ContextBlock[] {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocks(input.sessionInfo.session_id, input.sessionInfo.space_id);
  }

  private renderBlocks(sessionId: string, spaceId?: string): ContextBlock[] {
    return [{
      type: "text",
      content: renderTdaiMemoryToolsBlock(this.cfg.proxyBaseUrl, sessionId, spaceId),
      metadata: {
        source: this.id,
        sessionId,
        cacheKey: "tdai-memory-tools-injector:tools",
      },
    }];
  }
}

/** @deprecated Legacy API compatibility name */
export const TdaiToolsInjector = TdaiMemoryToolsInjector;
