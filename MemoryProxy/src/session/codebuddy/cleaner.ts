/**
 * CodeBuddy Session Init — LastUser text extractor.
 *
 * Previously, this file contained `stripInitArtifacts` to strip mock form
 * conversations after session_init completion (to prevent the LLM from seeing form interactions).
 * **This feature has been removed** — we now preserve all actual user conversations
 * permanently (including session_init form interactions), without any deletion.
 *
 * Currently, there is only one export: `getLastUserMessageText`, used in the session_init
 * state machine to read the text of the last user/tool message to parse the user's selection.
 *
 * ── CodeBuddy ask_followup_question write-back format ──
 *
 * After the user clicks the form, the message structure where the Q&A resides in the next CodeBuddy request:
 *
 *   [N-2] role=assistant  tool_calls=[{id:"call_session_init_...", function:{name:"ask_followup_question"}}]
 *   [N-1] role=tool       tool_call_id=call_session_init_...  content=<multi_question_result JSON>
 *   [N]   role=user       content=<additional_data> 或其他普通 user 消息
 *
 * multi_question_result JSON (actual packet capture format):
 *   Empty intermediate state (form just displayed, user hasn't clicked):
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","options":[...],"multiSelect":false}],
 *      "answers":{},
 *      "message":"Questions displayed. User response will be in <que"}}
 *
 *   Actual answer (after user clicks):
 *     {"status":"success","success":true,"result":{"type":"multi_question_result",
 *      "questions":[{"id":"team","answer":"Team Name (id trailing 8 chars)",...}],
 *      "answers":{"team":"Team Name (id trailing 8 chars)"}}}
 *
 * getLastUserMessageText currently only scans user messages, and does not process tool messages.
 * team extraction relies on the extractor's substring fallback matching, which coincidentally catches
 * the team name in unrelated user text, and is not a precise parsing. For reliable extraction, a tool message parsing path must be added.
 */

import { containsFormTitle } from "./form.js";

interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  [key: string]: unknown;
}

interface AnthropicBlock {
  type?: unknown;
  text?: unknown;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get text from last user or tool message containing form answer data.
 *
 * CodeBuddy writes form responses as `role: "tool"` messages with
 * `tool_call_id` matching the session init `ask_followup_question`.
 * We look at BOTH user messages (for old XML `<question_answer>` format)
 * AND tool messages (for the actual `multi_question_result` / plain-text
 * answer format) — picking the LAST relevant one, whichever role it has.
 */
export function getLastUserMessageText(messages: RawMessage[]): string {
  // Sweep from end: the last message (user or tool) that relates to
  // session init is what we want. Tool messages are preferred because
  // CB writes "是，关联团队资产" etc. into tool_result content.
  let best = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i].role;
    if (role !== "user" && role !== "tool") continue;

    const text = getMessageText(messages[i]);
    if (!text) continue;

    // Tool messages linked to a session-init tool_call are always relevant.
    // Compatible with four prefixes: CB's `call_session_init_`, WB's `call_wb_session_init_`
    // (TOOLCALL_PREFIX = "call_wb_session_init_" in workbuddy/form.ts),
    // dsh's `call_dsh_session_init_` (dsh/form.ts TOOLCALL_PREFIX),
    // opencode's `call_oc_session_init_` (opencode/form.ts TOOLCALL_PREFIX).
    const tcid = (messages[i] as any).tool_call_id as string | undefined;
    if (role === "tool" && tcid && /call_(wb_|dsh_|oc_)?session_init_/.test(tcid)) {
      return text;
    }

    // User messages with form markers have highest priority for old format
    if (role === "user" && (text.includes("<question_answer") || containsFormTitle(text))) {
      return text;
    }

    // Remember the last user/tool text as fallback
    if (!best && role === "user") {
      best = text;
    }
  }
  return best;
}

function getMessageText(msg: RawMessage): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content as AnthropicBlock[]) {
      if (raw.type === "text" && typeof raw.text === "string") {
        parts.push(raw.text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(content ?? "");
}
