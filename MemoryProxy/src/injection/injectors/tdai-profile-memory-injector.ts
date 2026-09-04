import type { AgentContext, AnchorTarget, CacheStrategy, ContextBlock, InjectionHook, HookPriority, PrewarmInput } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { TdaiClient } from "../../tdai/client.js";
import type { TdaiMemoryConfig } from "../../tdai/types.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs, type FixedAssetCtx } from "./tdai-fixed-asset.js";

/**
 * L2/L3 Injection (refactored following openclaw/hermes official patterns):
 *   - L3 (persona) → Inject full content (stable and usually short, used as long-term profile).
 *   - L2 (scenarios) → **Only inject Scene Navigation index (path list + summary)**,
 *     do not pre-read full text. The LLM will actively call the `tdai_read_scene` tool to fetch via path when details are needed.
 *   - Includes memory-tools-guide text, instructing the LLM how to use tools + call limits.
 *
 * This achieves:
 *   1. Significantly reduced first-turn token consumption (L2 full text is often thousands of chars × N items).
 *   2. Allows LLM to fetch text on demand, instead of polluting the context with irrelevant scenes.
 *
 * Cross-agent: "Self + Imported" segmented by agent; L3 + Scene index are listed side-by-side under each segment.
 *
 * Graceful degradation when control plane is unreachable: only injects the current agent's L3 + Scene index.
 */
export class TdaiProfileMemoryInjector implements InjectionHook {
  id = "tdai-profile-memory-injector";
  point = "system.suffix" as const;
  anchor: AnchorTarget = { slot: "memory", relation: "inside_append" };
  priority: HookPriority = HOOK_PRIORITY.MEMORY + 10;
  description = "Inject TDAI L3 (persona) + L2 scene index (path-only, agent reads via tool)";
  /** L2/L3 profile snapshot is injected once after session registration, like skill listing. */
  cacheStrategy: CacheStrategy = "session_init";

  /**
   * @param baseConfig  starter TdaiClient config; per-request `serviceId` will
   *   be overridden with `session.space_id` in `renderBlocksForContext`. This
   *   config's `serviceId` acts as a fallback when no `space_id` is present.
   * @param coreSkillCfg  kernel gateway config for MetadataClient (fixed-asset
   *   agent resolution).
   */
  constructor(
    private baseConfig: TdaiMemoryConfig,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const caps = ctx.metadata.custom?.assetCapabilities as { chat_memory?: boolean } | undefined;
    if (caps?.chat_memory === false) return [];
    return this.renderBlocksForContext(ctx);
  }

  async prewarm(input: PrewarmInput): Promise<ContextBlock[]> {
    if (input.assetCapabilities?.chat_memory === false) return [];
    return this.renderBlocksForContext(createPrewarmAgentContext(input));
  }

  private async renderBlocksForContext(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId comes from the `/proxy/<spaceId>/...` URL path saved during session registration;
    // used as the `x-tdai-service-id` header in the kernel for tenant routing. Empty strings will be rejected by kernel (invalid_user_key)
    // — caller handles bypass during session-init phase.
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Build a per-request TdaiClient with the correct tenant. Falls back to
    // baseConfig.serviceId (config value) when spaceId is empty.
    const client = new TdaiClient({
      ...this.baseConfig,
      serviceId: spaceId || this.baseConfig.serviceId,
    });

    // Fetch L3 + L2 index independently for each agent (do not read L2 full text)
    const groups = await Promise.all(ctxs.map((c) => loadAgentProfile(client, c)));

    // All empty → still inject tools-guide (LLM can actively search L1 / read L2)
    const hasAnything = groups.some((g) => g.l3 || g.l2Entries.length > 0);
    if (!hasAnything) {
      return [{
        type: "text",
        content: MEMORY_TOOLS_GUIDE,
        metadata: { source: this.id, agentCount: 0, l3Count: 0, l2Count: 0, mode: "tools-only" },
      }];
    }

    const lines: string[] = [
      "<tdai_profile_memory>",
      "Below is the long-term working memory maintained by TDAI for the current agent (self + imported segments; L2 only provides an index, use tools to read full text as needed):",
    ];

    let l2TotalCount = 0;
    let l3Count = 0;
    for (const g of groups) {
      if (!g.l3 && g.l2Entries.length === 0) continue;
      const tag = g.ctx.isSelf ? "self" : "imported_from";
      lines.push(
        `<agent name=${JSON.stringify(g.ctx.agentName)} role=${JSON.stringify(tag)} agent_id=${JSON.stringify(g.ctx.agentId)}>`,
      );
      if (g.l3?.content) {
        l3Count++;
        lines.push("<l3_core_memory>", truncate(g.l3.content, 6000), "</l3_core_memory>");
      }
      if (g.l2Entries.length > 0) {
        lines.push("<l2_scene_index>");
        for (const e of g.l2Entries) {
          l2TotalCount++;
          // Index row: path + summary (if available); body fetched via tool
          if (e.summary) {
            lines.push(`- \`${e.path}\` — ${truncate(e.summary, 200)}`);
          } else {
            lines.push(`- \`${e.path}\``);
          }
        }
        lines.push("</l2_scene_index>");
      }
      lines.push("</agent>");
    }

    lines.push("</tdai_profile_memory>");
    // Followed by the memory-tools-guide to instruct LLM on tool usage + rate limits
    lines.push("");
    lines.push(MEMORY_TOOLS_GUIDE);

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          agentCount: groups.length,
          l3Count,
          l2IndexCount: l2TotalCount,
          mode: "index+tools",
        },
      },
    ];
  }
}

function createPrewarmAgentContext(input: PrewarmInput): AgentContext {
  return {
    messages: [],
    tools: [],
    requestParams: {},
    metadata: {
      protocol: "anthropic",
      traceId: `prewarm:${input.keyId}`,
      keyId: input.keyId,
      modelId: "prewarm",
      stream: false,
      agentSource: "session-init",
      custom: { session: input.sessionInfo },
    },
  };
}

/** Memory usage guide: L0/L1 searched on demand via tools (no longer auto-recalled), L3 injected directly, L2 index injected directly. */
export const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## ⚠️ IMPORTANT: This is not documentation, these are capabilities available to you

The tools listed below in \`<tdai_memory_tools>\` such as tdai_memory_search / tdai_conversation_search
are **capabilities you can actively call** (not just reference documents). They are used via **Bash + curl**
(see the complete usage instructions and URLs in the \`<tdai_memory_tools>\` section above).

**Do NOT** reply with phrases like "I don't have this tool / needs MCP / needs slash command".
**Correct approach**: When determining the need to search memory, directly execute curl in Bash; proxy will automatically inject identity and authentication.

## Memory Usage Rules (Must search first before answering when encountering the following scenarios)

L3 (persona long-term profile) and L2 scene index are directly injected into system. L0/L1 need to be actively searched using tools.

### Scenarios where you must search memory before answering (trigger tool call if any condition is met)

1. **User mentions history/past/before**: e.g., "I said before / I told you / last time / do you remember / we chatted / that previous thing"
   → Use \`tdai_conversation_search\` (find specific message in L0 raw text)
2. **User refers to their identity/preferences/habits**: e.g., "what is my name / my name / I like / my team / I usually use / I don't like / I do not allow"
   → Use \`tdai_memory_search\` (search L1 atomic memory for preferences/rules)
3. **User asks you to recall/find**: e.g., "recall / remember / find out / are there any records about X / check our previous"
   → Directly trigger tool, do not make up an answer
4. **Answer strongly depends on historical facts**: e.g., "how did we fix that bug / what was the last plan / what did we agree on"
   → Extract keywords then \`tdai_memory_search\`

**Typical workflow** (User: "What is my name?"):
\`\`\`bash
# Step 1: Search first
curl -sfk -X POST <bridge>/atomic/search \\
  -H 'Content-Type: application/json' -H 'x-conversation-id: <sid>' \\
  -d '{"query": "user name identity", "limit": 5}'
# Step 2: Extract answer from items[].content and reply
# If empty: explicitly tell the user "I couldn't find it in memory, what is your name?" — Do not pretend to know
\`\`\`

### Scenarios where searching is NOT needed

- User asks "who are you" / "help me modify code" / "write a script" / general programming questions
- The answer is already available in the current conversation context (same round of messages)
- The answer can be directly seen in the \`<l3_core_memory>\` section

### ⚠️ Calling Constraints

- Total of \`tdai_memory_search\` + \`tdai_conversation_search\` per round **must be ≤ 3 times** (\`tdai_read_scene\` / \`tdai_scenario_ls\` / \`tdai_atomic_query\` do not count towards this limit)
- When search yields no result, **explicitly state** "I didn't find X in memory", do not hallucinate
- Do not repeatedly read the same L2 path
</memory-tools-guide>`;

interface AgentProfileBundle {
  ctx: FixedAssetCtx;
  l3: { content: string } | null;
  /** L2 index: path only + optional summary, **does not** read full text. */
  l2Entries: Array<{ path: string; summary?: string }>;
}

async function loadAgentProfile(client: TdaiClient, c: FixedAssetCtx): Promise<AgentProfileBundle> {
  const tdaiCtx = { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName };
  const [l3, l2Entries] = await Promise.all([client.readL3ForCtx(tdaiCtx), client.listL2ForCtx(tdaiCtx)]);
  // L3 (persona) might embed a 'Scene Navigation' index at the tail (plugin side read may append it).
  // We already inject <l2_scene_index> separately, so we must strip this from the persona tail to avoid duplicate L2 index injection.
  const l3Stripped = l3 ? stripSceneNavigation(l3.content) : "";
  return {
    ctx: c,
    l3: l3Stripped.trim() ? { content: l3Stripped } : null,
    l2Entries: (l2Entries ?? []).map((e) => ({ path: e.path, summary: e.summary })),
  };
}

/**
 * Strip the "Scene Navigation (Scene Index)" segment from the tail of persona.
 * Aligns with NAV_HEADER in scene-navigation.ts on the plugin side (matches with or without preceding `---`).
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf("## 🗺️ Scene Navigation");
  if (idx === -1) return personaContent;
  // Remove the immediately adjacent `---` separator and surrounding whitespace as well
  let cut = personaContent.slice(0, idx);
  cut = cut.replace(/\s*-{3,}\s*$/, "");
  return cut.trimEnd();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]` : s;
}
