import requests, json, time
t0 = time.time()
r = requests.post('http://127.0.0.1:3000/v1/chat/completions',
    headers={'Content-Type':'application/json','Authorization':'Bearer sk-oom-5466e04ef817b9f7d4760fc96ad9df8c3a1bdd0573c29219e5d0db5205b1204c'},
    json={'model':'Qwen3.5-9B','messages':[{'role':'user','content':'1+1等于几？只回答数字'}],'max_tokens':20,'stream':False},
    timeout=120)
t1 = time.time()
print(f'Status: {r.status_code} Time: {t1-t0:.1f}s')
data = r.json()
if 'choices' in data:
    print(f'Content: {data["choices"][0]["message"]["content"]}')
    print(f'Usage: {data.get("usage","N/A")}')
else:
    print(json.dumps(data, ensure_ascii=False, indent=2)[:500])
