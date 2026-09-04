import os

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-dedup.ts'
with open(p, 'r', encoding='utf-8') as f:
    c = f.read()

old_conflict = """export const CONFLICT_DETECTION_SYSTEM_PROMPT = `你是记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（persona / episodic / instruction / work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一事实/事件，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。

## 判断逻辑

1. **分辨记忆性质**：
   - **状态类**（persona/instruction）：偏好、特质、长期设定、相对稳定的事实、行为规则
   - **事件类**（episodic）：一次性经历、带时间点的客观记录，建议合并同一件事的前因后果

2. **判断是否同一事实/事件**：主体相同、主题一致、时间接近、scene_name 相似

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一事实/事件，新记忆在内容或时间上更优（更具体、更晚或纠错），以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一事实或同一演化过程，多条记忆信息互补且不矛盾，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - 状态类：多条描述同一偏好/特质 → 倾向 merge；无增量 → skip；明确更新 → update
   - 事件类：同一事件的前因后果、不同阶段 → 倾向 merge 为一条完整叙述；完全相同 → skip
   - 跨类型示例：一条 episodic "用户在 2018 年开始做播客" + 一条 persona "用户有播客制作经验" → 可 merge 为一条 persona 或 episodic（取决于信息侧重）

5. **timestamp 处理**：
   - merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）
   - 这样可以保留事件发生的完整时间线

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type：persona|episodic|instruction|work_fact|work_task|work_method|work_artifact（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组，包含所有新旧记忆时间戳的并集（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，merge/update 时必填）。合并后信息更完整、更确定，通常应**酌情提升** priority（例如两条 priority 70 的记忆合并后可提升到 80）。参考标准：80-100（核心特质/重要事件），60-79（一般偏好/普通活动），<60（次要信息）。
- merged_timestamps：合并后的时间戳数组。收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;"""

new_conflict = """export const CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a memory conflict detector. Batch compare multiple [New Memories] against existing memories in the [Unified Candidate Pool], and decide how to handle each one individually.

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
- merged_timestamps: Array of timestamps after merge. Collect timestamps of the new memory + all merged old memories, deduplicate and sort.`;"""

old_work_conflict = """export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `你是团队工作记忆冲突检测器。批量比较多条【新记忆】与【统一候选记忆池】中的已有记忆，逐条决定如何处理。

**输出语言**：\`merged_content\` 使用与候选池中已有记忆相同的语言；JSON 字段名、枚举值、record_id、ISO 时间戳保持英文。

## 核心规则

- **跨 type 合并**：不同 type（work_fact / work_task / work_method / work_artifact）的记忆如果语义上描述同一工作对象、任务、方法或资产，**可以合并**。
- **多对多合并**：一条新记忆可以同时替换/合并候选池中的**多条**已有记忆（通过 target_ids 数组指定）。
- 合并后你必须判断新记忆的最佳 type（merged_type）。
- 记忆默认会在项目团队内共享，合并内容应只保留工作相关信息。

## 判断逻辑

1. **分辨记忆性质**：
   - **工作事实类（work_fact）**：项目事实、需求、决策、状态、风险、约束、实验结果、客户反馈。
   - **工作任务类（work_task）**：待办、owner、deadline、下一步计划、任务状态变化。
   - **工作方法类（work_method）**：SOP、禁忌、原则、经验、设计思路、判断标准、Agent 行为规则。
   - **工作资产类（work_artifact）**：文档、PR、Issue、Prompt、报告、代码分支、设计稿、链接等。

2. **判断是否同一工作对象/演化过程**：
   - 同一项目、模块、需求、任务、风险、决策、方法、资产，且 scene_name 或语义高度相似。
   - 同一任务的不同阶段、同一方法的补充、同一资产的版本或用途变化，通常可以合并。
   - 仅属于同一大项目但讨论对象不同，不应强行合并。

3. **选择动作**：
   - "store"：视为新信息，新增当前记忆。
   - "skip"：已有记忆更好，新记忆无增量或更模糊，忽略当前记忆。
   - "update"：同一工作对象，新记忆更具体、更新、更权威或纠正旧信息，以新记忆为主覆盖旧记忆，可保留旧记忆中仍正确的细节。
   - "merge"：同一工作对象或同一演化过程，新旧记忆互补且不矛盾，合并成一条更完整记忆，信息尽量不冗余。

4. **策略倾向**：
   - work_fact：同一事实/决策/状态的补充或修正 → 倾向 update 或 merge。
   - work_task：同一任务的 owner、deadline、状态变化 → 倾向 update；补充依赖或验收标准 → 倾向 merge。
   - work_method：同一 SOP、禁忌、原则、经验的补充 → 倾向 merge；更清晰通用的表述 → 倾向 update。
   - work_artifact：同一文档、PR、Prompt、报告等资产的用途、版本、链接补充 → 倾向 merge 或 update。
   - 跨类型示例：一条 work_fact "团队决定 L1 type 保持少量高层分类" + 一条 work_method "L1 type 不宜过细，否则影响 L2/L3 聚合" → 可 merge 为 work_method。

5. **timestamp 处理**：
   - merge / update 时，merged_timestamps 应包含**所有相关记忆的时间戳并集**（去重排序）。
   - 这样可以保留工作事实、任务或方法演化的完整时间线。

## 输出格式

严格输出 JSON 数组，每个元素对应一条新记忆的决策。不输出任何其他内容：

[
  {
    "record_id": "新记忆的 record_id",
    "action": "store|update|skip|merge",
    "target_ids": ["要删除的候选记忆 record_id 1", "record_id 2"],
    "merged_content": "合并/更新后的记忆内容（merge/update 时必填）",
    "merged_type": "合并后的最佳 type：work_fact|work_task|work_method|work_artifact（merge/update 时必填）",
    "merged_priority": 85,
    "merged_timestamps": ["合并后的时间戳数组，包含所有新旧记忆时间戳的并集（merge/update 时必填）"]
  }
]

字段说明：
- target_ids：要删除替换的旧记忆 ID **数组**（可以 1 条或多条）。store/skip 时省略或为空。
- merged_content：merge/update 时的最终记忆文本。store/skip 时省略。
- merged_type：merge/update 后记忆应归属的 type。根据合并后内容本质判断。
- merged_priority：merge/update 后的新优先级（0-100 整数，merge/update 时必填）。合并后信息更完整、更确定，通常应**酌情提升** priority。参考标准：80-100（关键事实/重要任务/核心方法/重要资产），60-79（一般工作信息），<60（次要信息）。
- merged_timestamps：合并后的时间戳数组。收集新记忆 + 所有被合并旧记忆的时间戳，去重排序。`;"""

new_work_conflict = """export const WORK_CONFLICT_DETECTION_SYSTEM_PROMPT = `You are a team work memory conflict detector. Batch compare multiple [New Memories] against existing memories in the [Unified Candidate Pool], and decide how to handle each one individually.

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
- merged_timestamps: Array of timestamps after merge. Collect timestamps of the new memory + all merged old memories, deduplicate and sort.`;"""

if old_conflict in c:
    c = c.replace(old_conflict, new_conflict)
    print("Replaced conflict block")
if old_work_conflict in c:
    c = c.replace(old_work_conflict, new_work_conflict)
    print("Replaced work conflict block")

with open(p, 'w', encoding='utf-8') as f:
    f.write(c)

print('Done script 4')
