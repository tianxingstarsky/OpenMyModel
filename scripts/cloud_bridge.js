// OpenMyModel Cloud Bridge - Node.js WebSocket tunnel
// Flutter communicates via stdin/stdout JSON lines

const WebSocket = require("ws");
const http = require("http");

let ws = null;
let connected = false;
let nodeId = "";
let llamaUrl = "http://127.0.0.1:8080";
let modelName = "";
let localKeys = [];
let pingTimer = null;

function send(data) {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function connectToCloud(url, password, nodeName) {
  if (ws) { try { ws.close(); } catch (_) {} }
  try {
    ws = new WebSocket("ws://" + url + "/ws/node");
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "auth", password, nodeId, nodeName,
        modelName
      }));
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "auth_ok":
            nodeId = msg.nodeId || "";
            connected = true;
            send({ type: "connected", nodeId, message: msg.message });
            startPing();
            break;
          case "auth_error":
            connected = false;
            send({ type: "error", message: msg.message || "认证失败" });
            ws.close();
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "validate_key":
            process.stderr.write("[bridge] GOT validate_key: " + (msg.key||"").substring(0,15) + "\n");
            validateKey(msg.requestId, msg.key);
            break;
          case "http_relay":
            relayHttp(msg.requestId, msg.path, msg.body);
            break;
          default:
            break;
        }
      } catch (e) {
        send({ type: "error", message: "parse error: " + e.message });
      }
    });
    ws.on("close", () => {
      stopPing();
      connected = false;
      send({ type: "disconnected" });
    });
    ws.on("error", (err) => {
      stopPing();
      connected = false;
      send({ type: "error", message: err.message });
    });
  } catch (e) {
    send({ type: "error", message: e.message });
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }, 25000);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function validateKey(requestId, key) {
    process.stderr.write("[bridge] validateKey: key=" + key.substring(0,20) + "... localKeys count=" + localKeys.length);
    localKeys.forEach((k,i) => process.stderr.write("[bridge]   key["+i+"]: " + (k.key||"").substring(0,20) + " active=" + k.isActive + " match=" + (k.key === key)));
  const valid = localKeys.some(k => k.key === key && k.isActive === true);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "key_valid", requestId, valid }));
  }
}

function relayHttp(requestId, path, body) {
  if (!body) body = "{}";
  const options = {
    method: "POST",
    hostname: "127.0.0.1",
    port: new URL(llamaUrl).port || 8080,
    path: path || "/v1/chat/completions",
    headers: { "Content-Type": "application/json" }
  };
  try {
    const isStream = body.includes('"stream":true');
    const req = http.request(options, (res) => {
      if (isStream) {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.trim() && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "http_chunk", requestId, data: line + "\n" }));
            }
          }
        });
        res.on("end", () => {
          if (buffer.trim() && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "http_chunk", requestId, data: buffer }));
          }
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "http_done", requestId }));
          }
        });
      } else {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "http_chunk", requestId, data }));
            ws.send(JSON.stringify({ type: "http_done", requestId }));
          }
        });
      }
    });
    req.on("error", (e) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "http_chunk", requestId, data: JSON.stringify({ error: { message: e.message, type: "proxy_error" } }) }));
        ws.send(JSON.stringify({ type: "http_done", requestId }));
      }
    });
    req.write(body);
    req.end();
  } catch (e) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "http_chunk", requestId, data: JSON.stringify({ error: { message: e.message, type: "proxy_error" } }) }));
      ws.send(JSON.stringify({ type: "http_done", requestId }));
    }
  }
}

function sendStatusUpdate(name) {
  modelName = name;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "status_update", modelName: name }));
  }
}

function disconnect() {
  stopPing();
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  connected = false;
}

// ---- stdin command handler ----
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const cmd = JSON.parse(line);
    switch (cmd.cmd) {
      case "connect":
        llamaUrl = cmd.llamaUrl || "http://127.0.0.1:8080";
        modelName = cmd.modelName || "";
        connectToCloud(cmd.url, cmd.password, cmd.nodeName || "OpenMyModel-Node");
        break;
      case "disconnect":
        disconnect();
        break;
      case "set_keys":
        localKeys = cmd.keys || [];
        process.stderr.write("[bridge] set_keys received: " + localKeys.length + " keys, sample: " + (localKeys.length>0 ? (localKeys[0].key||"").substring(0,15) : "none"));
        break;
      case "set_llama_url":
        llamaUrl = cmd.llamaUrl || "http://127.0.0.1:8080";
        break;
      case "status_update":
        sendStatusUpdate(cmd.modelName || "");
        break;
      case "status":
        send({ type: "status", connected, nodeId, llamaUrl, modelName });
        break;
      case "exit":
        disconnect();
        process.exit(0);
        break;
      default:
        send({ type: "error", message: "unknown command: " + cmd.cmd });
    }
  } catch (e) {
    send({ type: "error", message: "invalid command: " + e.message });
  }
});

rl.on("close", () => { disconnect(); process.exit(0); });
