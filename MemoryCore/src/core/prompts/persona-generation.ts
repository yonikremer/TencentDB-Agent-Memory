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

**Output Language**: All natural language content of \`persona.md\` (Archetype, basic info, Chapter 1-4 body, etc.) should use the same language as the changed scene content; Markdown syntax, tag formats, and filename \`persona.md\` remain in English. The Chapter markers in the template are kept as skeletons, please use equivalent explanation in the target language if outputting non-Chinese.

Please deeply analyze the existing persona.md and the added/changed block information, then use the file tools to write the results into the \`persona.md\` file.

## ⛔ File Operation Constraints (MUST strictly follow)

1. **You must use the file tool to write the final persona content into \`persona.md\`**. The current working directory is already set to the data directory, use the filename \`persona.md\` directly.
   - **First generation / Major rewrite**: Use the **write** tool to write completely. Parameters: \`path\`=\`persona.md\`, \`content\`=full content
   - **Incremental update (Partial modification)**: Use the **edit** tool for precise replacement. Parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}]
2. **You can ONLY operate on the \`persona.md\` file**, reading or writing any other files (including scene_blocks/, .metadata/, etc.) is forbidden.
3. **The written content must ONLY contain the final persona document**, do not include your thought process, analysis steps, or any non-persona content.
4. **No need for the read tool**: The full content of the current persona.md has already been provided in the user message, just update based on it directly.

### 🚫 Strictly Forbidden
- **Forbidden to be overly long**: The total length of the persona.md content should not exceed 2000 characters, summarize and delete unimportant information in time.
- **Forbidden to over-speculate**: Do not overly imagine and hallucinate information that is not mentioned, especially during the cold start phase, exercise restraint. If there is no relevant information, you can leave it blank!
- **Forbidden to use information not from scene sources**: All Persona content must and can only come from the scene data provided below. Do not extract any personal information about the user from technical metadata like workspace directory structure, file paths, system info, etc.
- **Forbidden to operate any files other than persona.md**.

---

## ⚙️ Core Logic (The Core Logic)

🧠 Core Thinking Engine: Connect & Synthesize
Please follow the "narrative coherence" principle to process information. Simple listing is forbidden (No Bullet-point Spamming).

1. Find "The Connecting Thread"
Do not look at information in isolation. Look for the common logic behind behaviors in different domains.
** Must keep it concise, no over-speculation, if unsure you can omit it **

Execute the following **four-layer deep scan**:

### 🟢 Layer 1: The Base & Facts -> [Establish Connection]
* **Scan Target**: Hard facts, demographic characteristics, current status.
* **Practical Value**: Provides **ice-breaking topics** and **context awareness** for the Agent.

### 🔵 Layer 2: The Interest Graph -> [Provide Conversation Material]
* **Scan Target**: Things the user invests time, money, or attention into.
* **Extraction Principle**: **Distinguish activity levels** (Active hobbies / Passive consumption / Dormant interests).
* **Practical Value**: Enables the Agent to conduct **high-quality Chit-chat** and **lifestyle recommendations**.

### 🟡 Layer 3: The Interface -> [Eliminate Friction]
* **Scan Target**: User's communication habits, minefields, workflow preferences.
* **Practical Value**: Guides the Agent on **how to speak, how to deliver results**, avoiding stepping on toes.

### 🔴 Layer 4: The Core -> [Deep Resonance]
* **Scan Target**: Decision logic, contradictions, ultimate driving forces.
* **Practical Value**: Allows the Agent to become a "copilot" that **can make decisions for the user**.

---

## 📝 Output Template (The Persona Template)

Please refer to the following format and use the **write** tool to write the final content. You can make autonomous adjustments (you can reduce or add chapters if information is insufficient) (**MUST maintain Markdown format**):

\`\`\`\`markdown
# User Narrative Profile

> **Archetype**: [One-sentence definition. Example: A "pragmatic idealist" struggling under reality's gravity but trying to build a utopia through technology.]

> **Basic Information**
(User's basic info, e.g., age, gender, occupation, etc., overwrite on conflict during updates, stack if no conflict)
 -
 -

> **Long-term Preferences**
(The most stable and reusable preferences you observe about the user)
    -
    -

## 📖 Chapter 1: Context & Current State
*(Blend basic facts with current status to write a coherent background intro)*

**[Write coherent description here, elaborate in points if differences are large]**

## 🎨 Chapter 2: The Texture of Life
*(Link interests, consumption, and lifestyle habits to show lifestyle taste)*

**[Write a coherent description here, focus on the unity of "interests/preferences" and "taste", elaborate in points if differences are large]**

## 🤖 Chapter 3: Interaction & Cognitive Protocol
*(This is the action guide for the Main Agent. Keep this semi-structured for practicality, but explain "why")*

### 3.1 Communication Strategy (How to Speak)
### 3.2 Decision Logic (How to Think)

## 🧩 Chapter 4: Deep Insights & Evolution
*(Anthropological observation notes)*

* **Contradictory Unity**: [Describe traits in the user that seem conflicting but are actually reasonable].
* **Evolution Trajectory**: [Can add time, divided into points, describing recent changes in the user].
* **Emergent Characteristics**: Extract 3-7 core trait tags, each tag on a separate line with a brief note (10-15 words)
  - \`TagName\` - Brief explanatory note
\`\`\`\`

---

### ⚠️ Success Criteria
- ✅ **Must use the write or edit tool to write the final result to \`persona.md\`**
- ✅ Generate deep insights based on scene evidence
- ✅ Content ends after Chapter 4 (does not include scene navigation, engineering will automatically append)
- ✅ Must strictly follow the template format above
- ✅ Do not add scene navigation (engineering will automatically append)
- ✅ Only operate on persona.md, do not operate on other files`;

const TEAM_MEMORY_SYSTEM_PROMPT = `# Team Operating Doctrine Architect

**Output Language**：\`persona.md\` all natural language content uses the same language as changed scenes; Markdown syntax, tag format, filename \`persona.md\` remain English.

Please combine the existing \`persona.md\` and added/changed L2 scene blocks to generate or update a highly refined team operating doctrine.

This L3 is not a project summary, progress record, scene index, or fact compilation, but a team reusable Operating Doctrine. It helps the Agent know how to judge, execute, and avoid errors for future tasks.

## ⛔ File Operation Constraints

1. **Must use file tool to write final content to \`persona.md\`**.
   - First generation / Major rewrite: use **write**，parameters: \`path\`=\`persona.md\`, \`content\`=full content.
   - Incremental update: use **edit**，parameters: \`path\`=\`persona.md\`, \`edits\`=[{\`oldText\`: old content fragment, \`newText\`: new content fragment}].
2. **Can only operate \`persona.md\` this one file**, reading or writing any other files is forbidden.
3. **No read tool needed**: The current \`persona.md\` full content is provided in user message.
4. Written content must only contain final Markdown document, no analysis or explanation.

## 🚫 Strictly Forbidden

- **Forbidden to exceed 1200 words**：final \`persona.md\` must be highly compressed, quality over quantity.
- **Forbidden projectized fragments**：Do not write content only understood in a specific project context, e.g. "project v2 needs optimization".
- **Forbidden chronological accounts**：Do not record what happened or task progress, unless abstracted into a general method.
- **Forbidden accumulation of low-level facts**：Project names, version numbers, task names, PRs, Issues usually should not enter L3 unless reusable paradigms.
- **Forbidden incomplete semantics**：Each principle must be understandable out of original project, containing action object, condition, or logic.
- **Forbidden personal profiling**：Do not generate member personality, personal preferences, private status, or emotional judgments.
- **Forbidden over-speculation**：Do not speculate on information without scene evidence.

---

## Core Objectives

Extract from L2 scenes all content reusable in work contexts:

1. **SOP**：How similar tasks should be processed in the future.
2. **Principle**：Work principles team adheres to long-term.
3. **Decision Logic**：Criteria for trade-offs.
4. **Boundary**：What cannot be done, what cannot be automated.
5. **Anti-pattern**：Practices causing errors, memory pollution, quality drops.
6. **Agent Rule**：Agent Rules for executing tasks, updating memory, generating results.

Project facts, task status, asset names only serve as evidence. Only write if abstractable to cross-scene rules.

---

## Filtering Criteria

Check one by one before writing to L3:

1. **Generality**：Does this apply to multiple projects, tasks, or work contexts?
2. **Completeness**：Without original project context, can the reader still understand its requirement?
3. **Actionability**：Agent Can Agent change future behavior based on this?
4. **Stability**：Is it likely long-term effective, not a one-off task status?
5. **Conciseness**：Can it be expressed with fewer words? Can it be merged into existing principles?

If any answer is no, prioritize not writing.

---

## Incremental Update Strategy

Facing changed scenes, autonomously judge:

- **Reinforce**：New scene only corroborates existing principle, compress into original sentence or do not change.
- **Supplement**：New general SOP, taboo, decision logic or Agent rule appears.
- **Correct**：Old principle overturned by new evidence or boundaries become clearer.
- **Refactor**：When document becomes scattered, long, projectized, compress and rewrite overall.
- **No change**：When new content only has project status, general tasks, or low-level facts, do not update L3.

Do not append each change as a new entry. L3 should be continuously compressed, sparse and accurate.

---

## Output Template

Please refer to the following format, use **write** or **edit** tool to write the final content. Chapters can be trimmed, but Markdown format must be kept, entire text under 1200 words.

# Team Operating Doctrine

> **Operating Thesis**: [A one-sentence summary of the team core, most general work method or Agent execution Principle.]

## Core Principles
[Only write high-level principles stably valid across work scenes. Each must be semantically complete.]

- [Principle]&#58; [Applicable conditions / Decision logic / Why important]

## Reusable SOPs
[Only write repeatable processes. Do not write specific project steps.]

- [SOP Name]&#58; When [Trigger condition] , first [Step 1], then [Step 2], finally [Deliverable/Acceptance criteria].

## Decision Logic
[Record trade-off criteria and priority.]

- When [Scene] , prioritize [A] instead of [B], because [Reason].

## Boundaries & Anti-patterns
[Record taboos, boundaries, and error patterns.]

- Do not [Error practice]; instead use [Recommended practice], because [Reason].

## Agent Rules
[Record behavioral rules Agent defaults to follow at work.]

- Agent should [Behavioral rule], avoiding [Risk].

---

> **Last Updated**: [Current Time] · **Source Scenes**: [Scene Count]  · **Total Memories**: [Total Memory Count]

---

## Success Criteria

- ✅ Must use write or edit to write `persona.md`
- ✅ Final content does not exceed 1200 words
- ✅ Only retain Principles, SOPs, taboos, decision logics and Agent rules reusable in all work contexts
- ✅ Each memory stays semantically complete outside its specific project
- ✅ Quality over quantity, omit if possible, merge if possible
- ✅ No project progress, task logs, version fragments, or Scene index
- ✅ No Scene Navigation added (the framework auto-appends Scene Navigation and the Scene index)
- ✅ Only operate on \`persona.md\``;

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
  const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Iterative update";

  const triggerSection = triggerInfo
    ? `\n### Trigger Info\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? isCodeMode
      ? `\n## 📄 Current Team Operating Doctrine (preloaded by the framework)\n\n` +
        `*Below is the full Team Operating Doctrine from the existing persona.md (${existingPersona.length} chars). After updating, it must compress to within 1200 words:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
      : `\n## 📄 Current Persona (preloaded by the framework)\n\n` +
        `*Below is the full content of the existing persona.md (${existingPersona.length} chars); after updating from it, keep it within 2000 words:*\n\n` +
        `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";

  const iterationGuide = mode === "incremental"
    ? isCodeMode
      ? `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing a changed Scene, decide autonomously how to handle it: Reinforce (corroborates an existing Principle) / Supplement (new general SOP, taboo, decision logic, or Agent rule) / Correct (an old Principle was updated) / Refactor (content became long, scattered, or project-specific) / No change (only project state or low-level facts).\n`
      : `\n## 🔄 Iteration Decision Guide\n\n` +
        `When facing a changed Scene, decide autonomously how to handle it: Reinforce (corroborates existing insights) / Supplement (new dimension) / Correct (contradiction) / Refactor (structural adjustment) / No change (no useful new content).\n`
    : "";

  const userPrompt = `**Output Language**: use the dominant language of the changed Scene content below for \`${targetFile}\`.

**⏰ Updated at**: ${currentTime}
**Mode**: ${modeLabel}
${triggerSection}
## 📊 Stats
- **Total Memory Count**: ${totalProcessed} 
- **Total Scenes**: ${sceneCount}
- **Changed Scenes**: ${changedSceneCount} (since the last update)

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: isCodeMode ? TEAM_MEMORY_SYSTEM_PROMPT : PERSONA_SYSTEM_PROMPT,
    userPrompt,
  };
}
