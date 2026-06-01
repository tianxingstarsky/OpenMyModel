const WebSocket = require("ws");
const CLOUD = process.argv[2] || "ws://127.0.0.1:3000/ws/node";
const PASS  = process.argv[3] || "xiao20061209";
const LLAMA = "http://127.0.0.1:8080";
const ws = new WebSocket(CLOUD);

ws.on("open", () => {
  console.log("[NODE] connected");
  ws.send(JSON.stringify({type:"auth",password:PASS,nodeId:"t1",nodeName:"test",modelName:"Qwen3.5-9B"}));
});

// ReadableStream -> async line iterator
async function* streamLines(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) yield line;
  }
  if (buf) yield buf;
}

ws.on("message", async raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === "auth_ok") { console.log("[NODE] authed"); return; }
  if (msg.type === "ping") { ws.send(JSON.stringify({type:"pong"})); return; }

  // 原始 HTTP 镜像转发
  if (msg.type === "http_relay") {
    const rid = msg.requestId;
    const isStream = msg.body?.includes('"stream":true');
    console.log("[NODE] http_relay", rid, "stream=" + isStream);

    try {
      const resp = await fetch(LLAMA + msg.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: msg.body,
      });

      if (isStream) {
        // 流式: 逐行转发原始 SSE 数据
        for await (const line of streamLines(resp)) {
          ws.send(JSON.stringify({ type: "http_chunk", requestId: rid, data: line + "\n" }));
        }
        ws.send(JSON.stringify({ type: "http_done", requestId: rid }));
        console.log("[NODE] stream relayed");
      } else {
        const text = await resp.text();
        ws.send(JSON.stringify({ type: "http_done", requestId: rid, data: text }));
        console.log("[NODE] non-stream relayed");
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "http_done", requestId: rid, data: JSON.stringify({error:e.message}) }));
      console.log("[NODE] err:", e.message);
    }
  }
});

ws.on("close", () => console.log("[NODE] dc"));
ws.on("error", e => console.log("[NODE] err:", e.message));
