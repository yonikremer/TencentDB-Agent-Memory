import os

replacements = {
    r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-extraction.ts': {
        r'和 memory `content`。': r'and memory `content`.'
    },
    r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\instance-config-provider.ts': {
        '// ── VDB: per-instance 缓存 ──': '// ── VDB: per-instance cache ──',
        '* 并发首次访问同一 instanceId 时，复用同一个 fetch Promise，': '* When accessing the same instanceId concurrently for the first time, reuse the same fetch Promise,',
        '* 避免向 source 同时发出 N 次请求触发限流。': '* to avoid triggering rate limits by sending N requests to source simultaneously.',
        '// ── COS: 全局单例缓存 (一份凭证，按 PathPrefix 隔离) ──': '// ── COS: global singleton cache (one credential, isolated by PathPrefix) ──',
        '* 获取指定实例的完整配置 (VDB per-instance + COS 全局)': '* Get full config for specified instance (VDB per-instance + COS global)',
        '* 获取指定实例的 VDB 配置 (带缓存)': '* Get VDB config for specified instance (with cache)',
        '* 策略：': '* Strategy:',
        '* 1. 缓存命中且未过期 → 直接返回（并刷新 LRU 位置）': '* 1. Cache hit and not expired -> return directly (and refresh LRU position)',
        '* 2. 缓存为空或已过期 → 从 source 获取（并发请求同一 instanceId 时 in-flight 去重）': '* 2. Cache empty or expired -> fetch from source (in-flight deduplication for concurrent requests to same instanceId)',
        '* 3. source 返回空/错误 → 直接报错并记录日志（不缓存空值）': '* 3. Source returns empty/error -> error directly and log (do not cache empty values)'
    },
    r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\tdai-core.ts': {
        '`${TAG} Skill singleton extractor not constructed — service mode 会走 per-instance factory；` +': '`${TAG} Skill singleton extractor not constructed — service mode will use per-instance factory;` +',
        '`standalone/openclaw 模式下 /skill/extract 会因缺 extractor 无法抽取, 请检查 cfg.llm。`': '`in standalone/openclaw mode /skill/extract will fail to extract due to missing extractor, please check cfg.llm.`'
    },
    r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\persona\persona-generator.ts': {
        '`*自上次 Persona 更新后，以下 ${changedSceneContents.length} 个场景发生了变化。工程已为你预加载完整内容：*\\n\\n` +': '`*Since the last Persona update, the following ${changedSceneContents.length} scenes have changed. The project has preloaded the full content for you:*\\n\\n` +',
        '// 静默忽略': '// Silently ignore'
    },
    r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-dedup.ts': {
        'poolSection = "## 统一候选记忆池\\n\\n（空，没有已有记忆，所有新记忆直接 store）";': 'poolSection = "## Unified Candidate Pool\\n\\n(Empty, no existing memories, all new memories store directly)";',
        'return `### 第 ${idx + 1} 条新记忆 (record_id: ${m.newMemory.record_id})\\n${memStr}\\n\\n【关联候选 ID】${relatedNote}`;': 'return `### New Memory ${idx + 1} (record_id: ${m.newMemory.record_id})\\n${memStr}\\n\\n[Related Candidate IDs] ${relatedNote}`;',
        'return `**输出语言**：\\`merged_content\\` 使用与候选池中已有记忆相同的语言。': 'return `**Output Language**: \\`merged_content\\` uses the same language as existing memories in the candidate pool.'
    }
}

for path, rep in replacements.items():
    if not os.path.exists(path):
        continue
    with open(path, 'r', encoding='utf-8') as f:
        c = f.read()
    for k, v in rep.items():
        # Handle backslash escapes correctly
        k = k.replace('\\n', '\n').replace('\\`', '`')
        v = v.replace('\\n', '\n').replace('\\`', '`')
        c = c.replace(k, v)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(c)

print('Stragglers translated!')
