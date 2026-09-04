import urllib.request
import json
import urllib.parse

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
        return [t.strip() for t in res.split('_|||_')]
    except Exception as e:
        print('Error:', e)
        return []

texts = [
    'const agentName = initResult.agentDetail?.name ?? \"未知\";',
    '  // 对齐 codexHandler triggerCodexArchiveHooks: langfuse 上报后触发归档。'
]
res = translate_batch(texts)
print(res)
