import os
import re

def rep(filepath, old, new):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    if old in content:
        content = content.replace(old, new)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print('Replaced in ' + filepath)

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-dedup.ts'
rep(p, '## 统一候选记忆池\n\n（空，没有已有记忆，所有新记忆直接 store）', '## Unified Candidate Pool\n\n(Empty, no existing memories, all new memories store directly)')
rep(p, '## 统一候选记忆池（共 ${poolList.length} 条已有记忆）', '## Unified Candidate Pool (${poolList.length} existing memories)')
rep(p, '[]（无相似候选，直接 store）', '[] (No similar candidates, store directly)')
rep(p, '### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.record_id})\n${memStr}\n\n【关联候选 ID】${relatedNote}', '### New Memory ${idx + 1} (record_id: ${m.newMemory.record_id})\n${memStr}\n\n[Related Candidate IDs] ${relatedNote}')
rep(p, '**输出语言**：`merged_content` 使用与候选池中已有记忆相同的语言。', '**Output Language**: `merged_content` uses the same language as existing memories in the pool.')
rep(p, '## 待判断的新记忆（共 ${matches.length} 条）', '## New Memories to Judge (${matches.length} total)')
rep(p, '请逐条判断并输出决策 JSON 数组。当某条新记忆的候选列表为空时，该条直接输出 action=store。', 'Please judge each one and output the decision JSON array. When a new memory\'s candidate list is empty, output action=store for it.')

p2 = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-extraction.ts'
rep(p2, '请严格按上述 JSON 数组格式输出，不要输出任何额外的 Markdown 代码块修饰符（如 ```json）或解释文本。', 'Please strictly output in the JSON array format above, do not output any extra Markdown code block modifiers (like ```json) or explanatory text.')
rep(p2, 'previousSceneName = "无"', 'previousSceneName = "None"')
rep(p2, ': "无";', ': "None";')
rep(p2, '**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写 `scene_name` 和 memory `content`。', '**Output Language**: write `scene_name` and memory `content` based on the dominant language of the user\'s utterances in the "New Messages to Extract" below.')
rep(p2, '【上一个情境】：', '[Previous Scene]: ')
rep(p2, '【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：', '[Background Messages] (Only for understanding context/relationships/time, strictly forbidden to extract memories from here):')
rep(p2, '【待提取的新消息】（务必结合 timestamp 推算时间，只从这里提取记忆！）：', '[New Messages to Extract] (Must combine with timestamp to infer time, only extract memories from here!):')

p3 = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\persona\persona-generator.ts'
rep(p3, '"🆕 首次生成"', '"🆕 First Generation"')
rep(p3, '"🔄 迭代更新"', '"🔄 Incremental Update"')
rep(p3, '\n### 触发信息\n', '\n### Trigger Info\n')
rep(p3, '## 📄 当前 Team Operating Doctrine（工程已预加载）', '## 📄 Current Team Operating Doctrine (Preloaded by Engineering)')
rep(p3, '*以下是现有 persona.md 中 Team Operating Doctrine 的完整内容（${existingPersona.length} 字符）。更新后必须压缩在 1200 字以内：*', '*Below is the full content of the Team Operating Doctrine in the existing persona.md (${existingPersona.length} chars). It must be compressed to within 1200 words after updating:*')
rep(p3, '## 📄 当前 Persona（工程已预加载）', '## 📄 Current Persona (Preloaded by Engineering)')
rep(p3, '*以下是现有 persona.md 的完整内容（${existingPersona.length} 字符），基于此更新后请控制在2000字内：*', '*Below is the full content of the existing persona.md (${existingPersona.length} chars), please keep it within 2000 words after updating based on this:*')
rep(p3, '## 🔄 迭代决策指南', '## 🔄 Iteration Decision Guide')
rep(p3, '面对变化场景，自主判断处理方式：强化（佐证已有原则）/ 补充（新的通用 SOP、禁忌、判断逻辑或 Agent 规则）/ 修正（旧原则被更新）/ 重构（内容变长、变散、变项目化）/ 不改（只有项目状态或低层事实）。', 'Face the changed scenes and autonomously judge the processing method: Reinforce (corroborate existing principles) / Supplement (new general SOP, taboo, decision logic, or Agent rules) / Correct (old principles are updated) / Refactor (content becomes long, scattered, or projectized) / No change (only project status or low-level facts).')
rep(p3, '面对变化场景，自主判断处理方式：强化（佐证已有洞察）/ 补充（新维度）/ 修正（矛盾）/ 重构（结构调整）/ 不改（无有用新增内容）。', 'Face the changed scenes and autonomously judge the processing method: Reinforce (corroborate existing insights) / Supplement (new dimensions) / Correct (contradictions) / Refactor (structural adjustment) / No change (no useful new content).')
rep(p3, '**输出语言**：`${targetFile}` 使用下方变化场景内容的主导语言。', '**Output Language**: `${targetFile}` uses the dominant language of the changed scenes below.')
rep(p3, '**⏰ 更新时间**: ', '**⏰ Update Time**: ')
rep(p3, '**模式**: ', '**Mode**: ')
rep(p3, '## 📊 统计', '## 📊 Statistics')
rep(p3, '- **总记忆数**: ${totalProcessed} 条', '- **Total Memories**: ${totalProcessed}')
rep(p3, '- **场景总数**: ${sceneCount} 个', '- **Total Scenes**: ${sceneCount}')
rep(p3, '- **变化场景**: ${changedSceneCount} 个（自上次更新后）', '- **Changed Scenes**: ${changedSceneCount} (since last update)')

