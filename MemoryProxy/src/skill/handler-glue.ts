/**
 * handler-glue.ts — bridges the per-turn lifecycle in handler.ts /
 * anthropicHandler.ts to core `/v3/skill/conversation/add`.
 *
 * The proxy only uses the **new path**: at the end of each real-user
 * conversation round (when the agent gives a final reply with no tool_use),
 * push this round's conversation slice to core; core decides on its own when
 * to archive once the accumulation reaches its threshold (entering the skill
 * extraction pipeline).
 *
 * History: an old path SkillExtractTrigger → /v3/skill/extract used to exist;
 * the proxy fired an extraction each turn and relied on the proxy-side
 * KvExtractStore to hold the buffer. It has been removed; see the commit
 * history. The entry point where the agent proactively triggers extraction
 * via skill-bridge (/v3/skill/extract) was commented out along with it — core
 * has a "manual archive" interface planned, and the agent tool will point to
 * that interface again once it lands.
 *
 * Trigger timing: **round-level** — only push to core when the agent gives a
 * final reply (no tool_use / tool_calls). Intermediate states (the agent is
 * calling tools, and the client will send tool_result back to continue the
 * round) are skipped; everything is sent together once the round truly ends.
 *
 * Why not turn-level (fire on every HTTP):
 *   From the proxy's perspective one HTTP call is one "turn", but a single
 *   real-user question in Claude Code / CodeBuddy triggers N HTTP calls (the
 *   tool-use loop). If we fired every turn, core's buffer would accumulate
 *   extremely fast — by default 10 tool_use calls trigger one archive, and a
 *   few rounds of conversation in production can already produce 30+
 *   archives. Round-level triggering guarantees "1 real user Q&A = 1 add",
 *   the semantics are clear, and the RPC count drops by ~N times. See
 *   docs/design/2026-07-17-conversation-normalize.md.
 */

import type { ProxyConfig } from "../types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import { getCoreSkillClient } from "./core-client.js";
import {
  countToolCalls,
  findLastFinalAssistant,
  isFinalAnswer,
  normalizeConversation,
} from "./normalize-conversation.js";

/** loose message shape for internal use by this module */
interface IncomingMsg {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
}

export interface TriggerInput {
  config: ProxyConfig;
  sessionKey: string;
  /** Client type (the first segment of the URL path), used for the three-segment isolation key; defaults to `claude-code`. */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  inputMessages: unknown[] | undefined;
  assistantMessage: Record<string, unknown> | null | undefined;
  /**
   * The protocol a request uses — determines how messages/assistantMessage
   * are parsed.
   *   "anthropic" → anthropicHandler.ts (/v1/messages), content may be a blocks array,
   *                 tool_result hides in role=user, tool_use hides in role=assistant
   *   "openai"    → handler.ts (/v1/chat/completions), content is usually a string,
   *                 tool_result is a separate role=tool message, tool_calls is a separate assistant field
   *   "responses" → codexHandler.ts (/responses), the top level is input[] rather than messages[],
   *                 items are distinguished by type: message / function_call / function_call_output /
   *                 reasoning (see the top of normalize-conversation.ts)
   *
   * The proxy already knows from its routing whitelist exactly which protocol
   * each request uses (see routes/whitelist.ts), so the caller (handler.ts /
   * anthropicHandler.ts / codexHandler.ts) passes it in explicitly rather than
   * inferring it.
   */
  protocol: "anthropic" | "openai" | "responses";
  /** Per-user asset capability flags; skill=false disables extraction collection. */
  assetCapabilities?: AssetCapabilityFlags;
  /** Optional override (e.g. SSE accumulators contain the truth in streaming mode). */
  toolCallCountOverride?: number;
}

export async function triggerSkillExtractIfReady(input: TriggerInput): Promise<void> {
  try {
    const { config, sessionKey, sessionInfo, inputMessages, assistantMessage } = input;
    if (input.assetCapabilities?.skill === false) return;
    if (!sessionKey || !sessionInfo) return;

    const userId = sessionInfo.user_id as string | undefined;
    const teamId = sessionInfo.team_id as string | undefined;
    const agentId = sessionInfo.agent_id as string | undefined;
    if (!userId || !teamId || !agentId) return;

    if (!config.coreSkill?.endpoint || !config.coreSkill?.serviceToken) return;

    const spaceId = sessionInfo.space_id as string | undefined;
    if (!spaceId) {
      console.warn(
        `[skill-conversation-add] skipped: no space_id on sessionInfo session=${sessionKey}`,
      );
      return;
    }

    const msgs: IncomingMsg[] = Array.isArray(inputMessages)
      ? (inputMessages as IncomingMsg[])
      : [];
    const rawAsst = (assistantMessage as Record<string, unknown>) ?? {};
    const hasAsst = Boolean(rawAsst && (rawAsst.role || rawAsst.content || rawAsst.tool_calls));
    const rawMsgs = msgs as unknown[] as Array<Record<string, unknown>>;

    // ── round-level trigger gate ──
    // Only a final answer proceeds; intermediate states carrying tool_use /
    // tool_calls return right away. The check depends on the number of
    // tool_use / tool_calls in assistantMessage;
    // in the stream branch assistantMessage.content is flattened into a
    // string and loses the blocks info, so input.toolCallCountOverride is the
    // source of truth there (see anthropicHandler.ts:1592-1597).
    if (!isFinalAnswer(hasAsst ? rawAsst : null, input.toolCallCountOverride)) return;

    // ── this round's slice ──
    // Slice start = after the previous "final assistant" = the start of this
    // round's user input. If not found (first round / history is all
    // intermediate states) → -1 + 1 = 0, naturally sending the whole segment,
    // which is semantically correct.
    const lastFinal = findLastFinalAssistant(rawMsgs, input.protocol);
    const startIdx = lastFinal + 1;

    // Normalize into 5 roles, branching by protocol — expand anthropic
    // content blocks / openai tool_calls, and map recognized tool_use /
    // tool_result into role=tool_call / role=tool_result respectively.
    // agentSource is used to extract user text per the client's rules (see
    // agent-adapters/)
    // See normalize-conversation.ts and
    // docs/design/2026-07-17-conversation-normalize.md
    const turnMessages = normalizeConversation(
      rawMsgs.slice(startIdx),
      input.protocol,
      hasAsst ? rawAsst : null,
      input.agentSource,
    );
    if (turnMessages.length === 0) return;

    try {
      const client = getCoreSkillClient(config.coreSkill);
      const t0 = Date.now();
      const result = await client.addConversation(
        {
          session_id: sessionKey,
          space_id: spaceId,
          user_id: userId,
          team_id: teamId,
          agent_id: agentId,
          task_id: sessionInfo.task_id as string | undefined,
          messages: turnMessages,
        },
        // core Shark uses x-tdai-service-id = the real kernel instance ID
        { serviceId: spaceId },
      );
      if (result.status === "archived" && result.archived) {
        console.log(
          `[skill-conversation-add] archived session=${sessionKey} task_id=${result.archived.task_id}` +
            ` reason=${result.archived.reason} took=${Date.now() - t0}ms` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}`,
        );
      } else {
        // status=ok: no archive triggered — core has accumulated this round
        // into its buffer and will only archive once the next round or a few
        // more rounds push it past the threshold.
        console.log(
          `[skill-conversation-add] appended session=${sessionKey}` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}` +
            ` took=${Date.now() - t0}ms`,
        );
      }
    } catch (err) {
      // core failing does not affect the main response chain; watch the
      // metrics before deciding to escalate to an error
      console.warn(
        "[skill-conversation-add] addConversation failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    // Conservative: swallow any exception so the main response chain is never affected.
    console.warn(
      "[skill-extract-glue] triggerSkillExtractIfReady swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Compatibility: some older code imports countToolCalls from handler-glue
export { countToolCalls };
