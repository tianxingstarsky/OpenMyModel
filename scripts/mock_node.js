// 精简透传节点：连云端 WS，转发请求到本地 llama-server
const WebSocket = require('ws');

const CLOUD = process.argv[2] || 'ws://127.0.0.1:3000/ws/node';
const PASS  = process.argv[3] || 'xiao20061209';
const LLAMA = 'http://127.0.0.1:8080';

const ws = new WebSocket(CLOUD);

ws.on('open', () => {
  console.log('[NODE] connected');
  ws.send(JSON.stringify({ type:'auth', password:PASS, nodeId:'test-node-1', nodeName:'test-Windows', modelName:'Qwen3.5-9B' }));
});

ws.on('message', async raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'auth_ok') { console.log('[NODE] authed:', msg.message); return; }
  if (msg.type === 'ping') { ws.send(JSON.stringify({ type:'pong' })); return; }

  if (msg.type === 'chat_request') {
    const { stream } = msg.data;
    try {
      const resp = await fetch(LLAMA + '/chat/completions', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...msg.data, stream: !!stream }),
      });

      if (stream) {
        const text = await resp.text();
        const chunks = [];
        for (const line of text.split('\n')) {
          if (line.startsWith('data:') && !line.includes('[DONE]')) {
            try { const c = JSON.parse(line.slice(5).trim()); if (c) chunks.push(c); } catch (_) {}
          }
        }
        ws.send(JSON.stringify({ type:'chat_response', requestId:msg.requestId, data:{ chunks } }));
      } else {
        ws.send(JSON.stringify({ type:'chat_response', requestId:msg.requestId, data: await resp.json() }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type:'chat_error', requestId:msg.requestId, error:e.message }));
    }
  }
});

ws.on('close', () => console.log('[NODE] disconnected'));
ws.on('error', e => console.log('[NODE] error:', e.message));
