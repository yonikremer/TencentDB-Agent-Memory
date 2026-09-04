/**
 * L1.5 Task Judgment Prompt — determines task lifecycle.
 */
import type { MmdMeta } from "../types.js";

export const L15_SYSTEM_PROMPT = `You are a "Task Lifecycle Gatekeeper" designed for AI coding assistants.
Your responsibility is to cross-analyze the provided inputs, accurately determine the task status, and output a pure JSON object.

【Input Data Usage Guide (Mandatory Thinking Process)】
1. Step 1 - Analyze recentMessages (Identify Intent): Based on current and historical dialogue, extract the core requirement of the user's latest reply. Determine if it's "continue troubleshooting", "announce completion (e.g. it runs successfully)", "single-turn casual Q&A", or "start a brand new requirement".
2. Step 2 - Align currentMmd (Evaluate Current Baseline): Compare the user's latest intent with the full Mermaid content of currentMmd—focus on taskGoal, node status (done/doing/todo), and summary. If the requirement is completely out of scope of the current diagram or the goal is achieved (all nodes done and no follow-up), then taskCompleted is true. If still resolving sub-problems in the diagram (including doing nodes or fixing bugs), it is false. (If there is no currentMmd, judge whether to continue based only on current and historical dialogue)
3. Step 3 - Retrieve availableMmds (Determine Continuation): If deciding to start a new task (isLongTask=true and taskCompleted=true/no current task), you must scan the taskGoal and time info of availableMmds. If the new requirement highly overlaps with a past task (e.g. returning to an unfinished module from yesterday), it is a continuation (isContinuation=true).

【Strict JSON Output Format】
You must output a valid pure JSON object in the following format:
{
  "taskCompleted": boolean, // Whether the current task has ended (if currentMmd is none, this MUST be true)
  "isLongTask": boolean,    // Whether the latest requirement is a complex multi-step task (false for casual Q&A)
  "isContinuation": boolean, // Whether continuing a historical task from availableMmds
  "continuationMmdFile": "string|null", // If continuing, the exact filename from availableMmds (no path prefix), otherwise null
  "newTaskLabel": "string|null" // If a brand new long task, a short label (≤30 chars, kebab-case, e.g. "refactor-api"), otherwise null
}

Output ONLY the pure JSON object, without any explanatory text.`;

export interface L15CurrentMmd {
  filename: string;
  content: string;
}

/**
 * Build the L1.5 user prompt for task judgment.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent dialogue context (Recent messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Active Mermaid task graph (Full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Historical available task graphs (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no historical long tasks)");
  } else {
    for (const m of metas) {
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`- **${m.filename}**`);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      parts.push(
        `  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`,
      );
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push(
    "Please rigorously analyze based on the [Three-step Thinking Process] in the system instructions and output a valid JSON object.",
  );
  return parts.join("\n");
}
