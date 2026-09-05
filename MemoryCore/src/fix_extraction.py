import os

p = r'C:\Users\yonik\TencentDB-Agent-Memory\MemoryCore\src\core\prompts\l1-extraction.ts'
with open(p, 'r', encoding='utf-8') as f:
    c = f.read()

prefix = 'export const EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT = `你是专业的'
suffix = 'or explanatory text.`;'

start_idx = c.find(prefix)
end_idx = c.find(suffix, start_idx) if start_idx != -1 else -1

if start_idx != -1 and end_idx != -1:
    with open('work_prompt_replacement.txt', 'r', encoding='utf-8') as f_repl:
        new_work = f_repl.read()
    c = c[:start_idx] + new_work + c[end_idx + len(suffix):]
    c = c.replace('* L1 Extraction Prompt: 情境切分 + 记忆提取', '* L1 Extraction Prompt: Scene Segmentation + Memory Extraction')
    c = c.replace('**输出语言**：根据下方"待提取的新消息"中 user 发言的主导语言书写', '**Output Language**: Based on the dominant language of the user in the "New Messages to Extract" below, write')
    with open(p, 'w', encoding='utf-8') as f:
        f.write(c)
    print('Successfully replaced EXTRACT_WORK_MEMORIES_SYSTEM_PROMPT in l1-extraction.ts')
else:
    print('Failed to find prefix or suffix')
    print('start_idx:', start_idx, 'end_idx:', end_idx)
