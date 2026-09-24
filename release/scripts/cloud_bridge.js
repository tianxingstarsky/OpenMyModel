// Flutter communicates with the bridge via stdin/stdout JSON lines.
const WebSocket = require("ws");
const http = require("node:http");
const https = require("node:https");
const { timingSafeEqual } = require("node:crypto");

function cloudUrl(value) {
  const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("请输入不含账号、查询参数的 HTTP(S) 服务器地址");
  }
  url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/(?:ws\/node)?\/?$/, "")}/ws/node`;
  return url;
}

function matchesKey(candidate, key) {
  if (typeof candidate !== "string" || typeof key !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

class CloudBridge {
  constructor(emit = () => {}, { requestTimeout = 120000, maxBufferedBytes = 8 * 1024 * 1024 } = {}) {
    this.emit = emit;
    this.requestTimeout = requestTimeout;
    this.maxBufferedBytes = maxBufferedBytes;
    this.ws = null;
    this.connected = false;
    this.nodeId = "";
    this.modelName = "";
    this.serverRunning = true;
    this.slots = null;
    this.llamaUrl = new URL("http://127.0.0.1:8080");
    this.llamaApiKey = "";
    this.localKeys = [];
    this.activeRequests = new Map();
  }

  send(socket, data) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(data), (error) => {
      if (error) socket.terminate();
    });
    return true;
  }

  setLlama(url, apiKey = "") {
    const parsed = new URL(url || "http://127.0.0.1:8080");
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("无效的 llama-server HTTP(S) 地址");
    }
    this.llamaUrl = parsed;
    this.llamaApiKey = typeof apiKey === "string" ? apiKey : "";
  }

  connect(command) {
    const address = cloudUrl(command.url);
    this.setLlama(command.llamaUrl, command.llamaApiKey);
    this.disconnect();
    this.modelName = command.modelName || "";
    this.serverRunning = command.serverRunning !== false;
    this.slots = Number.isInteger(command.slots) && command.slots >= 0 && command.slots <= 1024 ? command.slots : null;
    this.nodeId = command.nodeId || this.nodeId;
    const socket = new WebSocket(address, { handshakeTimeout: 10000, maxPayload: 70 * 1024 * 1024 });
    this.ws = socket;
    socket.on("open", () => {
      if (this.ws !== socket) return socket.close();
      this.send(socket, {
        type: "auth", password: command.password, nodeId: this.nodeId,
        nodeName: command.nodeName || "OpenMyModel-Node", modelName: this.modelName,
        serverRunning: this.serverRunning, protocolVersion: 2,
        ...(this.slots !== null ? { slots: this.slots } : {}),
      });
    });
    socket.on("message", (raw) => {
      if (this.ws !== socket) return;
      try {
        const message = JSON.parse(raw.toString());
        switch (message.type) {
          case "auth_ok":
            this.nodeId = message.nodeId || "";
            this.connected = true;
            this.emit({ type: "connected", nodeId: this.nodeId, message: message.message });
            break;
          case "auth_error":
            this.connected = false;
            this.emit({ type: "error", message: message.message || "认证失败" });
            socket.close();
            break;
          case "ping":
            this.send(socket, { type: "pong" });
            break;
          case "validate_key":
            this.send(socket, {
              type: "key_valid", requestId: message.requestId,
              valid: this.localKeys.some((key) => key.isActive === true && matchesKey(key.key, message.key)),
            });
            break;
          case "http_relay":
            if (!this.connected) break;
            this.relay(socket, message);
            break;
          case "cancel_request":
            this.cancel(message.requestId);
            break;
        }
      } catch (error) {
        this.emit({ type: "error", message: `桥接协议错误: ${error.message}` });
      }
    });
    socket.on("close", () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.connected = false;
      this.cancelAll();
      this.emit({ type: "disconnected" });
    });
    socket.on("error", (error) => {
      if (this.ws !== socket) return;
      this.connected = false;
      this.cancelAll();
      this.emit({ type: "error", message: error.message });
    });
  }

  relay(socket, message) {
    const { requestId } = message;
    if (typeof requestId !== "string" || !requestId || this.activeRequests.has(requestId)) return;
    if (!this.serverRunning) {
      this.send(socket, { type: "http_error", requestId, statusCode: 503, message: "llama-server 未就绪" });
      return;
    }
    let request;
    const entry = { request: null, response: null, done: false };
    const finish = (error, statusCode = 502) => {
      if (entry.done) return;
      entry.done = true;
      this.activeRequests.delete(requestId);
      if (error) {
        entry.response?.destroy();
        request?.destroy();
        this.send(socket, { type: "http_error", requestId, statusCode, message: error.message });
      } else {
        this.send(socket, { type: "http_done", requestId });
      }
    };
    try {
      const path = typeof message.path === "string" ? message.path : "/v1/chat/completions";
      // A tunnel request may choose an API path, never another origin.
      if (!path.startsWith("/v1/") || path.includes("\\") || /[\r\n]/.test(path) ||
          (message.method && message.method !== "POST")) {
        throw new Error("不支持的中继请求路径或方法");
      }
      const target = new URL(this.llamaUrl);
      const basePath = target.pathname.replace(/\/$/, "").replace(/\/v1$/, "");
      const split = path.indexOf("?");
      target.pathname = basePath + (split < 0 ? path : path.slice(0, split));
      target.search = split < 0 ? "" : path.slice(split);
      const body = typeof message.body === "string" ? message.body : "{}";
      const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Accept-Encoding": "identity" };
      if (message.upstreamApiKey !== undefined) {
        if (typeof message.upstreamApiKey !== "string" || message.upstreamApiKey.length > 4096 || /[\r\n]/.test(message.upstreamApiKey)) {
          throw new Error("无效的上游 API Key");
        }
        if (message.upstreamApiKey) headers.Authorization = `Bearer ${message.upstreamApiKey}`;
      } else if (this.llamaApiKey) headers.Authorization = `Bearer ${this.llamaApiKey}`;
      request = (target.protocol === "https:" ? https : http).request(target, { method: "POST", headers }, (response) => {
        entry.response = response;
        if (entry.done) return response.destroy();
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
          return finish(new Error("llama-server 返回了不支持的压缩响应"));
        }
        const responseHeaders = {};
        const hopHeaders = new Set((response.headers.connection || "").split(",").map((name) => name.trim().toLowerCase()));
        for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
          if (!hopHeaders.has(name) && typeof response.headers[name] === "string") responseHeaders[name] = response.headers[name];
        }
        this.send(socket, { type: "http_headers", requestId, statusCode: response.statusCode || 502, headers: responseHeaders });
        response.setEncoding("utf8");
        response.on("data", (data) => {
          if (entry.done) return;
          // Bound queued WebSocket memory if the cloud cannot keep up.
          if (socket.bufferedAmount > this.maxBufferedBytes) {
            finish(new Error("云端连接接收过慢，中继已停止"));
          } else if (!this.send(socket, { type: "http_chunk", requestId, data })) {
            this.cancel(requestId);
          }
        });
        response.on("end", () => finish());
        response.on("aborted", () => finish(new Error("llama-server 响应中断")));
        response.on("error", (error) => finish(error));
      });
      entry.request = request;
      this.activeRequests.set(requestId, entry);
      request.setTimeout(this.requestTimeout, () => finish(new Error("llama-server 响应超时"), 504));
      request.on("error", (error) => finish(error));
      request.end(body);
    } catch (error) {
      finish(error);
    }
  }

  cancel(requestId) {
    const entry = this.activeRequests.get(requestId);
    if (!entry) return;
    entry.done = true;
    this.activeRequests.delete(requestId);
    entry.response?.destroy();
    entry.request?.destroy();
  }

  cancelAll() {
    for (const requestId of this.activeRequests.keys()) this.cancel(requestId);
  }

  disconnect() {
    const socket = this.ws;
    this.ws = null;
    this.connected = false;
    this.cancelAll();
    if (socket) socket.terminate();
  }

  command(command) {
    switch (command.cmd) {
      case "connect": this.connect(command); break;
      case "disconnect": this.disconnect(); this.emit({ type: "disconnected" }); break;
      case "set_keys":
        this.localKeys = Array.isArray(command.keys) ? command.keys.filter((key) => key && typeof key.key === "string") : [];
        break;
      case "set_llama_url": this.setLlama(command.llamaUrl, command.llamaApiKey); break;
      case "status_update":
        this.modelName = command.modelName || "";
        if (typeof command.serverRunning === "boolean") this.serverRunning = command.serverRunning;
        if (command.slots !== undefined) {
          this.slots = Number.isInteger(command.slots) && command.slots >= 0 && command.slots <= 1024 ? command.slots : null;
        }
        if (this.ws) this.send(this.ws, {
          type: "status_update", modelName: this.modelName, serverRunning: this.serverRunning,
          ...(this.slots !== null ? { slots: this.slots } : {}),
        });
        break;
      case "status":
        this.emit({ type: "status", connected: this.connected, nodeId: this.nodeId, modelName: this.modelName, activeRequests: this.activeRequests.size });
        break;
      default: throw new Error(`未知命令: ${command.cmd}`);
    }
  }
}

if (require.main === module) {
  const bridge = new CloudBridge((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
  const input = require("node:readline").createInterface({ input: process.stdin });
  const close = () => { bridge.disconnect(); process.exit(0); };
  input.on("line", (line) => {
    try {
      const command = JSON.parse(line);
      if (command.cmd === "exit") return close();
      bridge.command(command);
    } catch (error) {
      bridge.emit({ type: "error", message: error.message });
    }
  });
  input.on("close", close);
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}

module.exports = { CloudBridge, cloudUrl };
