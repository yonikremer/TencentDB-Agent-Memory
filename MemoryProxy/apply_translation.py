import json
import os
import re

with open('MemoryProxy/chinese_lines.json', 'r', encoding='utf-8') as f:
    file_map = json.load(f)

with open('MemoryProxy/translated_lines.json', 'r', encoding='utf-8') as f:
    translated_lines = json.load(f)

# Post-process translated_lines to fix specific terminology
terminologies = {
    'Tencent DB': 'TencentDB',
    'Tencent db': 'TencentDB',
    'Memory Core': 'MemoryCore',
    'Memory core': 'MemoryCore',
    'Memory Proxy': 'MemoryProxy',
    'Memory proxy': 'MemoryProxy',
    'Memory Knowledge': 'MemoryKnowledge',
    'Memory knowledge': 'MemoryKnowledge',
    'Memory Panel': 'MemoryPanel',
    'Memory panel': 'MemoryPanel'
}

for k, v in translated_lines.items():
    for old, new in terminologies.items():
        v = v.replace(old, new)
    translated_lines[k] = v

changed_files = []
for filepath, lines_dict in file_map.items():
    if not os.path.exists(filepath):
        continue
    
    with open(filepath, 'r', encoding='utf-8') as f:
        content_lines = f.readlines()
        
    modified = False
    for line_num_str, original_line in lines_dict.items():
        line_num = int(line_num_str)
        if line_num < len(content_lines) and content_lines[line_num] == original_line:
            if original_line in translated_lines:
                content_lines[line_num] = translated_lines[original_line]
                if not content_lines[line_num].endswith('\n'):
                    content_lines[line_num] += '\n'
                modified = True
    
    if modified:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(content_lines)
        changed_files.append(filepath)

print('Updated files:')
for f in changed_files:
    print(f)
