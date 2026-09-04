import type { AgentContext, ContextBlock, InjectionHook, HookPriority } from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { getLastUserMessage, getMessageText } from "../context.js";
import type { TdaiClient } from "../../tdai/client.js";
import { getTdaiIdentity } from "../../tdai/identity.js";
import { extractUserQueryText } from "../../tdai/recorder.js";
import type { CoreSkillConfig } from "../../types.js";
import { getMetadataClient } from "../../meta/client.js";
import { resolveFixedAssetCtxs } from "./tdai-fixed-asset.js";

/**
 * L1 Recall ("Self + Imported" cross-agent merged top-K):
 *   1. Retrieve current (team, user, agent) identity from ctx (passed from ProxyConfig).
 *   2. Call control plane /fixed-asset-agents to get [self, ...imported≤2].
 *   3. Concurrently call /atomic/search for each ctx (query=last user message).
 *   4. Merge all hits → sort descending by score → take top globalTopK.
 *   5. Inject into user.before, labeling each with [from <agent_name>].
 *
 * Degrades gracefully when control plane is unreachable: only queries the current agent's L1 (maintains backward compatibility).
 */
export class TdaiL1RecallInjector implements InjectionHook {
  id = "tdai-l1-recall-injector";
  point = "user.before" as const;
  priority: HookPriority = HOOK_PRIORITY.MEMORY;
  description = "Recall TDAI L1 memories from self + imported agents and prepend them to the current user turn";

  /**
   * @param sessionInitConfig Used to call the control plane for fixed-asset-agents; if null,
   *        the injector degrades to "only query current agent" mode, maintaining backward compatibility.
   * @param perAgentLimit Number of items to recall from tdai for each agent individually (default = client config).
   * @param globalTopK Number of items to keep after merging (default 5).
   */
  constructor(
    private client: TdaiClient,
    private coreSkillCfg: Pick<CoreSkillConfig, "endpoint" | "serviceToken" | "serviceId" | "timeoutMs"> | null = null,
    private perAgentLimit: number | undefined = undefined,
    private globalTopK = 5,
    /**
     * ACL check client, usually the same TdaiClient instance as `client`. When provided,
     * every fixed-asset ctx will go through acl/check(read) filtering. When null, retains old behavior.
     */
    private aclClient: TdaiClient | null = null,
  ) {}

  async execute(ctx: AgentContext): Promise<ContextBlock[]> {
    const identity = getTdaiIdentity(ctx.metadata.custom);
    if (!identity) return [];

    const lastUser = getLastUserMessage(ctx);
    if (!lastUser) return [];
    // Use "clean real user_query" as the search term, instead of the entire raw message blob
    // (the latter contains noise like <user_info>/<additional_data>/<question_answer>,
    // which makes FTS5/vector search hit rate extremely low or 0, failing to recall L1).
    const query = extractUserQueryText(getMessageText(lastUser)).trim().slice(0, 2048);
    if (!query) return [];

    // Get ctx list of self + imported ≤2
    const session = (ctx.metadata.custom as any)?.session as { user_key?: string; space_id?: string } | undefined;
    const userKey = session?.user_key;
    // spaceId comes from the `/proxy/<spaceId>/...` URL path saved during session registration;
    // used as the `x-tdai-service-id` header in the kernel for tenant routing.
    const spaceId = session?.space_id ?? "";
    const mc = this.coreSkillCfg && userKey
      ? getMetadataClient(this.coreSkillCfg, spaceId, userKey)
      : null;
    const ctxs = await resolveFixedAssetCtxs(ctx, identity, mc);

    // Concurrently search L1 for each ctx
    const groups = await Promise.all(
      ctxs.map(async (c) => {
        const items = await this.client.searchL1ForCtx(
          { teamId: c.teamId, userId: c.userId, agentId: c.agentId, agentName: c.agentName },
          query,
          identity.sessionId,
          identity.taskId,
          this.perAgentLimit,
        );
        return items.map((m) => ({
          ...m,
          fromAgentId: c.agentId,
          fromAgentName: c.agentName,
        }));
      }),
    );
    // Merge all hits, sort descending by score (those lacking a score go to the end)
    const merged = ([] as Array<(typeof groups)[number][number]>)
      .concat(...groups)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))
      .slice(0, this.globalTopK);

    if (merged.length === 0) return [];

    const lines: string[] = [
      "<tdai_recalled_l1_memories>",
      "Below are the TDAI L1 memories related to the user's question in this turn (self + imported collection, sorted by relevance), intended only to assist answering this current turn, do not treat as permanent system rules:",
    ];
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      const fromTag =
        m.fromAgentId === identity.agentId
          ? "self"
          : `from ${m.fromAgentName ?? m.fromAgentId}`;
      const score = typeof m.score === "number" ? ` score=${m.score.toFixed(3)}` : "";
      lines.push(`${i + 1}. [${m.type ?? "memory"}] [${fromTag}${score}] ${m.content}`);
    }
    lines.push("</tdai_recalled_l1_memories>");

    return [
      {
        type: "text",
        content: lines.join("\n"),
        metadata: {
          source: this.id,
          count: merged.length,
          sources: ctxs.map((c) => c.agentId),
        },
      },
    ];
  }
}
