/**
 * L1 Summarization Prompt — migrated from context-offload-server.
 *
 * Converts tool call/result pairs into high-density JSON summaries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L1_SYSTEM_PROMPT = `You are a "Tool Result Summarizer" designed to support AI coding assistants. Your core mission is to deeply understand the current conversation context and aggregate raw tool call / result pairs (each pair of toolcall and tool result into one summary entry) into a high-information-density JSON array.

In your reasoning, perform the following:
1. Task Alignment: Identify the core objective and intent from recent conversation.
2. Value Filtering: Ignore redundant details; extract key findings, actions, modifications, or specific errors.
3. Impact Assessment: Evaluate the impact of the result on the current task (e.g., verifying a hypothesis, advancing a step, or causing a block).

【Output Format Requirements】
You must output a valid JSON array of objects [{...}]. Each object **must** contain:
- "tool_call": A concise description of the tool call.
  · If marked [NEEDS_COMPRESS], summarize the tool name and key parameters (≤150 chars). Omit inline scripts or verbose content.
    Example: exec({"command":"..."}) → "exec: Ran Python script to analyze sales_channels.csv data quality"
    Example: write_file({"path":"/root/app.py","content":"..."}) → "write_file: Wrote /root/app.py (Flask main file)"
  · If not marked [NEEDS_COMPRESS], provide a brief description (the system will overwrite with original values).
- "summary": A refined summary (≤200 chars). State clearly the business value and how it advances or blocks the task.
- "tool_call_id": The original tool_call_id (MUST pass through unchanged).
- "timestamp": The original ISO 8601 timestamp (MUST pass through unchanged).
- "score" (**required**): A number between 0 and 10 indicating how well the summary substitutes for the original text.

【Strict Rules】
Output ONLY a raw JSON array. Do NOT output any thinking process or explanatory text.`;

// ─── Constants ───────────────────────────────────────────────────────────────

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L1ToolPair {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1 user prompt for summarization.
 * Mirrors context-offload-server/internal/service/prompt/BuildL1UserPrompt.
 */
export function buildL1UserPrompt(recentMessages: string, pairs: L1ToolPair[]): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (for understanding the current task):");
  parts.push(recentMessages);
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
