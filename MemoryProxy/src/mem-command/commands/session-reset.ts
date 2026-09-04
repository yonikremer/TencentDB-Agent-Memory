/**
 * mem:session-reset — Resets the binding of the current session, forcing the session-init form to pop up again mid-conversation.
 *
 * Semantics: Regardless of whether the current state is uninitialized / pending_* / initialized / bypassed,
 * after execution, it unconditionally enters `pending_asset_confirm`, with `resetEpoch = Date.now()` +
 * `resetFlow = true`. On the next incoming request, `handleSessionInit` will pop up the asset_confirm form
 * because state !== initialized, letting the user re-select Team/Agent/Task.
 *
 * Cross-node consistency:
 *   - Writes to store use `store.set` write-through, persisting to L1 + L2a (SessionRepo) synchronously
 *   - L1 on other pods might still hold the old initialized state — `store.getOrRecover` step 1
 *     aligns with L2a using resetEpoch; if it finds L2a.resetEpoch is larger, it breaks L1 short-circuit,
 *     taking the new pending state to pop up the form.
 *   - L2b binding (the "little sticky note" when initialized) is explicitly deleted, preventing the next round's `rebuildFromBinding`
 *     from restoring the old initialized state directly.
 *
 * Text convention: Following the flavor of create-skill, only exposing user-understandable terms like
 * "reset/associate/team assets", without internal jargon like status / resetEpoch / binding / pending_asset_confirm.
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";
import { getSessionStore } from "../../session/store.js";
import type { SessionInitState } from "../../session/types.js";

export async function executeSessionReset(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const store = getSessionStore();
  const compositeKey = `${ctx.agentSource}:${ctx.sessionKey}`;

  // Record old state for observation (tracking appended in Commit 4, currently just included in return data)
  const before = store.get(compositeKey);
  const oldStatus = before?.status ?? "uninitialized";
  const oldBypassed = !!before?.bypassed;

  const resetEpoch = Date.now();
  // Write uninitialized instead of pending_asset_confirm:
  //
  // pending_asset_confirm means "proxy has already popped the form, waiting for user reply" — but the next round's
  // body after reset will not have the form tool_use/tool_result (because the form hasn't popped yet).
  // If we write pending_asset_confirm, the next round of handleSessionInit enters the "pending_asset_confirm
  // branch" attempting to parse the form answer from the user message → fails to extract → unrecognized → bypass →
  // command ran for nothing.
  //
  // Writing uninitialized makes the next round go to Case 1 "first time in" branch: refetches teams → pops
  // asset_confirm form. Since Commit 2 already removed the isFreshCCConversation gate,
  // it won't be intercepted by the safety-net even with many messages.
  const nextState: SessionInitState = {
    status: "uninitialized",
    keyId: ctx.sessionKey,
    startedAt: resetEpoch,
    attemptCount: 0,
    userId: ctx.userId,
    resetEpoch,
    resetFlow: true,
  };

  // Fallback bind identity: handler path normally calls store.getOrRecover(compositeKey, identity, ...)
  // to complete bind first, but when intercepted by pre-hook upfront, store might not have bound yet — explicitly bind
  // to guarantee store.set's L2a write-through hits the correct namespace.
  store.bind(compositeKey, {
    userId: ctx.userId,
    agentSource: ctx.agentSource,
    sessionId: ctx.sessionKey,
    spaceId: ctx.spaceId,
  });

  await store.set(compositeKey, nextState);

  // Explicitly delete L2b binding — otherwise the next request going through getOrRecover step 3 rebuildFromBinding
  // will directly restore using the old initialized binding, making resetFlow a no-op.
  // store.set internally already `deleteBinding`s pending states (only puts on initialized),
  // but defensively: explicitly delete here, without relying on store.set's internal implementation details.
  const bindingRepo = store.getBindingRepo();
  if (bindingRepo) {
    try {
      await bindingRepo.deleteBinding(ctx.spaceId, ctx.sessionKey);
    } catch (err) {
      console.warn(
        `[mem-command:session-reset] deleteBinding failed for ${compositeKey}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── observability ────────────────────────────────────────────────────────
  // Structured audit log — lets ops precisely catch session-reset events in dashboard/grep.
  // Fields aligned with subsequent session_init_logs completion tracking (same session_key /
  // agent_source), so PM/ops can join and see "reset triggered → init completion conversion rate".
  // reset_epoch is for cross-node consistency debugging — pod A writes, pod B reads; if they see different
  // reset_epochs, we can immediately isolate L2a probeL2a stale issues.
  console.log(
    `[session-reset] session=${compositeKey} space=${ctx.spaceId} user=${ctx.userId} ` +
      `agent_source=${ctx.agentSource} old_status=${oldStatus} old_bypassed=${oldBypassed} ` +
      `new_status=${nextState.status} reset_epoch=${resetEpoch}`,
  );

  const messageText = buildSuccessMessage(oldStatus, oldBypassed);

  const response = buildMemResponse(messageText, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });

  return {
    success: true,
    messageText,
    // Structured data only visible in logs/panel, not included in user-readable text
    data: {
      old_status: oldStatus,
      old_bypassed: oldBypassed,
      new_status: nextState.status,
      reset_epoch: resetEpoch,
    },
    response,
  };
}

/**
 * Constructs user-readable message based on the old state.
 *
 * Old state       Message emphasis
 * uninitialized   "Will pop up selection when continuing conversation"
 * initialized     "Binding removed, please re-select"
 * bypassed        "Selection entrance restored"
 * pending_*       "Restarted selection"
 */
function buildSuccessMessage(oldStatus: string, oldBypassed: boolean): string {
  if (oldStatus === "uninitialized") {
    return "✅ Reset complete, team asset selection will pop up when continuing conversation";
  }
  if (oldBypassed) {
    return "✅ Team asset selection entrance restored, will pop up to re-select when continuing conversation";
  }
  if (oldStatus === "initialized") {
    return "✅ Team asset binding removed for this session, will pop up to re-select when continuing conversation";
  }
  // pending_*
  return "✅ Restarted team asset selection, will pop up when continuing conversation";
}
