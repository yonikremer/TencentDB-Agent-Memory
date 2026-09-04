/**
 * L1 Summarization Prompt — converts ToolPairs into OffloadEntry summaries.
 */
import type { ToolPair } from "../types.js";

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

export const L1_SYSTEM_PROMPT = `你是一个专为 AI 编码助手提供支持的"工具结果摘要器"。你的核心任务是深度理解当前的对话上下文，并将繁杂的工具调用与执行结果（一对toolcall和tool result整合成一条summary输出），提炼为高信息密度的 JSON 数组。

在生成摘要前，请务必进行以下内部思考：
1. 任务对齐：结合最近的对话记录，识别用户当前的核心目标和最新意图。若上下文存在冲突，始终以最新的用户意图为准。
export const L1_SYSTEM_PROMPT = `You are a "Tool Result Summarizer" designed to support AI coding assistants. Your core mission is to deeply understand the current conversation context and aggregate raw tool call / result pairs (each pair of toolcall and tool result into one summary entry) into a high-information-density JSON array.

In generating summaries, ensure you:
1. Task Alignment: Identify the user's core goals and latest intent from the conversation. Always prioritize the latest user intent.
2. Value Filtering: Ignore redundant implementation details. Extract key discoveries, actions, specific modifications, or errors.
3. Impact Assessment: Evaluate the substantive impact on the task (e.g., verifying a hypothesis, moving to the next step, making a decision, or identifying a blocker).

【Output Format Requirements】
You must and can only output a valid JSON array of objects [{...}]. Each object MUST contain the following fields:
- "tool_call": A concise description of the tool call. Processing rules:
  · If the input tool pair is marked [NEEDS_COMPRESS], compress the tool name + key parameters into a concise description (≤150 chars). Retain the tool name and target (e.g., file paths, command intent), omitting inline scripts or verbose content.
  · If NOT marked [NEEDS_COMPRESS], provide a brief description of the tool and parameters (the system will overwrite with original values).
- "summary": A concise summary integrating the insights above (≤200 chars). Clearly state the business value and its impact (advancement/blocking) on the task.
- "tool_call_id": The original tool_call_id (MUST pass through unchanged).
- "timestamp": The original ISO 8601 timestamp (MUST pass through unchanged).
- "score" (**required**): A score from 0 to 10 based on how well the summary serves as a replacement for the original text. 10 indicates the summary fully captures the original content.

【Strict Rules】
Output ONLY a raw JSON array. Do NOT output any thinking process or explanatory text.`;

/**
 * Build the L1 user prompt for summarization.
 */
export function buildL1UserPrompt(
  recentContext: string,
  pairs: ToolPair[],
): string {
  const parts: string[] = [];

  parts.push("## 最近的对话上下文（用于理解当前任务）：");
  parts.push(recentContext || "(无可用上下文)");
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
