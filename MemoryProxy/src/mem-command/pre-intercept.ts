/**
 * Pre-intercept logic for mem:session-reset.
 *
 * Background: All mem commands were originally recognized **after** the session-init phase
 * in each handler (`anthropicHandler.ts:869-1000` / `handler.ts:922-1000` /
 * `codexHandler.ts:609-680` / `workbuddyHandler.ts:1111-1180`). This sequence
 * is reasonable for sync / create-skill — they depend on sessionInfo. But session-reset
 * needs to take effect in **uninitialized / pending_* / initialized / bypassed** four initial states:
 *
 *   - uninitialized: The state machine treats "mem:session-reset" as "the user's first sentence"
 *     which is not applicable for the asset_confirm branch of form reflection data, but it will at least pop the form once,
 *     causing user confusion when seeing the form.
 *   - pending_*: The state machine treats it as "user's reply to the form", going to parseFormAnswer
 *     → unrecognized → session bypass, reset command can never be intercepted.
 *   - initialized / bypassed: The old mem-command intercept phase can recognize it, and it behaves consistently
 *     after removing the "command unavailable for uninitialized session" gate. It's also simpler to use pre-intercept for these two.
 *
 * Compromise solution: Only add pre-intercept for session-reset — other mem commands remain unchanged. This function
 * determines "whether this request is session-reset", and a preceding if statement in the handler decides whether
 * to short-circuit.
 */

import { parseCommandFromText } from "./parser.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";

/**
 * Determines whether the last user message in the request body is `mem:session-reset`.
 *
 * Compatible with both body.messages[] (CC/CB/dsh) and body.input[] (Codex/WB) formats.
 * Internally uses `extractUserText` of the corresponding adapter to extract pure text, keeping
 * the text extraction semantics consistent with the existing mem-command interception phase.
 *
 * Does not throw errors: Any exception / missing field will unconditionally return false, allowing the original path to continue.
 */
export function isSessionResetCommand(
  body: Record<string, unknown> | null | undefined,
  agentSource: string,
): boolean {
  if (!body) return false;

  try {
    const adapter = resolveAgentAdapter(agentSource);
    let text: string | null = null;

    // Codex / WorkBuddy uses body.input[] (Responses API)
    if (Array.isArray((body as any).input)) {
      const input = (body as any).input as any[];
      if (input.length === 0) return false;
      // Only recognizes the case where "the latest input item is a role=user message";
      // If the latest item is function_call_output, it means the current is during form interaction,
      // and the codex client is replaying the entire history input including the earliest mem:session-reset —
      // At this time, pre-hook should not be repeatedly triggered, otherwise the state will be infinitely beaten back to an uninitialized dead loop.
      const lastItem = input[input.length - 1] as Record<string, unknown> | null | undefined;
      if (!lastItem || typeof lastItem !== "object") return false;
      if (lastItem.type !== "message" || lastItem.role !== "user") return false;
      // Directly extract text from the last message, do not reuse extractUserText (which scans backward)
      const content = lastItem.content;
      if (!Array.isArray(content)) return false;
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown> | null | undefined;
        if (b && typeof b === "object" && b.type === "input_text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      text = texts.length > 0 ? texts.join("\n") : null;
    } else if (Array.isArray((body as any).messages)) {
      // CC/CB/dsh uses body.messages[]
      const messages = (body as any).messages as any[];
      if (messages.length === 0) return false;
      // Last user message
      const last = messages[messages.length - 1];
      if (!last || last.role !== "user") return false;
      text = adapter.extractUserText(last.content);
    } else {
      return false;
    }

    if (!text) return false;
    const parsed = parseCommandFromText(text);
    return parsed?.command === "session-reset";
  } catch {
    return false;
  }
}
