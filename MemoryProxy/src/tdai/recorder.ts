import type { TdaiClient } from "./client.js";
import type { TdaiIdentity, TdaiMessage } from "./types.js";
import { extractUserQueryText } from "../common/user-query-extractor.js";

/**
 * Extract the "real user query" from the last user message and write it to L0.
 *
 * Background: in coding agents such as CodeBuddy / Claude Code / DSH, besides the real question,
 * the user message also carries a lot of harness context (<additional_data>, current_time,
 * <system_reminder>, DSH's `Current runtime context.` snapshot, etc.). If the whole message were
 * written verbatim into L0, memory would be polluted by this noise, which also differs every round
 * and has very little retrieval value. So here we keep only the real question.
 *
 * The extraction algorithm lives in `common/user-query-extractor.ts` (tdai / mem-command /
 * codebuddy adapters share the same one, to avoid semantic drift); this module only handles the
 * steps of "take the last user message → extract the query text → assemble a TdaiMessage".
 */

// Keep the re-export so downstream consumers (including unit tests) don't have to do a one-off large import-path refactor.
export { extractUserQueryText };

export function extractLatestUserMessage(messages: unknown[]): TdaiMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg?.role !== "user") continue;
    // Take only the real user_query, avoiding writing harness context into L0
    const content = extractUserQueryText(extractContentText(msg.content));
    if (content.trim()) return { role: "user", content };
  }
  return null;
}

export async function recordTdaiTurn(client: TdaiClient, identity: TdaiIdentity | null, userMessage: TdaiMessage | null, assistantContent: string | null | undefined): Promise<void> {
  if (!identity || !userMessage) return;
  const messages: TdaiMessage[] = [userMessage];
  if (assistantContent?.trim()) {
    messages.push({ role: "assistant", content: assistantContent });
  }
  await client.addConversation(identity, messages);
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") return p.text;
      if (typeof p.content === "string") return p.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
