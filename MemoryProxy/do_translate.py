import urllib.request
import json
import urllib.parse
import time
import re
import os

def translate_batch(texts, source_lang='zh-CN', target_lang='en'):
    text = ' _|||_ '.join(texts)
    try:
        url = f'https://translate.googleapis.com/translate_a/single?client=gtx&sl={source_lang}&tl={target_lang}&dt=t&q={urllib.parse.quote(text)}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        response = urllib.request.urlopen(req)
        data = json.loads(response.read().decode('utf-8'))
        
        res = ''
        for sentence in data[0]:
            if sentence[0]:
                res += sentence[0]
        
        # Split by the separator, and clean up extra spaces that google translate might add around it
        parts = re.split(r'\s*_\s*\|\|\|\s*_\s*', res)
        # if length mismatch, it's problematic, we will return empty and retry one by one
        if len(parts) != len(texts):
            return None
        return [t.strip() for t in parts]
    except Exception as e:
        print('Error:', e)
        return None

def translate_single(text, source_lang='zh-CN', target_lang='en'):
    try:
        url = f'https://translate.googleapis.com/translate_a/single?client=gtx&sl={source_lang}&tl={target_lang}&dt=t&q={urllib.parse.quote(text)}'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        response = urllib.request.urlopen(req)
        data = json.loads(response.read().decode('utf-8'))
        res = ''.join([sentence[0] for sentence in data[0] if sentence[0]])
        return res.strip()
    except Exception as e:
        return text.strip()

with open('MemoryProxy/chinese_lines.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# unique lines
unique_lines = {}
for filepath, lines in data.items():
    if isinstance(lines, dict):
        for line_num, line in lines.items():
            if line not in unique_lines:
                unique_lines[line] = None
    elif isinstance(lines, list):
        for line in lines:
            if line not in unique_lines:
                unique_lines[line] = None

lines_to_translate = list(unique_lines.keys())
print(f'Total unique lines to translate: {len(lines_to_translate)}')

translated_dict = {}

# Process in batches of 20
batch_size = 20
for i in range(0, len(lines_to_translate), batch_size):
    batch = lines_to_translate[i:i+batch_size]
    
    # Extract leading whitespace for each line
    stripped_batch = []
    leading_spaces = []
    for line in batch:
        match = re.match(r'^(\s*)(.*)', line)
        leading_spaces.append(match.group(1))
        stripped_batch.append(match.group(2))
    
    res = translate_batch(stripped_batch)
    if res and len(res) == len(batch):
        for j, text in enumerate(batch):
            translated_dict[text] = leading_spaces[j] + res[j] + '\n'
    else:
        # fallback to single
        for j, text in enumerate(batch):
            res_single = translate_single(stripped_batch[j])
            translated_dict[text] = leading_spaces[j] + res_single + '\n'
            time.sleep(0.1)
    
    print(f'Processed {min(i+batch_size, len(lines_to_translate))} / {len(lines_to_translate)}')
    time.sleep(0.1)

with open('MemoryProxy/translated_lines.json', 'w', encoding='utf-8') as f:
    json.dump(translated_dict, f, ensure_ascii=False, indent=2)

print('Translation mapping saved to MemoryProxy/translated_lines.json')
