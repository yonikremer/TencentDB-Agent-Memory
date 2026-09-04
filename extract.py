import glob, re, os

files = [
    'MemoryCore/src/metadata/service/metadata-service.ts',
    'MemoryCore/src/metadata/service/permission-checker.ts',
    'MemoryCore/src/metadata/service/resolve-user-id.ts',
    'MemoryCore/src/metadata/service/user-visibility.ts',
    'MemoryCore/src/metadata/store/mongodb-adapter.ts',
    'MemoryCore/src/metadata/utils/chat-memory-asset.ts',
    'MemoryCore/src/metadata/utils/crypto.ts',
    'MemoryCore/src/metadata/utils/external-asset-id.ts',
    'MemoryCore/src/metadata/utils/id-generator.ts',
    'MemoryCore/src/metadata/utils/user-key.ts'
]

out = ''
for f in files:
    try:
        with open(f, 'r', encoding='utf-8') as fh:
            lines = fh.readlines()
        ch = []
        for i, line in enumerate(lines):
            if re.search(r'[\u4e00-\u9fff]', line):
                ch.append(f'{f}:{i+1}:{line.rstrip()}')
        if ch:
            out += '\n'.join(ch) + '\n'
    except Exception as e:
        pass

with open('chinese_all.txt', 'w', encoding='utf-8') as fh:
    fh.write(out)
