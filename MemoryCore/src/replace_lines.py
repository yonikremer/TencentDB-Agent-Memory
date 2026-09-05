import os

def replace_lines(p, replacements):
    if not os.path.exists(p): return
    with open(p, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    for idx, new_line in replacements.items():
        if idx - 1 < len(lines):
            indent = lines[idx-1][:len(lines[idx-1]) - len(lines[idx-1].lstrip())]
            lines[idx-1] = indent + new_line + '\n'
    with open(p, 'w', encoding='utf-8') as f:
        f.writelines(lines)

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\instance-config-provider.ts'
replace_lines(p, {
    246: '// Cache valid -> return directly',
    251: '// Prevent concurrent requests from refreshing at the same time',
    264: '* Clear VDB cache for specified instance (called when instance goes offline)',
    272: '* Force refresh COS credentials',
    279: '* Clear all caches'
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-dedup.ts'
replace_lines(p, {
    225: 'return `**Output Language**: \`merged_content\` uses the same language as existing memories in the candidate pool.'
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-extraction.ts'
replace_lines(p, {
    406: 'return `**Output Language**: Based on the dominant language of the user in the "New Messages to Extract" below, write \`scene_name\` and memory \`content\`.`'
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\persona\persona-generator.ts'
replace_lines(p, {
    157: '2. **Can only operate `persona.md` this one file**, reading or writing any other files is forbidden.',
    158: '3. **No read tool needed**: The `persona.md` full content is provided in user message.',
    218: 'Please refer to the following format, use **write** or **edit** tool to write the final content. Chapters can be trimmed, but Markdown format must be kept, entire text under 1200 words.',
    222: '> **Operating Thesis**: [A one-sentence summary of the team core, most general work method or Agent execution Principle.]',
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\persona-generation.ts'
replace_lines(p, {
    242: '- Do not [Error practice]; instead use [Recommended practice], because [Reason].',
    251: '> **Last Updated**: [Current Time] · **Source Scenes**: [Scene Count]  · **Total Memories**: [Total Memory Count]',
    257: '- ✅ Must use write or edit to write `persona.md`',
    258: '- ✅ Final content does not exceed 1200 words',
    259: '- ✅ Only retain Principles, SOPs, taboos, decision logics and Agent rules reusable in all work contexts'
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\record\skill-extractor.ts'
replace_lines(p, {
    451: '"- Prefer nouns / product names / verbs; drop filler words (the, a).",'
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\storage\buffer-storage.ts'
replace_lines(p, {
    99: '/** _tasks.json overall structure. */',
    119: '/** `_tasks_dlq.json` overall structure. */'
})
print('Done line replacements')
