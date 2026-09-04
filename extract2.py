import glob, re, os

files = [
    'MemoryCore/src/metadata/router/auth.ts',
    'MemoryCore/src/metadata/router/entity-ref-validator.ts',
    'MemoryCore/src/metadata/router/instance.ts',
    'MemoryCore/src/metadata/router/internal-meta-router.ts',
    'MemoryCore/src/metadata/router/meta-api-trace.ts',
    'MemoryCore/src/metadata/router/pagination.ts',
    'MemoryCore/src/metadata/router/v3-meta-router.ts',
    'MemoryCore/src/metadata/router/v3-meta-schemas.ts',
    'MemoryCore/src/metadata/service/config-param-service.ts'
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
