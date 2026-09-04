/**
 * L1 Conflict Detection Prompt (Batch Mode)
 *
 * Based on Kenty's validated prototype prompt (l1_conflict_detection_prompt.md).
 * Batch-compares multiple new memories against a unified candidate pool,
 * supporting cross-type merge and multi-target operations.
 */

import type { MemoryPromptMode } from "../../config.js";
import type { MemoryRecord, ExtractedMemory } from "../record/l1-writer.js";

// ============================
// System Prompt
// ============================

export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Batch compare multiple [New Memories] against existing memories in the [Unified Candidate Pool], and decide how to handle each one individually.

**Output Language**: \`merged_content\` uses the same language as the existing memories in the candidate pool; JSON field names, enum values, record_id, and ISO timestamps remain in English.

## Core Rules

- **Cross-type merge**: Memories of different types (persona / episodic / instruction / work_fact / work_task / work_method / work_artifact) can be merged if they semantically describe the same fact/event.
- **Many-to-many merge**: A new memory can simultaneously replace/merge with **multiple** existing memories in the candidate pool (specified via the target_ids array).
- After merging, you must determine the best type for the new memory (merged_type).

## Decision Logic

1. **Distinguish memory nature**:
   - **State-like** (persona/instruction): Preferences, traits, long-term settings, relatively stable facts, behavioral rules.
   - **Event-like** (episodic): One-off experiences, objective records with time points; it is recommended to merge the cause and effect of the same event.

2. **Judge if it's the same fact/event**: Same subject, consistent topic, close time, similar scene_name.

3. **Select action**:
   - "store": Treat as new information, add the current memory.
   - "skip": Existing memory is better, new memory has no increment or is vaguer, ignore the current memory.
   - "update": Same fact/event, new memory is superior in content or time (more specific, later, or corrects errors), overwrite the old memory mainly with the new memory, preserving details from the old memory that are still correct.
   - "merge": Same fact or evolutionary process, multiple memories complement each other and do not contradict, merge into one more complete memory, minimizing redundancy.

4. **Strategy tendency**:
   - State-like: Multiple describing the same preference/trait → tend to merge; no increment → skip; clear update → update.
   - Event-like: Cause and effect of the same event, different stages → tend to merge into one complete narrative; exactly the same → skip.
   - Cross-type example: An episodic "User started podcasting in 2018" + a persona "User has podcast production experience" → can merge into one persona or episodic (depending on info focus).

5. **Timestamp handling**:
   - For merge / update, merged_timestamps should contain the **union of all relevant memory timestamps** (deduplicated and sorted).
   - This preserves the complete timeline of the event.

## Output Format

Strictly output a JSON array, where each element corresponds to a decision for a new memory. Do not output anything else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["candidate memory record_id 1 to delete", "record_id 2"],
    "merged_content": "Merged/updated memory content (required for merge/update)",
    "merged_type": "Best type after merge: persona|episodic|instruction|work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["Array of timestamps after merge, containing the union of timestamps from both new and old memories (required for merge/update)"]
  }
]

Field descriptions:
- target_ids: An **array** of old memory IDs to delete/replace (can be 1 or multiple). Omit or leave empty for store/skip.
- merged_content: The final memory text for merge/update. Omit for store/skip.
- merged_type: The type the memory should belong to after merge/update. Judged based on the essence of the merged content.
- merged_priority: The new priority after merge/update (integer 0-100, required for merge/update). Merged information is more complete and certain, usually priority should be **appropriately elevated** (e.g., merging two priority 70 memories can elevate it to 80). Reference standard: 80-100 (core traits/major events), 60-79 (general preferences/normal activities), <60 (minor info).
- merged_timestamps: Array of timestamps after merge. Collect timestamps of the new memory + all merged old memories, deduplicate and sort.`;

export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a team work memory conflict detector. Batch compare multiple [New Memories] against existing memories in the [Unified Candidate Pool], and decide how to handle each one individually.

**Output Language**: \`merged_content\` uses the same language as the existing memories in the candidate pool; JSON field names, enum values, record_id, and ISO timestamps remain in English.

## Core Rules

- **Cross-type merge**: Memories of different types (work_fact / work_task / work_method / work_artifact) can be merged if they semantically describe the same work object, task, method, or asset.
- **Many-to-many merge**: A new memory can simultaneously replace/merge with **multiple** existing memories in the candidate pool (specified via the target_ids array).
- After merging, you must determine the best type for the new memory (merged_type).
- Memories are shared within the project team by default, merged content should only retain work-related information.

## Decision Logic

1. **Distinguish memory nature**:
   - **Work Facts (work_fact)**: Project facts, requirements, decisions, status, risks, constraints, experimental results, customer feedback.
   - **Work Tasks (work_task)**: To-dos, owners, deadlines, next steps, task status changes.
   - **Work Methods (work_method)**: SOPs, taboos, principles, experiences, design philosophies, evaluation criteria, Agent behavioral rules.
   - **Work Assets (work_artifact)**: Documents, PRs, Issues, Prompts, reports, code branches, design drafts, links, etc.

2. **Judge if it's the same work object/evolution process**:
   - Same project, module, requirement, task, risk, decision, method, asset, and scene_name or semantics are highly similar.
   - Different stages of the same task, supplements to the same method, changes in version or purpose of the same asset can usually be merged.
   - If they only belong to the same large project but discuss different objects, they should not be forcibly merged.

3. **Select action**:
   - "store": Treat as new information, add the current memory.
   - "skip": Existing memory is better, new memory has no increment or is vaguer, ignore the current memory.
   - "update": Same work object, new memory is more specific, newer, more authoritative, or corrects old info, overwrite the old memory mainly with the new memory, preserving details from the old memory that are still correct.
   - "merge": Same work object or evolutionary process, new and old memories complement each other and do not contradict, merge into one more complete memory, minimizing redundancy.

4. **Strategy tendency**:
   - work_fact: Supplement or correction of the same fact/decision/status → tend to update or merge.
   - work_task: Owner, deadline, status change of the same task → tend to update; supplementing dependencies or acceptance criteria → tend to merge.
   - work_method: Supplementing the same SOP, taboo, principle, experience → tend to merge; clearer, more general expression → tend to update.
   - work_artifact: Supplementing the purpose, version, link of the same document, PR, Prompt, report, etc. → tend to merge or update.
   - Cross-type example: A work_fact "Team decides to keep L1 types to a few high-level categories" + a work_method "L1 types shouldn't be too granular, otherwise it affects L2/L3 aggregation" → can merge into work_method.

5. **Timestamp handling**:
   - For merge / update, merged_timestamps should contain the **union of all relevant memory timestamps** (deduplicated and sorted).
   - This preserves the complete timeline of work facts, tasks, or method evolution.

## Output Format

Strictly output a JSON array, where each element corresponds to a decision for a new memory. Do not output anything else:

[
  {
    "record_id": "record_id of the new memory",
    "action": "store|update|skip|merge",
    "target_ids": ["candidate memory record_id 1 to delete", "record_id 2"],
    "merged_content": "Merged/updated memory content (required for merge/update)",
    "merged_type": "Best type after merge: work_fact|work_task|work_method|work_artifact (required for merge/update)",
    "merged_priority": 85,
    "merged_timestamps": ["Array of timestamps after merge, containing the union of timestamps from both new and old memories (required for merge/update)"]
  }
]

Field descriptions:
- target_ids: An **array** of old memory IDs to delete/replace (can be 1 or multiple). Omit or leave empty for store/skip.
- merged_content: The final memory text for merge/update. Omit for store/skip.
- merged_type: The type the memory should belong to after merge/update. Judged based on the essence of the merged content.
- merged_priority: The new priority after merge/update (integer 0-100, required for merge/update). Merged information is more complete and certain, usually priority should be **appropriately elevated**. Reference standard: 80-100 (key facts/major tasks/core methods/major assets), 60-79 (general work info), <60 (minor info).
- merged_timestamps: Array of timestamps after merge. Collect timestamps of the new memory + all merged old memories, deduplicate and sort.`;

export function getConflictDetectionSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? WORK_CONFLICT_DETECTION_SYSTEM_PROMPT : CONFLICT_DETECTION_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Candidate search result for a single new memory.
 */
export interface CandidateMatch {
  newMemory: ExtractedMemory & { record_id: string };
  candidates: MemoryRecord[];
}

/**
 * Format the batch conflict detection prompt using a unified candidate pool.
 *
 * Format (aligned with prototype):
 * 1. Unified candidate pool: de-duplicated list of all existing candidates across all new memories
 * 2. Per new memory: content + list of related candidate IDs from the pool
 *
 * This approach lets the LLM see the global picture and handle cross-memory dedup in one pass.
 *
 * @param matches - Array of new memories with their candidate matches
 */
export function formatBatchConflictPrompt(matches: CandidateMatch[]): string {
  // Step 1: Build unified candidate pool (de-duplicate across all new memories)
  const unifiedPool = new Map<string, MemoryRecord>();
  const perMemoryCandidateIds = new Map<string, string[]>();

  for (const m of matches) {
    const candidateIds: string[] = [];
    for (const c of m.candidates) {
      if (!unifiedPool.has(c.id)) {
        unifiedPool.set(c.id, c);
      }
      candidateIds.push(c.id);
    }
    perMemoryCandidateIds.set(m.newMemory.record_id, candidateIds);
  }

  // Step 2: Format unified pool as JSON
  const poolList = Array.from(unifiedPool.values()).map((c) => ({
    record_id: c.id,
    content: c.content,
    type: c.type,
    priority: c.priority,
    scene_name: c.scene_name,
    timestamps: c.timestamps,
  }));

  let poolSection: string;
  if (poolList.length === 0) {
    poolSection = "## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）";
  } else {
    const poolStr = JSON.stringify(poolList, null, 2);
    poolSection = `## Unified Candidate Pool (${poolList.length} existing memories)\n\n${poolStr}`;
  }

  // Step 3: Format each new memory with its related candidate IDs
  const memoryParts = matches.map((m, idx) => {
    const relatedIds = perMemoryCandidateIds.get(m.newMemory.record_id) ?? [];
    const relatedNote =
      relatedIds.length > 0
        ? JSON.stringify(relatedIds)
        : "[] (No similar candidates, store directly)";

    const memStr = JSON.stringify(
      {
        record_id: m.newMemory.record_id,
        content: m.newMemory.content,
        type: m.newMemory.type,
        priority: m.newMemory.priority,
        scene_name: m.newMemory.scene_name,
      },
      null,
      2,
    );

    return `### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【关联候选 ID】${relatedNote}`;
  });

  const newMemoriesText = memoryParts.join(
    "\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n",
  );

  // Step 4: Assemble final prompt
  return `**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言。

${poolSection}

${"═".repeat(50)}

## New Memories to Judge (${matches.length} total)

${newMemoriesText}

Please judge each one and output the decision JSON array. When a new memory's candidate list is empty, output action=store for it.`;
}
