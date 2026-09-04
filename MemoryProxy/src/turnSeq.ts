/**
 * Turn sequence numbering — stateless derivation on the host side.
 *
 * One trace = one turn (one user input). The tool loop within a turn produces multiple
 * upstream requests, and they must all compute the **same** turn sequence number so they
 * can be merged into a single trace in Langfuse.
 *
 * Since the host keeps no per-request persistent state (the turn counter lives inside a
 * private module and does not expose per-turn sequence numbers), we derive it directly
 * from the `messages` history: count the "human input rounds" in the message sequence.
 * The rules align with the turn-detection logic of the private module:
 *   - Anthropic: a user message whose text block is not <system-reminder> counts as a
 *     human input; a pure tool_result / pure system-reminder is a tool-loop continuation.
 *   - OpenAI: role=user containing non-<system-reminder> text is a human input; role=tool
 *     is a tool loop.
 *
 * Hence the first request of a turn and its later tool-loop requests share the same
 * "human round count", so turnSeq is identical. The next turn's request carries one more
 * human input → turnSeq +1 → a new trace.
 *
 * Note: this relies on the client sending the full history (Claude Code / CodeBuddy both
 * do). If the client truncates the history, turnSeq may drift but stays consistent within
 * the same turn (only the absolute value shifts), which does not affect "same turn, one trace".
 */

/** Whether a single user message's content is a human input (not a tool-loop continuation). */
function isHumanUserContent(content: unknown): boolean {
  if (typeof content === "string") {
    return !content.startsWith("<system-reminder>");
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b && typeof b === "object" && b.type === "text") {
        const text = (b.text as string) ?? "";
        if (!text.startsWith("<system-reminder>")) return true;
      }
    }
    return false;
  }
  return false;
}

/**
 * Counts the "human input rounds" in messages, used as the current turn sequence number.
 *
 * Returns ≥ 1 (at least the current round); returns 0 when messages is empty or no human input exists.
 */
export function countHumanTurns(messages: unknown[], protocol: "openai" | "anthropic"): number {
  let count = 0;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m?.role !== "user") continue;
    // OpenAI tool responses have role=tool (they never reach here); user messages are judged by content.
    if (protocol === "openai" || protocol === "anthropic") {
      if (isHumanUserContent(m.content)) count += 1;
    }
  }
  return count;
}
