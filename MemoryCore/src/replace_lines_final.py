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
    289: '* Number of currently cached instances',
    296: '* Whether current COS credentials are valid',
    315: '// If old cache still exists, extend a short time and continue using (degrade)',
    317: 'this.cosExpiresAt = now + 30_000; // retry after 30s',
    326: '* Calculate COS cache expiration time:',
    327: '*   - With expirationTime: min(server expiration time - buffer, vdbTtl)'
})

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\persona\persona-generation.ts'
replace_lines(p, {
    260: '- ✅ Each content is semantically complete out of specific project',
    262: '- ✅ Do not write project progress, task chronological accounts, version fragments or Scene indices',
    263: '- ✅ Do not add Scene navigation (Engineering automatically appends Scene Navigation and Scene indices)',
    285: 'const modeLabel = mode === "first" ? "🆕 First generation" : "🔄 Incremental update";',
    288: '? `\\n### Trigger info\\n${triggerInfo}\\n`',
    293: '? `\\n## 📄 Current Team Operating Doctrine (Preloaded by engineering)\\n\\n` +',
    294: '`*Below is the full content of Team Operating Doctrine in existing persona.md (${existingPersona.length} chars). Must compress within 1200 words after update:*\\n\\n` +',
    296: ': `\\n## 📄 Current Persona (Preloaded by engineering)\\n\\n` +',
    297: '`*Below is full content of existing persona.md (${existingPersona.length} chars), please keep within 2000 words after update based on this:*\\n\\n` +',
    303: '? `\\n## 🔄 Iteration Decision Guide\\n\\n` +',
    304: '`Face changed scenes, autonomously judge action: Reinforce (corroborates existing principles) / Supplement (new general SOP, taboo, decision logic or Agent rule) / Correct (old principle updated) / Refactor (content grows long, scattered, projectized) / No change (only project status or low level facts).\\n`',
    305: ': `\\n## 🔄 Iteration Decision Guide\\n\\n` +',
    306: '`Face changed scenes, autonomously judge action: Reinforce (corroborates existing insights) / Supplement (new dimension) / Correct (contradiction) / Refactor (structural adjustment) / No change (no useful new content).\\n`',
    309: 'const userPrompt = `**Output Language**: \\`${targetFile}\\` uses dominant language of changed scenes below.',
    311: '**⏰ Update Time**: ${currentTime}',
    312: '**Mode**: ${modeLabel}',
    314: '## 📊 Stats',
    316: '- **Total Scenes**: ${sceneCount}',
    317: '- **Changed Scenes**: ${changedSceneCount} (Since last update)'
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
print('Final lines replaced')
