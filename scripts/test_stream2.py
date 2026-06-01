import requests, json, time

r = requests.post('http://127.0.0.1:3000/v1/chat/completions',
    headers={'Content-Type':'application/json','Authorization':'Bearer sk-oom-5466e04ef817b9f7d4760fc96ad9df8c3a1bdd0573c29219e5d0db5205b1204c'},
    json={'model':'Qwen3.5-9B','messages':[{'role':'user','content':'1+1等于几？只回答数字'}],'max_tokens':100,'stream':True},
    timeout=120, stream=True)

raw = r.raw
chunk_count = 0
while True:
    line = raw.readline()
    if not line: break
    line = line.decode('utf-8','ignore').strip()
    if line.startswith('data: '):
        d = line[6:]
        if d == '[DONE]': break
        try:
            chunk = json.loads(d)
            choices = chunk.get('choices',[])
            if choices:
                delta = choices[0].get('delta',{})
                content = delta.get('content','')
                if content:
                    print(content, end='', flush=True)
                    chunk_count += 1
        except: pass
print(f'\nChunks with content: {chunk_count}')
