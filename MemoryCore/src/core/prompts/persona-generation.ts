/**
 * Persona Generation Prompt — instructs LLM to generate/update user persona
 * using the four-layer deep scan model.
 *
 * v3: Split into systemPrompt (role + constraints + logic + template) and
 * userPrompt (data). Tool names aligned to OpenClaw actual API (write/edit).
 */

import type { MemoryPromptMode } from "../../config.js";

export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  promptMode?: MemoryPromptMode;
  currentTime: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

// ============================
// System Prompt (stable: role + constraints + logic + template)
// ============================

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**Output language**:The natural language content of all `persona.md` (including Archetype, basic information, Chapter 1-4 body text, etc.) uses the same language as the change scenario content; Markdown syntax, tag formatting, and the file name `persona.md` remain in English. The Chapter identifiers in the template are kept as the skeleton, and when outputting in the target language, please use the corresponding explanatory descriptions in the target language.

<tool_call>file_tools<arg_key>files</arg_value><arg_key>path</arg_key><arg_value>persona.md</arg_value></tool_call>

## ⛔ File Operation Constraints (Must strictly follow)

1. **You must use the file tool to write the final persona content to \`persona.md\`**. The current working directory is set to the data directory, so use the filename \`persona.md\` directly.
   - **First generation / Major rewrite**: Use the **write** tool to write the entire content. Parameters: \`path\`=\`persona.md\`, \`content\`=complete content
   - **Incremental update (local modification)**: Use the **edit** tool for precise replacement. Parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}]
2. **You can only operate on \`persona.md\`**, and it is forbidden to read or write any other files (including scene_blocks/, .metadata/, etc.).
3. **The content to be written must only contain the final persona document**, without your thinking process, analysis steps, or any non-persona content.
4. **No need to use the read tool**: The complete content of persona.md is already provided in the user message, so you can directly update it based on it.

### 🚫 Strictly Prohibited
- **Prohibition of excessive length**: The total length of persona.md should not exceed 2000 characters. Summarize and delete irrelevant information in a timely manner.
- **Prohibition of excessive speculation**: Do not over-estimate and generate hallucinations for information not mentioned, especially during the cold start phase. Maintain restraint, and if there is no relevant information, you can leave it blank entirely!
- **Prohibition of using information from non-scenario sources**: All content of Persona must and can only come from the scenario data provided below. Do not extract any personal information about the user from technical metadata such as workspace directory structure, file paths, or system information.
- **Prohibition of operating any files other than persona.md**.

---

## ⚙️ Core Logic

🧠 Core Thinking Engine: Connect & Synthesize
Please follow the "Narrative Coherence" principle when processing information. Prohibit simple listing (No Bullet-point Spamming).

1. Find "The Connecting Thread"
Do not view information in isolation. Seek the common logic behind behaviors across different fields.
** Keep it concise, do not over-speculate, and do not write if uncertain **

Execute the following **four-layer depth scan**:

### 🟢 Layer 1: The Base & Facts -> 【Establishing Connections】
* **Scan Target**: Concrete facts, demographic characteristics, and current status.
* **Practical Value**: Provide the Agent with **ice-breaking topics** and **context awareness**.

### 🔵 Layer 2: The Interest Graph (For Conversation Topics) -> 【Providing Conversation Material】
* **Scan Target**: Things the user invests time, money, or attention into.
* **Extraction Principle**: **Distinguish Activity Level** (Active Hobbies / Passive Consumption / Dormant Interests).
* **Practical Value**: Enables the Agent to conduct **high-quality Chit-chat** and **lifestyle Recommendations**.

### 🟡 Layer 3: The Interface -> 【Eliminate Friction】
* **Scan Target**: The user's communication habits, pitfalls, and workflow preferences.
* **Practical Value**: Guides the Agent **how to speak and how to deliver results**, avoiding pitfalls.

### 🔴 Layer 4: The Core (The Core) -> 【Deep Resonance】
* **Scan Target**: Decision logic, points of contradiction, ultimate driving forces.
* **Practical Value**: Make the Agent a **"co-pilot" capable of making decisions on behalf of the user**.

---

## 📝 Output Template (The Persona Template)

**write**

\`\`\`\`markdown
# User Narrative Profile

**Archetype (Core Prototype)**: [A one-sentence definition. For example: a "pragmatic idealist" who struggles against real-world gravity but attempts to build an ideal world through technology.]

**Basic Information**
(User's basic information, such as age, gender, occupation, etc. If there is a conflict when updating, it will be overwritten; if there is no conflict, it will be added as much as possible)
 -
 -

**Long-term Preferences**
（The most stable and reusable preferences observed from the user）
    -
    -

## 📖 Chapter 1: Context & Current State (Full Context)
*(Fuses foundational facts with the current state, written as a coherent background introduction)*

**[Write coherent descriptions here; when there are significant differences, you may elaborate in bullet points]**

## 🎨 Chapter 2: The Texture of Life (The Texture of Life)
*(Connecting interests, consumption, and lifestyle habits, showcasing lifestyle taste)*

**[Write a coherent description here, focusing on the unity of "interests/preferences" and "taste. When there are significant differences, you may elaborate in bullet points]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(This is the action guide for the Main Agent. To be practical, it is kept semi-structured, but it explains "why".)*

### 3.1 Communication Strategy (How to Speak)
### 3.2 Decision Logic (How to Think)

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological Observation Notes)*

* **Unity of Contradiction**: [Describe the seemingly conflicting yet actually reasonable traits on the user].
* **Evolution Trajectory**: [Can include time, divided into multiple points, describing the user's recent changes].
* **Emergent Features**: Extract 3-7 core trait tags, each on a separate line with a brief comment (10-15 words)
  - \`TagName\` - Brief comment explaining
\`\`\`\`

---

### ✅ Success Criteria
- ✅ **Must use the write or edit tool to write the final result to \`persona.md\`**
- ✅ Generate in-depth insights based on scenario evidence
- ✅ Content should end at Chapter 4 (excluding scenario navigation, which the engineering system will append automatically)
- ✅ Must strictly follow the template format above
- ✅ Do not add scenario navigation (the engineering system will append it automatically)
- ✅ Only operate on persona.md, do not operate on other files;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output language**:\`persona.md\` 的所有自然语言内容使用与变化场景内容相同的语言；Markdown 语法、标签格式、文件名 \`persona.md\` 保持英文。

Please generate or update a highly refined team work principles document based on the existing \`persona.md\` and the newly added or changed L2 scenario blocks.

This L3 is not a project summary, progress record, scenario index, or fact compilation, but an Operating Doctrine that the team can reuse in various work settings. It should help the Agent, when facing new tasks in the future, know how to judge, how to execute, and how to avoid errors.

## ⛔ File Operation Constraints

1. **You must use the file tool to write the final content to \`persona.md\`**.
   - First generation / major rewrite: use **write**, parameters: \`path\`=\`persona.md\`, \`content\`=complete content.
   - Incremental update: use **edit**, parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}].
2. **You can only operate on \`persona.md\` and no other files are allowed to be read or written.**
3. **No need for read tool**: the complete content of \`persona.md\` is already provided in the user message.
4. The written content must only contain the final Markdown document, without analysis process or explanation.

## 🚫 Strictly Prohibited

- **Prohibit exceeding 1200 words**: The final \`persona.md\` must be highly compressed, prioritizing refinement over quantity.
- **Prohibit project-specific fragments**: Do not include content that is only understandable within a specific project context, such as "optimize project v2" or "continue advancing a certain module".
- **Prohibit chronological accounts**: Do not record what happened, who did what, or how a task progressed, unless it has been abstracted into a general method.
- **Prohibit accumulation of low-level facts**: Project names, version numbers, task names, PRs, Issues, and document names should generally not be included in L3, unless they represent a reusable paradigm.
- **Prohibit incomplete semantics**: Each principle must be understandable independently of the original project, must include the action object, applicable conditions, or judgment logic.
- **Prohibit personal profiling**: Do not generate member personalities, personal preferences, private states, or emotional judgments.
- **Prohibition on excessive speculation**: Do not speculate on information without scenario evidence.

---

Core Objective

You need to extract all content that can be reused in work settings from the L2 scenario:

1. **SOP**: What process should be followed for similar tasks in the future.
2. **Principle**: The work principles that the team should adhere to long-term.
3. **Decision Logic**: What criteria to use when making trade-offs.
4. **Boundary**: What things cannot be done and what content cannot be automated.
5. **Anti-pattern**: What practices will lead to errors, pollute memory, and reduce quality.
6. **Agent Rule**: What rules should be followed by the Agent when executing tasks, updating memory, and generating results.

Project facts, task status, and asset names serve only as evidence sources and should not be directly entered into L3. They are only written when they can be abstracted into cross-scenario rules.

---

## Filter Criteria

Check item by item before writing L3:

1. **Generality**: Is this content applicable to multiple projects, tasks, or work scenarios?
2. **Completeness**: After separating from the original project, can readers still understand what it requires?
3. **Executability**: Can the Agent change future behavior based on this?
4. **Stability**: Is it likely to remain effective long-term, rather than being a one-time task state?
5. **Conciseness**: Can it be expressed with fewer words? Can it be merged into existing principles?

If any answer is negative, prioritize not writing it.

---

## Incremental Update Strategy

Adjudicate independently to changing scenarios:

- **Enhancement**: New scenarios merely corroborate existing principles, so they should be compressed into the original sentence or left unchanged.
- **Supplement**: New general SOPs, prohibitions, judgment logic, or Agent rules appear.
- **Correction**: Old principles are overturned by new evidence or boundaries become clearer.
- **Restructuring**: When the document becomes scattered, longer, or project-based, compress and rewrite it as a whole.
- **No Change**: When new content only involves project status, routine tasks, or low-level facts, do not update L3.

Do not append each change as a new entry. L3 should continue to be compressed, keeping it concise and accurate.

---

## Output Template

Please refer to the following format, use the **write** or **edit** tool to write the final content. You may delete chapters, but must maintain the Markdown format, and the entire text shall not exceed 1200 characters.

# Team Operating Doctrine

**Operating Thesis**: [A one-sentence summary of the team's most core and universal work methods or Agent execution principles.]

## Core Principles
Establish high-level principles that remain stable and applicable across cross-work scenarios. Each principle must be semantically complete.

- [Principle]&#58; [Applicable Conditions / Judgment Logic / Why It Is Important]

## Reusable SOPs
[Only write processes that can be repeatedly executed. Do not write specific project steps.]

- [SOP Name]&#58; When [Trigger Condition], first [Step 1], then [Step 2], finally [Output/Acceptance Criteria].

## Decision Logic
[Record the criteria and priority for selection.]

- When [scenario], prioritize [A] over [B], because [reason].

## Boundaries & Anti-patterns
[Record taboos, boundaries, and error patterns.]

- Do not [wrong approach]; instead, use [recommended approach], because [reason].

## Agent Rules
Record the behavior rules that the Agent should follow by default in its work.

- Agent should [behavior rules], avoid [risks].

---

> **Last Updated**: [Current Time] · **Source Scenario**: [Number of Scenarios] · **Total Memories**: [Total Memory Count]

---

Success Criteria

- ✅ Must use `write` or `edit` to write to \`persona.md\`
- ✅ The final content should not exceed 1200 characters
- ✅ Only retain principles, SOPs, taboos, judgment logic, and Agent rules that are reusable in all work scenarios
- ✅ Each piece of content should remain semantically complete even after being separated from a specific project
- ✅ Prioritize refinement over quantity, do not write if unnecessary, and merge where possible
- ✅ Do not write project progress, task logs, version fragments, or scenario indexes
- ✅ Do not add scene navigation (the project will automatically append Scene Navigation and scene index)
- ✅ Only operate on \`persona.md\`

// ============================
// User Prompt builder (dynamic data)
// ============================

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    promptMode = "chat",
    currentTime,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const isCodeMode = promptMode === "code";
  const targetFile = "persona.md";
  const modeLabel = mode === "first" ? "🆕 First Generation" : "🔄 Iterative Update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (Engineering Preloaded)\n\n` +
        `*The following is the complete content of Team Operating Doctrine from the existing persona.md (${existingPersona.length} characters). After updating, it must be compressed to within 1200 characters:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current Persona (Engineering Preloaded)\n\n` +
        `*The following is the complete content of the existing persona.md (${existingPersona.length} characters), and after updating based on this, please keep it within 2000 words:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changing scenarios, autonomously judge the handling approach: Strengthen (support existing principles) / Supplement (new general SOPs, prohibitions, judgment logic, or Agent rules) / Revise (old principles are updated) / Refactor (content becomes longer, scattered, or project-based) / No Change (only project status or low-level facts).\n`
      : `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing changing scenarios, autonomously judge the handling approach: Strengthen (support existing insights) / Supplement (new dimensions) / Revise (contradictions) / Refactor (structure adjustment) / No Change (no useful new content).\n`
    : "";

  const userPrompt = `**Output Language**: Use the dominant language of the changed scenario content in the file below.

**Update Time**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Statistics
- **Total memory count**: ${totalProcessed} items
- **Total scenes**: ${sceneCount} items
- **Changed scenes**: ${changedSceneCount} items (since last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
