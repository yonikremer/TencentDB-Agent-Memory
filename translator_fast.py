import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from deep_translator import GoogleTranslator

def get_translator():
    return GoogleTranslator(source='zh-CN', target='en')

def translate_text(text):
    try:
        parts = re.split(r'([\u4e00-\u9fff\u3000-\u303F\uFF00-\uFFEF]+)', text)
        for i in range(1, len(parts), 2):
            if not parts[i].strip():
                continue
            try:
                parts[i] = get_translator().translate(parts[i])
            except Exception as e:
                pass
        return "".join(parts)
    except Exception as e:
        return text

def process_file(filepath):
    if not os.path.exists(filepath): return
    print(f"Reading {filepath}...", flush=True)
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
        
    if not re.search(r'[\u4e00-\u9fff]', content):
        return
        
    lines = content.split('\n')
    changed = False
    
    print(f"Translating {filepath}...", flush=True)
    for i, line in enumerate(lines):
        if re.search(r'[\u4e00-\u9fff]', line):
            lines[i] = translate_text(line)
            changed = True
            
    if changed:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        print(f"Saved {filepath}", flush=True)

def main():
    files = [
        'MemoryKnowledge/.env.example', 'MemoryKnowledge/.npmrc', 'MemoryKnowledge/Dockerfile',
        'MemoryKnowledge/README.md', 'MemoryKnowledge/docker-compose.yml', 'MemoryKnowledge/docker/entrypoint.sh',
        'MemoryKnowledge/docker/env.example', 'MemoryKnowledge/openapi.yaml', 'MemoryKnowledge/pnpm-workspace.yaml',
        'MemoryKnowledge/src/api-helpers.ts', 'MemoryKnowledge/src/callback.ts', 'MemoryKnowledge/src/config.ts',
        'MemoryKnowledge/src/db/schema.ts', 'MemoryKnowledge/src/engines/code/bridge.ts',
        'MemoryKnowledge/src/engines/code/normalize.ts', 'MemoryKnowledge/src/engines/wiki/index-db.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/cascade.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/chunker.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/extract-source-retrieval.test.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/file-protocol.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/index-builder.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/index.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/llm.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/log-writer.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/merge.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/overview.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/prompts.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/retrieval.test.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/retrieval.ts', 'MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts',
        'MemoryKnowledge/src/engines/wiki/ingest-v2/template.ts', 'MemoryKnowledge/src/engines/wiki/manager.ts',
        'MemoryKnowledge/src/engines/wiki/tokenize.ts', 'MemoryKnowledge/src/engines/wiki/types.ts',
        'MemoryKnowledge/src/middleware/response-envelope.ts', 'MemoryKnowledge/src/module.ts',
        'MemoryKnowledge/src/routes/auto-sync.ts', 'MemoryKnowledge/src/routes/code-graph.ts',
        'MemoryKnowledge/src/routes/llm-binding.ts', 'MemoryKnowledge/src/routes/tools.ts',
        'MemoryKnowledge/src/routes/wiki.ts', 'MemoryKnowledge/src/server.ts',
        'MemoryKnowledge/src/source-fetcher/git-fetcher.ts', 'MemoryKnowledge/src/source-fetcher/index.ts',
        'MemoryKnowledge/src/source-fetcher/registry.ts', 'MemoryKnowledge/src/source-fetcher/types.ts',
        'MemoryKnowledge/src/store/auto-sync-scheduler.ts', 'MemoryKnowledge/src/store/code-graph-service.ts',
        'MemoryKnowledge/src/store/llm-binding-store.ts', 'MemoryKnowledge/src/store/types.ts',
        'MemoryKnowledge/src/store/wiki-service.ts', 'MemoryKnowledge/src/telemetry.ts',
        'MemoryKnowledge/v3-api-memoryknowledge-doc.md'
    ]
    with ThreadPoolExecutor(max_workers=5) as executor:
        executor.map(process_file, files)
    print("Done!", flush=True)

if __name__ == "__main__":
    main()
