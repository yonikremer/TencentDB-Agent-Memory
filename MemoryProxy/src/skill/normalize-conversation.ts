/**
 * normalize-conversation.ts
 *
 * Converts the client's raw request messages[] + the assistantMessage returned
 * upstream into the 5-role normalized array that core
 * `/v3/skill/conversation/add` expects:
 *   { role: "user" | "assistant" | "tool_call" | "tool_result" | "system",
 *     content: string,
 *     tool_call_id?: string,
 *     tool_name?: string }
 *
 * Branches explicitly by protocol:
 *   protocol="anthropic" → Anthropic Messages API (Claude Code, /v1/messages)
 *     - in a user message content may be a blocks array; tool_result hides in the role=user blocks
 *     - in an assistant message tool_use hides in the content blocks
 *   protocol="openai"    → OpenAI Chat Completions (CodeBuddy, /v1/chat/completions)
 *     - tool_result is a standalone role=tool message (only has tool_call_id, no tool_name)
 *     - assistant.tool_calls is a separate array field
 *   protocol="responses" → OpenAI Responses API (Codex CLI, /responses)
 *     - the top-level field is `input[]` rather than `messages[]`; an item is distinguished by `type`:
 *         · type="message" role=user/assistant/developer → content[].input_text|output_text
 *         · type="function_call" → a standalone top-level item, with call_id / name / arguments
 *         · type="function_call_output" → a standalone top-level item, with call_id / output
 *         · type="reasoning" → internal thinking, always dropped (aligned with anthropic thinking)
 *     - a developer message equals openai role=system, dropped (never enters the skill corpus)
 *     - assistant-side tool calls are not embedded in message.content; they are standalone
 *       items, so "this round's assistantMessage" pulled out may carry several earlier
 *       function_call/function_call_output entries mixed with text — the caller only passes
 *       "the response's assistant text segment + this round's accumulated tool_use count
 *       override" as assistantMessage; the function_call entries already in input[] are still
 *       handled by normalizeConversation while it iterates.
 *
 * Key rules (correspond to docs/design/2026-07-17-conversation-normalize.md):
 *   - Anthropic user made entirely of tool_result blocks → emit role=tool_result, no user emitted
 *   - Anthropic user mixing text + tool_result → split into two entries (role=user, role=tool_result)
 *   - Anthropic thinking block in assistant → **dropped entirely** for now
 *     TODO: if thinking ever needs to be kept later, add a `keepThinking: boolean` parameter,
 *     kept as role=assistant + a content prefix [thinking] xxx (aligned with Opik flatten)
 *   - Anthropic image block → dropped (no value for skill extraction)
 *   - Anthropic assistant with an empty content array → the whole message is dropped
 *   - OpenAI role=tool message → tool_name stays undefined (core schema has relaxed it to optional)
 *
 * assistantMessage is the response returned upstream this round; the proxy has
 * already pulled it out and passes it separately:
 *   - anthropic shape: { role: "assistant", content: <blocks array> }
 *   - openai shape:    { role: "assistant", content: string | null, tool_calls?: [...] }
 *
 * This module does not do "this round's slice" — whether the caller sends full
 * history or this round's increment is decided by handler-glue; here we only
 * normalize the format.
 *
 * Besides the normalizer, this file also exports two round-boundary helpers:
 *   - isFinalAnswer(asst, toolCallCountOverride?):
 *       tells whether this response is the agent's final answer (no tool_use / tool_calls)
 *   - findLastFinalAssistant(rawMessages, protocol):
 *       finds the index of the previous final assistant in messages[] (locates the round start)
 *
 * handler-glue uses these two helpers to implement round-level triggering: only
 * a final answer is pushed to core, intermediate states are skipped, so
 * "sending an increment on every HTTP call" never makes core's buffer
 * accumulate out of control (10 tool_use calls or 40KB triggers one archive).
 */

import { resolveAgentAdapter } from "../agent-adapters/index.js";

// ─── Types ─────────────────────────────────────────────────────────────────

export type Protocol = "anthropic" | "openai" | "responses";

/** Output format, corresponding to core conversationMessageSchema. */
export interface NormalizedMessage {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
}

/** raw message shape - loose because the raw shapes of all three protocols must be able to fit in here. */
interface RawMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  /**
   * The discriminator field of the codex Responses API input[]:
   *   "message" | "function_call" | "function_call_output" | "reasoning" | ...
   * anthropic/openai messages do not carry this field.
   */
  type?: string;
  [k: string]: unknown;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Counts the tool_use / tool_calls blocks in an assistant response, used for
 * isFinalAnswer / round-boundary checks. Cross-protocol compatible:
 *   - OpenAI: the length of the top-level `tool_calls: [...]` array
 *   - Anthropic: the number of `type === "tool_use"` entries in the content blocks
 * Any other shape returns 0 (pure text or an empty response).
 */
export function countToolCalls(assistantMessage: Record<string, unknown> | null | undefined): number {
  if (!assistantMessage) return 0;
  // OpenAI: top-level `tool_calls: [...]`
  const tc = assistantMessage.tool_calls;
  if (Array.isArray(tc)) return tc.length;
  // Anthropic: content blocks
  const content = assistantMessage.content;
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) {
      const t = (block as Record<string, unknown>)?.type;
      if (t === "tool_use") n++;
      // Codex Responses API: an assistant "message" only holds output_text;
      // function_call is a sibling item and never appears inside
      // assistant.content. So in the responses case
      // countToolCalls(assistantMessage) is always 0 — the real tool call
      // count comes in via the stream accumulator's toolCallCountOverride
      // (the same as the anthropic stream).
    }
    return n;
  }
  return 0;
}

/**
 * Tells whether this assistantMessage is the agent's final answer (round ended).
 *
 * Criterion: **no tool_use / tool_calls** — having text is fine, because a
 * "text + tool_use mix" intermediate state can occur (the agent talks while
 * calling tools). In that case the round has not ended yet, and the text part
 * is kept as history in messages[], then sliced into the round together when a
 * truly final answer arrives next time.
 *
 * How the two protocols differ:
 *   - anthropic non-stream: just check whether asst.content blocks contain tool_use
 *   - anthropic stream:     content has been flattened to a string by the proxy
 *                           (blocks info lost), so the caller must pass toolCallCountOverride
 *   - openai:               check the asst.tool_calls[] length
 *
 * Reuses countToolCalls in this file to absorb protocol differences; only the
 * override priority is added here.
 */
export function isFinalAnswer(
  asst: RawMessage | null | undefined,
  toolCallCountOverride?: number,
): boolean {
  if (!asst) return false;
  // stream case: override is the source of truth; content already lost its blocks structure, so it cannot be used to decide
  if (toolCallCountOverride !== undefined) {
    return toolCallCountOverride === 0;
  }
  return countToolCalls(asst as Record<string, unknown>) === 0;
}

/**
 * Finds in messages[] the index of the most recent assistant in "final answer"
 * form — defined as role=assistant with no tool_use / tool_calls in the
 * response. Returning -1 means history is all intermediate states / there is no
 * assistant, and the caller should slice from index 0.
 *
 * Use: locates this round's start in handler-glue — slicing after the "previous
 * final assistant" yields the round's complete conversation (user + intermediate
 * tool_use/tool_result... + this assistantMessage).
 *
 * Protocol differences:
 *   - anthropic: in history, assistant.content may be a string (pure-text final)
 *                or a blocks array (mixed). As long as the blocks have no tool_use it counts as final.
 *   - openai:    in history an assistant may carry a tool_calls field. As long
 *                as tool_calls is empty/missing it counts as final.
 */
export function findLastFinalAssistant(
  rawMessages: RawMessage[],
  protocol: Protocol,
): number {
  if (protocol === "responses") {
    // In Codex `input[]` an assistant is `{type:"message", role:"assistant"}`;
    // its tool calls are sibling items `{type:"function_call", ...}` rather
    // than embedded blocks. The rule for deciding "this assistant is final":
    // scan forward from that index, and as long as **no** function_call (or its
    // matching function_call_output) appears before the next role=user message,
    // it is a final answer and this round ends.
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i];
      if (!m || m.type !== "message" || m.role !== "assistant") continue;
      // scan the tail for a function_call
      let hasFnCall = false;
      for (let j = i + 1; j < rawMessages.length; j++) {
        const next = rawMessages[j];
        if (!next || typeof next !== "object") continue;
        if (next.type === "function_call") { hasFnCall = true; break; }
        if (next.type === "message" && next.role === "user") break;   // reached the next round
      }
      if (!hasFnCall) return i;
    }
    return -1;
  }
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (!m || m.role !== "assistant") continue;
    if (isFinalAnswer(m)) {
      // isFinalAnswer decides for both protocols via countToolCalls, covering:
      //   anthropic: content is a string → tool_use=0 → final
      //              content is blocks without tool_use → tool_use=0 → final
      //   openai:    tool_calls=[] or missing → tool_use=0 → final
      // (the protocol param is kept for future finer-grained checks; unused for now)
      void protocol;
      return i;
    }
  }
  return -1;
}

export function normalizeConversation(
  rawMessages: RawMessage[],
  protocol: Protocol,
  assistantMessage: RawMessage | null,
  agentSource: string = "claude-code",
): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  // Fallback: protocol=responses but agentSource defaults to claude-code (old
  // callers did not pass it) → force-switch to the codex adapter, otherwise
  // extractUserText would apply the wrong client rules and return null,
  // breaking the whole archive pipeline.
  const effectiveAgentSource = protocol === "responses" && agentSource === "claude-code"
    ? "codex"
    : agentSource;
  const convertOne = (m: RawMessage): NormalizedMessage[] => {
    if (protocol === "anthropic") return convertAnthropicMessage(m, effectiveAgentSource);
    if (protocol === "openai") return convertOpenAIMessage(m, effectiveAgentSource);
    return convertCodexInputItem(m, effectiveAgentSource);
  };
  for (const m of rawMessages) {
    if (!m || typeof m !== "object") continue;
    for (const c of convertOne(m)) out.push(c);
  }
  if (assistantMessage) {
    // For the responses protocol upstream only returns assistant text
    // (function_call items are recognized separately in the stream and already
    // go into the next request's input[]; archiving covers them by iterating
    // rawMessages), so here we only append one role=assistant + text entry —
    // reusing convertCodexInputItem keeps the same path and stays symmetric
    // with the other two protocols.
    const asst: RawMessage = protocol === "responses"
      ? { type: "message", role: "assistant", ...assistantMessage }
      : { role: "assistant", ...assistantMessage };
    // Safety: set role=assistant explicitly in case the caller's
    // assistantMessage is missing role; convertOne relies on
    // effectiveAgentSource, whose protocol=responses fallback is handled above.
    asst.role = "assistant";
    for (const c of convertOne(asst)) out.push(c);
  }
  return out;
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

function convertAnthropicMessage(msg: RawMessage, agentSource: string): NormalizedMessage[] {
  const role = msg.role;
  const content = msg.content;

  // role=system: dropped, not sent to core.
  // The client's fixed agent instruction (CodeBuddy 26KB / Claude Code is not
  // small either) is irrelevant to skill extraction; counting it toward the
  // 40KB byte threshold would only throw off the archive cadence. Both
  // protocols handle it the same way:
  //   - Anthropic: system normally lives at the top-level body.system; showing
  //     up inside messages is a rare case
  //   - OpenAI:    system sits at messages[0], carried on every request
  // See the upstream normalize call site in handler-glue.ts.
  if (role === "system") {
    return [];
  }

  if (role === "assistant") {
    return convertAnthropicAssistant(content);
  }

  if (role === "user") {
    return convertAnthropicUser(content, agentSource);
  }

  // any other role is dropped
  return [];
}

function convertAnthropicAssistant(content: unknown): NormalizedMessage[] {
  // content may be a string / array of blocks
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) {
    // Fallback: a structured object that is not an array → serialize it
    return [{ role: "assistant", content: contentToString(content) }];
  }

  const out: NormalizedMessage[] = [];
  const textParts: string[] = [];
  const toolCalls: NormalizedMessage[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;

    if (t === "text") {
      const txt = b.text;
      if (typeof txt === "string" && txt.length > 0) textParts.push(txt);
    } else if (t === "tool_use") {
      // Convert to role=tool_call; tool_name from name, tool_call_id from id
      const id = typeof b.id === "string" ? b.id : "";
      const name = typeof b.name === "string" ? b.name : undefined;
      const inputStr = safeStringify(b.input);
      const tc: NormalizedMessage = {
        role: "tool_call",
        content: inputStr,
        tool_call_id: id,
      };
      if (name) tc.tool_name = name;
      toolCalls.push(tc);
    }
    // any other block type (thinking / redacted_thinking / image / ...) is dropped
  }

  if (textParts.length > 0) {
    out.push({ role: "assistant", content: textParts.join("\n") });
  }
  for (const tc of toolCalls) out.push(tc);
  return out;
}

function convertAnthropicUser(content: unknown, agentSource: string): NormalizedMessage[] {
  if (typeof content === "string") {
    return [{ role: "user", content }];
  }
  if (!Array.isArray(content)) {
    return [{ role: "user", content: contentToString(content) }];
  }

  const out: NormalizedMessage[] = [];
  const toolResults: NormalizedMessage[] = [];

  // Collect every tool_result (each emitted individually as a role=tool_result message)
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_result") continue;
    const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
    // tool_result.content may be a string / array of {type:"text",text} / other
    const resultText = anthropicToolResultContentToString(b.content);
    toolResults.push({
      role: "tool_result",
      content: resultText,
      tool_call_id: id,
      // Note: an anthropic tool_result has no tool_name field, and the proxy
      // does not look it up (core schema has relaxed it to optional)
    });
  }

  // text part: use agentAdapter to extract "the text the user actually typed"
  // according to the client's rules:
  //   - claude-code: take the last text block (skipping <system-reminder> prefix metadata)
  //   - codebuddy / unknown: conservatively "concatenate all text" (the old
  //     pre-refactor logic)
  const adapter = resolveAgentAdapter(agentSource);
  const userText = adapter.extractUserText(content);
  if (typeof userText === "string" && userText.length > 0) {
    out.push({ role: "user", content: userText });
  }
  for (const tr of toolResults) out.push(tr);
  return out;
}

function anthropicToolResultContentToString(rc: unknown): string {
  if (typeof rc === "string") return rc;
  if (Array.isArray(rc)) {
    const parts: string[] = [];
    for (const b of rc) {
      if (!b || typeof b !== "object") continue;
      const bb = b as Record<string, unknown>;
      if (bb.type === "text" && typeof bb.text === "string") {
        parts.push(bb.text);
      }
      // ignore image and other block types
    }
    return parts.join("\n");
  }
  return contentToString(rc);
}

// ─── OpenAI ────────────────────────────────────────────────────────────────

function convertOpenAIMessage(msg: RawMessage, agentSource: string): NormalizedMessage[] {
  const role = msg.role;
  const content = msg.content;

  // role=system: dropped, not sent to core. Same as the anthropic branch; see the comments there.
  if (role === "system") {
    return [];
  }
  if (role === "user") {
    // Extract "the text the user actually typed" via the adapter following the
    // client's rules, symmetric with the anthropic side:
    //   - codebuddy: use <user_query> extraction (stripping the CB pseudo-XML
    //     wrappers such as <user_info> / <additional_data> / <question_answer>);
    //     when it returns null this round does not enter the skill buffer
    //     (avoiding pollution of the skill extraction corpus)
    //   - unknown / cursor, etc.: use the default fallback (concatenate all
    //     text, the old pre-refactor logic)
    // See agent-adapters/codebuddy.ts + common/user-query-extractor.ts.
    const adapter = resolveAgentAdapter(agentSource);
    const userText = adapter.extractUserText(content);
    if (typeof userText === "string" && userText.length > 0) {
      return [{ role: "user", content: userText }];
    }
    return [];
  }
  if (role === "tool") {
    // openai role=tool → role=tool_result
    const id = typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
    return [{
      role: "tool_result",
      content: contentToString(content),
      tool_call_id: id,
      // tool_name not provided — core schema has made it optional
    }];
  }
  if (role === "assistant") {
    return convertOpenAIAssistant(content, msg.tool_calls);
  }
  return [];
}

function convertOpenAIAssistant(content: unknown, toolCalls: unknown): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];

  // text part
  const contentStr = typeof content === "string" ? content : (content == null ? "" : contentToString(content));
  if (contentStr.length > 0) {
    out.push({ role: "assistant", content: contentStr });
  }

  // tool_calls (openai standard)
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as Record<string, unknown>;
      const id = typeof t.id === "string" ? t.id : "";
      const fn = t.function as Record<string, unknown> | undefined;
      const name = fn && typeof fn.name === "string" ? fn.name : undefined;
      let argsStr = "";
      if (fn && fn.arguments !== undefined) {
        argsStr = typeof fn.arguments === "string" ? fn.arguments : safeStringify(fn.arguments);
      }
      const call: NormalizedMessage = {
        role: "tool_call",
        content: argsStr,
        tool_call_id: id,
      };
      if (name) call.tool_name = name;
      out.push(call);
    }
  }

  return out;
}

// ─── Codex Responses API (input[] items) ───────────────────────────────────

/**
 * Converts one item of the codex `input[]` into a 5-role NormalizedMessage[].
 *
 * Item type inventory (docs/2026-08-07-codex-integration-plan.md §7.2 / agent-adapters/codex.ts):
 *   - {type:"message", role:"user"|"assistant"|"developer", content:[...]}
 *   - {type:"function_call", call_id, name, arguments}
 *   - {type:"function_call_output", call_id, output}
 *   - {type:"reasoning", encrypted_content}
 *
 * Mapping:
 *   message.developer         → dropped (same as openai role=system; not part of the skill corpus)
 *   message.user              → role=user, content = the text the user actually typed (via the codex adapter)
 *   message.assistant         → role=assistant, content = concatenated output_text
 *   function_call             → role=tool_call, tool_call_id, tool_name, content=arguments
 *   function_call_output      → role=tool_result, tool_call_id, content=output
 *   reasoning                 → dropped (aligned with anthropic thinking; not part of the skill corpus)
 *   any other unknown type    → dropped (strict rather than lenient, so future codex item types are never mis-collected)
 */
function convertCodexInputItem(item: RawMessage, agentSource: string): NormalizedMessage[] {
  const type = item.type;

  if (type === "message") {
    const role = item.role;
    // developer / system / any other role is dropped
    if (role === "user") {
      return convertCodexUserMessage(item.content, agentSource);
    }
    if (role === "assistant") {
      return convertCodexAssistantMessage(item.content);
    }
    return [];
  }

  if (type === "function_call") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const name = typeof item.name === "string" ? item.name : undefined;
    const argsRaw = item.arguments;
    const args = typeof argsRaw === "string" ? argsRaw : safeStringify(argsRaw);
    const call: NormalizedMessage = {
      role: "tool_call",
      content: args,
      tool_call_id: id,
    };
    if (name) call.tool_name = name;
    return [call];
  }

  if (type === "function_call_output") {
    const id = typeof item.call_id === "string" ? item.call_id : "";
    const outputRaw = item.output;
    const output = typeof outputRaw === "string" ? outputRaw : safeStringify(outputRaw);
    return [{
      role: "tool_result",
      content: output,
      tool_call_id: id,
    }];
  }

  // reasoning / anything else is dropped
  return [];
}

/** in a codex user message content is [{type:"input_text",text}, ...] */
function convertCodexUserMessage(content: unknown, agentSource: string): NormalizedMessage[] {
  // Prefer reusing the codex agent adapter's extractUserText — it is the same
  // implementation as `extractCodexUserText(input)` in codexHandler
  // (agent-adapters/codex.ts:81), semantically identical, so any future change
  // to the extraction rules only needs to touch that one. Here we pass the
  // single message wrapped into the [message] array the adapter expects (it
  // filters by role=user).
  //   Note: adapter.extractUserText expects a full input[] array as its input,
  //   but internally it only iterates entries to pick the last user; passing a
  //   single entry also matches.
  const singleItem = { type: "message", role: "user", content } as Record<string, unknown>;
  const adapter = resolveAgentAdapter(agentSource);
  const text = adapter.extractUserText([singleItem]);
  if (typeof text === "string" && text.length > 0) {
    return [{ role: "user", content: text }];
  }
  return [];
}

/** in a codex assistant message content is [{type:"output_text",text}, ...] */
function convertCodexAssistantMessage(content: unknown): NormalizedMessage[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    // codex assistant text uses output_text; fall back to text in case codex uses another spelling
    if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  if (parts.length === 0) return [];
  return [{ role: "assistant", content: parts.join("\n") }];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return safeStringify(content);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    // e.g. BigInt / circular ref
    try {
      return String(v);
    } catch {
      return "";
    }
  }
}
