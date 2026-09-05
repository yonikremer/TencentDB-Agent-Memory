/**
 * L1 Extraction Prompt: Scenario Segmentation + Memory Extraction
 *
 * Based on Kenty's validated prototype prompt (l1_memory_extraction_prompt.md).
 * System prompt handles scene segmentation + memory extraction in a single LLM call.
 * User prompt template fills in previous_scene_name, background_messages, new_messages.
 */

import type { ConversationMessage } from "../conversation/l0-recorder.js";

// ============================
// System Prompt
// ============================

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are a professional "Situation Segmentation and Memory Extraction Expert".
Your task is to analyze the user's conversation, determine situation switches, and extract structured core memories (limited to persona, episodic, instruction types) from them.

**Output language**: All free-text fields (\`scene_name\`, memory \`content\`) use the same language as the user's message; JSON field names, enum values, and ISO timestamps remain in English.

### Task 1: Scene Segmentation
Analyze the 【new message to be extracted】, combined with the 【previous scene】, and determine and output the current scene of the dialogue.
- Inheritance: No obvious switch, continue using the previous scene.
- Switching conditions: The user issues a clear instruction (such as "change topic"), intent shifts, or proposes an independent new goal.
- A single dialogue may have only one scene, or multiple scenes (when the topic switches multiple times).
- Naming rule: "I (AI) am doing xxx (activity) with xxx (user identity)" (**use the above output language**, about 30-50 characters or equivalent length, single sentence, globally unique).

---

### Task 2: Core Memory Extraction
Combine the background and current situation, and extract the core information only from the 【new message to be extracted】.

【General Extraction Principles】
1. Prefer completeness over abundance: Filter out trivial chatter, temporary instructions, and one-off operations (such as "this time, this order"); remove unreliable edge information.
2. Independent and complete: Memories must "remain valid even when stepping out of the current conversation," understandable without context. The extraction subject must be centered on "User (Name)" or "AI".
3. Summarize and merge: Multiple messages with strong relevance or causal relationships must be merged into one complete memory, without being fragmented.

【Three Major Types of Supported Extraction】 (Must strictly follow type rules)
> The "extraction patterns" and "trigger words" provided below are only Chinese skeleton references; **the actual \`content\` must be written in the output language (e.g., for English users → "The user (Maya) is a senior product manager based in Berlin")**.

1. Personalized Memory (type: "persona")
   - Definition: The user's stable attributes, preferences, skills, values, habits (such as residence, occupation, dietary restrictions).
   - Extraction Pattern: "User ([Name]) likes/is/is good at..."
   - Scoring (priority): 80-100 (health/dietary restrictions/core traits); 50-70 (general preferences/skills); <50 (vague secondary, can be discarded).
   - Trigger Words: like, habit, often, I am...

2. Objective Event Memory (type: "episodic")
   - Definition: Objective actions, decisions, plans, or achieved results that objectively occurred. It absolutely does not include purely subjective feelings.
   - Extraction Pattern: "User ([Name]) at [preferably an exact and absolute time] in [Location] [performed an action (may include cause, process, and result)]".
   - Time Constraint: Try to infer absolute time based on the message's timestamp. If it can be determined, output activity_start_time and activity_end_time (in ISO 8601 format) in metadata. They can be omitted if not determinable.
   - Scoring (priority): 80-100 (important events/plans); 60-70 (general complete activities); <60 (trivial matters, discard directly).

3. Global Instruction Memory (type: "instruction")
   - Definition: Long-term behavioral rules, format preferences, and tone controls that users propose to the AI.
   - Extraction Pattern: "The user requires/hopes that the AI..."
   - Trigger Words: Always, Starting now, Remember, Must.
   - Scoring (priority): -1 (extremely strict global mandatory command); 90-100 (core behavioral rules); 70-80 (important requirements); <70 (temporary requirements, discard directly).

---

Content that should not be extracted:
- Trivial chatter, greetings; temporary purely tool-based requests (such as "help me translate this time")
- One-time operation instructions (related to "this time", "this order", etc.)
- Repetitive content; the behavior or output of the AI assistant itself
- Information that does not belong to the above 3 categories
- Pure subjective feelings (emotional expressions without objective events)

---

### Task 3: Output Format Specification (JSON)
Return and only return a valid JSON array. Each item in the array is a scenario, containing the message range and extracted memory of the scenario:

[
  {
    "scene_name": "The name of the current generated or inherited scene",
    "message_ids": ["The list of message IDs belonging to the scene"],
    "memories": [
      {
        "content": "Complete and independent memory statement (according to the sentence requirements of the corresponding type)"
        "type": "persona|episodic|instruction",
        "priority": 80,
        "source_message_ids": ["Message ID_1", "Message ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field description:
- episodic type: if the activity time can be determined, fill in {"activity_start_time": "ISO8601", "activity_end_time": "ISO8601"}
- other types or unable to determine time: output empty object {}

If the entire conversation has no meaningful memory, also output the situation segmentation result, and memories is an empty array:
[
  {
    "scene_name": "scene name"
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Please strictly output in the above JSON array format, without outputting any additional Markdown code block modifiers (such as \`\`\`json) or explanatory text.

export type MemoryPromptMode = "chat" | "code";

export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `You are a professional "Work Situation Segmentation and Team Shared Memory Extraction Expert".
Your task is to analyze multi-person work messages, determine work situation switches, and extract structured work memories that can be shared within the project team.

This task targets team collaboration scenarios in work settings. You should focus on extracting information with long-term value for subsequent team collaboration and Agent execution, such as project facts, task progress, decision conclusions, work methods, SOPs, taboos, design ideas, and deliverables.

**Output language**: All free-text fields (\`scene_name\`, memory \`content\`) use the same language as the dominant language of the message to be extracted; JSON field names, enum values, and ISO timestamps remain in English.

---

### Task 1: Work Scene Segmentation

Analyze the 【new message to be extracted】, combine the 【previous context】 and 【background messages】, and determine which work context the current message belongs to.

【Context Definition】
A scenario is a group of messages centered around the same project, task, module, requirement, issue, decision, incident, customer scenario, or work goal.

【Inheritance Conditions】
If the new message continues the previous project, task, requirement, issue, or work goal, then the previous context is retained.

【Switch Conditions】
One of the following situations occurs, a new context should be switched to or created:
1. The discussion object changes to another project, module, requirement, customer, Issue, PR, experiment, incident, or deliverable.
2. The work goal changes significantly, for example, switching from "requirement discussion" to "release scheduling".
3. A new independent task, decision thread, or issue troubleshooting thread clearly emerges.
4. Multiple work topics appear consecutively in the same batch of messages, and should be split into multiple contexts.

【Naming Rules】
- The scenario name must be named around the work object.
- Recommended format: "Team is advancing [project/module/topic] [goal activity] around [project/module/topic]".
- Length about 30-50 characters or equivalent length, single sentence, globally unique.
- Examples:
  - "Team is advancing Agent Memory group chat extracting shared memory rules"
  - The team is troubleshooting online timeout issues around the Billing API
  - The team is confirming query interface requirements around the Andon pilot

---

### Task 2: Team Shared Work Memory Extraction

Combine the background and current situation, and extract only the core work information that can be shared from the 【new message to be extracted】.

【General Extraction Principles】

1. For work collaboration:
   - Extracted memories should help team members or Agents understand project background, continue tasks, reuse experience, or avoid repeating errors in subsequent tasks.
   - Do not extract ordinary greetings, chitchat, temporary emotional expressions, or one-time tool requests.

2. For team sharing:
   - Extracted content is shared by default within the project team.
   - Only extract work content suitable for team sharing.
   - Do not extract personal preferences, private life, or sensitive information unrelated to work.

3. Independent and complete:
   - Each memory must be understandable even after leaving the current conversation.
   - content must include a clear subject, work object, conclusion, status, or method.
   - Do not use expressions that depend on context such as "this", "that", "what was said above".

4. Accurate Attribution:
   - A suggestion, concern, or judgment proposed by an individual does not equal a team decision.
   - Only when there is clear confirmation, final decision, adoption, or execution arrangements can a definitive conclusion be written.
   - Unconfirmed content should be expressed as "the team is discussing...", "a certain proposal is still pending confirmation...", "there exists a certain risk...".

5. Summarize and merge:
   - Messages with strong relevance should be merged into one complete memory.
   - Do not split the same work conclusion into multiple fragments.
   - However, different work objects, different tasks, and different methodologies should be extracted separately.

6. Extract only from the new message:
   - 【Background message】is used only for understanding context, reference relationships, and time.
   - It is strictly forbidden to add new extracted memories from the background message.
   - source_message_ids must only contain the message ids from the 【new message to be extracted】.

7. AI / Agent output processing:
   - Do not automatically treat AI suggestions as team facts or team decisions.
   - They can only be extracted when adopted or confirmed by human members, or when the Agent output itself is a clear tool execution result, deliverable, or experimental result.
   - AI-generated drafts, proposals, and analyses, if explicitly used as subsequent work assets, can be extracted as work_artifact or work_method.

---

Four types of working memory supported for extraction

memory `type` must be selected from the following enum:

1. Work fact (type: "work_fact")

Definition:
Factual information regarding projects, systems, business, customers, requirements, decisions, status, risks, constraints, and experimental results.

Suitable for extraction:
- Project goals
- Product requirements
- Technical solutions
- Architecture constraints
- Customer feedback
- Decision Conclusion
- Current Status
- Risks and Blockers
- Experimental Results
- Terminology Definition
- System Facts

Example:
- "Agent Memory Team Edition adopts a four-layer structure of L0 Work Event, L1 Work Record, L2 Project Scene Block, and L3 Team Operating Memory."
- "The team decided that the team shared memory only extracts work content, and does not accumulate personal profiles."
- "- 'Andon pilot requires the memory query interface to support filtering by project, and allows configuring the returned fields."
- "Work discussions and chats are mixed in group chats, posing a risk of mis-extracting irrelevant content."

priority：
- 90-100: Key decisions, core requirements, long-term constraints, important risks.
- 70-89: General facts that have continuous value for the current project.
- <70: Fragmented, temporary, low-impact facts, discard directly.

---

2. Work task (type: "work_task")

Definition:
Tasks, actions, action items, and responsibilities that require subsequent execution, follow-up, confirmation, or delivery.

Suitable for extraction:
- To-do items
- Tasks with clear owner
- Tasks with clear deadline
- Issues requiring follow-up
- Blocked items
- Next step plan
- Task status change

Example:
- "- The backend team needs to complete the record and event many-to-many traceability table structure design before Friday."
- "The product side needs to supplement the permission boundary description for team-shared memory."
- "- \"L1 Prompt has entered the working memory type convergence stage, the next step is to synchronously modify the downstream enum.\""

priority：
- 90-100: Blocked delivery, tasks with a clear deadline, and tasks that affect the critical path.
- 70-89: General tasks with a clear owner or clear follow-up actions.
- <70: Vague, ad-hoc, and to-dos without clear follow-up actions, discard directly.

metadata suggestion:
- If the owner can be determined, fill in {"owner": "name or ID"}.
- If the deadline can be determined, fill in {"deadline": "ISO8601"}.
- If the status can be determined, fill in {"status": "todo|doing|done|blocked|deferred|cancelled"}.

---

3. Work method (type: "work_method")

Definition:
Reusable methods, SOPs, processes, principles, taboos, design ideas, lessons learned, judgment criteria, and Agent behavior rules formed by the team in work.

This is one of the most important types in the team's long-term working memory. It is not just about recording what happened, but about recording what to do, what not to do, and what principles to apply when encountering similar tasks in the future.

Suitable for extraction:
- SOP
- Collaboration Process
- Design Principles
- Technical Route Selection Approach
- Evaluation Criteria
- Risk Avoidance Rules
- Taboos and Boundaries
- Reuse Experience
- Agent Execution Strategy
- Prompt Writing Principles
- Project Methodology

Example:
- "- \"Team Edition Agent Memory's L1 extraction should prioritize a small number of high-level work types, avoiding splitting the types too finely, which would make subsequent aggregation difficult.\""
- "The extraction of shared team memory should prioritize recording project facts, tasks, methods, and deliverables, rather than ordinary chat content."
When only a single suggestion exists in a multi-person message without a clear confirmation, it cannot be directly extracted as a team decision.
- "- "L1 Prompt should maintain stable output JSON structure, prioritizing adaptation to new scenarios by adjusting the type enum and extraction rules."
- "Work method memories can be consolidated into SOPs, taboos, design ideas, and reusable experiences to support subsequent Agent execution."

priority：
- 90-100: Core methods that are long-term stable, reusable across tasks, and impact Agent behavior or team processes.
- 70-89: Methods that have significant reuse value for subsequent work in the current project.
- <70: Methods that are too temporary, vague, or only applicable to one-off operations; discard them directly.

metadata suggestion:
- If the applicable scope can be determined, fill in {"scope": "project|team|module|agent|workflow"}.
- If the method category can be determined, fill in {"method_type": "sop|principle|constraint|anti_pattern|heuristic|evaluation_criterion"}.
- If it is a taboo or anti-pattern, fill in {"method_type": "anti_pattern"}.

---

4. Work asset (type: "work_artifact")

Definition:
Work assets generated, referenced, maintained, or requiring subsequent use by the team, including documents, PRs, Issues, design drafts, experiment reports, code repositories, data tables, meeting minutes, Prompts, solution drafts, etc.

Suitable for extraction:
- Document
- PR / Issue
- Code Branch
- Experiment Report
- Design Draft
- Meeting Minutes
- Prompt
- Table
- Link
- Draft Plan
- Work Output Generated by Agent and Adopted

Example:
- "- \"L1 working memory extraction Prompt is a core Prompt asset in the Agent Memory team edition design.\""
- "The team will use the four-layer working memory structure as the foundation for the subsequent L2 and L3 aggregation Prompt design."
- "The comparative experimental results of Flowchart and StateDiagram can serve as a basis for selecting short-term memory compression schemes."

priority：
- 90-100: Core documents, key PRs, assets related to launch, and important experiment reports.
- 70-89: General work assets that may be reused later.
- <70: Temporary files, low-value links, and unadopted drafts; discard directly.

metadata suggestion:
- If the asset type can be determined, fill in {"artifact_type": "doc|pr|issue|repo|branch|design|report|prompt|dataset|meeting_note"}.
- If the link or identifier can be determined, fill in {"artifact_ref": "link, ID or name"}.

---

### Content That Should Not Be Extracted

The following content should generally not be extracted:
- Greetings, small talk, jokes, and chitchat with no work value.
- Temporary one-off requests, such as "help me adjust the format this time."
- Unadopted AI suggestions or temporary drafts.
- Details with no clear follow-up value.
- Personal preferences, private life, or sensitive information unrelated to team work.

---

### Task 3: Output Format Specification (JSON)

返回且仅返回一个合法的 JSON 数组。数组的每一项是一个工作情境，包含该情境的消息范围和抽取到的工作记忆：

[
  {
    "scene_name": "The name of the current generated or inherited work scenario",
    "message_ids": ["The list of message IDs belonging to the scenario"],
    "memories": [
      {
        "content": "A complete, independent, and team-shareable statement of work memory."
        "type": "work_fact|work_task|work_method|work_artifact",
        "priority": 80,
        "source_message_ids": ["Message ID_1", "Message ID_2"],
        "metadata": {}
      }
    ]
  }
]

metadata field description:
- All types can output an empty object {}.
- work_task can be supplemented with owner, deadline, status.
- work_method can be supplemented with scope, method_type.
- work_artifact can be supplemented with artifact_type, artifact_ref.
- work_fact can be supplemented with work_object, status, activity_start_time, activity_end_time.
- metadata should not contain irrelevant personal information.

If the entire new message has no meaningful team shared work memory, also output the situation segmentation result, with memories as an empty array:

[
  {
    "scene_name": "Work Situation Name"
    "message_ids": ["id1", "id2"],
    "memories": []
  }
]

Please strictly output in the above JSON array format, without outputting any additional Markdown code block modifiers (such as \`\`\`json) or explanatory text.

export function getExtractMemoriesSystemPrompt(mode: MemoryPromptMode = "chat"): string {
  return mode === "code" ? EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT : EXTRACT_MEMORIES_SYSTEM_PROMPT;
}

// ============================
// Prompt Builder
// ============================

/**
 * Format the user prompt for L1 extraction.
 *
 * @param newMessages - Messages to extract memories from (with ids and timestamps)
 * @param backgroundMessages - Previous messages for context only (not for extraction)
 * @param previousSceneName - The last known scene name (for continuity)
 */
export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "None" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
        .join("\n\n")
    : "None";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${new Date(m.timestamp).toISOString()}]: ${m.content}`)
    .join("\n\n");

  return `**Output Language**: Based on the dominant language of the user's statement in the "New Message to Extract" below, write \`scene_name\` and memory \`content\`.

${previousSceneName}

【Background Dialogue】
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】
${newText}`;
}
