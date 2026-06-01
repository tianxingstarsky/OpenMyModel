import requests, json
r = requests.post('http://127.0.0.1:3000/v1/chat/completions',
    headers={'Content-Type':'application/json','Authorization':'Bearer sk-oom-5466e04ef817b9f7d4760fc96ad9df8c3a1bdd0573c29219e5d0db5205b1204c'},
    json={'model':'Qwen3.5-9B','messages':[{'role':'user','content':'请用一句话介绍北京'}],'max_tokens':200,'stream':True},
    timeout=120, stream=True)

for line in r.iter_lines(decode_unicode=True):
    if line and line.startswith('data: '):
        d = line[6:]
        if d == '[DONE]': break
        try:
            chunk = json.loads(d)
            choices = chunk.get('choices',[])
            if choices:
                delta = choices[0].get('delta',{})
                content = delta.get('content','')
                if content: print(content, end='', flush=True)
        except: pass
print('\nDone')
