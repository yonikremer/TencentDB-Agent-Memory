/**
 * L1.5 Task Judgment Prompt — migrated from context-offload-server.
 *
 * Determines task lifecycle: completion, continuation, new task detection.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L15_SYSTEM_PROMPT = `You are a "Task Lifecycle Gatekeeper" designed for AI coding assistants.
Your responsibility is to cross-analyze the three provided input sources, accurately assess the task status, and output a pure JSON object.

[Input Data Utilization Guide (Mandatory Reasoning Chain)]
1. Step 1 - Analyze recentMessages (Identify Intent): Based on current and historical dialogue, extract the core request of the user's latest reply. Determine whether it is "continue troubleshooting", "announce completion (e.g., it works)", "single-turn chat Q&A", or "start a new requirement".
2. Step 2 - Align with currentMmd (Evaluate Current Baseline): Compare the user's latest intent with the full Mermaid content of currentMmd - focusing on taskGoal, the status of each node (done/doing/todo), and the summary. If the request completely exceeds the scope of the current graph or the goal has been achieved (all nodes are done and there is no continuation), then taskCompleted is true. If still solving sub-problems within the graph (including doing nodes or fixing bugs), then it is false. (If there is no currentMmd, judge whether to continue the task based only on current and historical dialogue).
3. Step 3 - Retrieve availableMmds (Determine Continuation): If it is decided to start a new task (isLongTask=true and taskCompleted=true/no current task), you must scan the taskGoal and time information of availableMmds. If the new request highly overlaps with an old task in the list (e.g., returning to a module unfinished yesterday), then it is a continuation (isContinuation=true).

[Strict JSON Output Format]
You must output a valid pure JSON object, formatted as follows:
{
  "taskCompleted": boolean, // Whether the current task has ended (if currentMmd is none, this must be true)
  "isLongTask": boolean,    // Whether the latest request is a complex project requiring multi-step operations (false for normal tech Q&A or chat)
  "isContinuation": boolean, // Whether it is continuing a historical task in availableMmds
  "continuationMmdFile": "string|null", // If continuing an old task, accurately fill in the filename from availableMmds (without path prefix), otherwise null
  "newTaskLabel": "string|null" // If it is a completely new long task, generate a short label (≤30 chars, kebab-case, e.g. "refactor-api"), otherwise null
}

Only output the pure JSON object, never include any explanatory text.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L15CurrentMmd {
  filename: string;
  content: string;
  path: string;
}

export interface L15MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  updatedTime?: string | null;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1.5 user prompt for task judgment.
 * Mirrors context-offload-server/internal/service/prompt/BuildL15UserPrompt.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: L15MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent conversation context (Recent 6 messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Currently mounted task graph (Active Mermaid — full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    if (currentMmd.path) {
      parts.push(`**Path:** \`${currentMmd.path}\``);
    }
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Historically available task graphs (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no historical long tasks)");
  } else {
    for (const m of metas) {
      parts.push(`- **${m.filename}**`);
      parts.push(`  path: \`${m.path}\``);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`);
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

  parts.push("Please strictly judge according to the [Three-step thinking link] of the system instructions, and output a valid JSON object.");
  return parts.join("\n");
}
