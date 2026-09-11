const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const { WebSocketServer } = require("ws");
const { CloudBridge, cloudUrl } = require("../cloud_bridge");

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for test event");
}

async function fixture(t, handler, options) {
  const upstream = http.createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const cloud = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(cloud, "listening");
  const messages = [];
  const events = [];
  const bridge = new CloudBridge((event) => events.push(event), options);
  const connection = once(cloud, "connection");
  bridge.command({ cmd: "set_keys", keys: [{ key: "test-key", isActive: true }] });
  bridge.command({ cmd: "connect", url: `http://127.0.0.1:${cloud.address().port}`, password: "local-test", llamaUrl: `http://localhost:${upstream.address().port}/v1`, llamaApiKey: "upstream-test" });
  const [socket] = await connection;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    messages.push(message);
    if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok", nodeId: "node-test" }));
  });
  await until(() => bridge.connected);
  t.after(async () => {
    bridge.disconnect();
    for (const client of cloud.clients) client.terminate();
    await new Promise((resolve) => cloud.close(resolve));
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const send = (message) => socket.send(JSON.stringify(message));
  return { bridge, messages, events, socket, send };
}

test("cloud URL normalizes HTTP(S), WS paths and rejects credentials", () => {
  assert.equal(cloudUrl("example.test:3000").href, "ws://example.test:3000/ws/node");
  assert.equal(cloudUrl("https://example.test/prefix/").href, "wss://example.test/prefix/ws/node");
  assert.equal(cloudUrl("wss://example.test/ws/node").href, "wss://example.test/ws/node");
  for (const value of ["ftp://example.test", "https://a:b@example.test", "https://example.test/?x=1"]) {
    assert.throws(() => cloudUrl(value));
  }
});

test("preserves status, UTF-8 split bytes, SSE blank lines and upstream auth", async (t) => {
  const payload = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\n\n';
  let requestBody = "";
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, "/v1/chat/completions?test=1");
    assert.equal(req.headers.authorization, "Bearer upstream-test");
    req.on("data", (chunk) => { requestBody += chunk; });
    req.on("end", async () => {
      res.writeHead(201, { "Content-Type": "text/event-stream" });
      const bytes = Buffer.from(payload);
      const split = bytes.indexOf(Buffer.from("你")) + 1;
      res.write(bytes.subarray(0, split));
      await delay(5);
      res.end(bytes.subarray(split));
    });
  });
  const body = '{"stream": true,"messages":[]}';
  f.send({ type: "http_relay", requestId: "sse", path: "/v1/chat/completions?test=1", body });
  await until(() => f.messages.some((m) => m.type === "http_done"));
  const messages = f.messages.filter((m) => m.requestId === "sse");
  assert.equal(messages[0].type, "http_headers");
  assert.equal(messages[0].statusCode, 201);
  assert.equal(messages.filter((m) => m.type === "http_chunk").map((m) => m.data).join(""), payload);
  assert.equal(requestBody, body);
  assert.equal(f.bridge.activeRequests.size, 0);
});

test("forwards non-stream upstream error status and body", async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "2", "Connection": "x-request-id", "X-Request-Id": "internal-secret" });
    res.end('{"error":{"message":"busy"}}');
  });
  f.send({ type: "http_relay", requestId: "error", path: "/v1/chat/completions", body: "{}" });
  await until(() => f.messages.some((m) => m.type === "http_done"));
  const headers = f.messages.find((m) => m.type === "http_headers");
  assert.equal(headers.statusCode, 429);
  assert.equal(headers.headers["retry-after"], "2");
  assert.equal(headers.headers["x-request-id"], undefined);
  assert.equal(f.messages.find((m) => m.type === "http_chunk").data, '{"error":{"message":"busy"}}');
  assert.equal(f.bridge.activeRequests.size, 0);
});

test("cancels before headers without error/done or active-request leaks", async (t) => {
  let started = false;
  let closed = false;
  const f = await fixture(t, (req, res) => {
    req.resume();
    started = true;
    res.on("close", () => { closed = true; });
  });
  f.send({ type: "http_relay", requestId: "cancel", path: "/v1/chat/completions", body: "{}" });
  await until(() => started);
  f.send({ type: "cancel_request", requestId: "cancel" });
  await until(() => closed);
  assert.equal(f.bridge.activeRequests.size, 0);
  assert.equal(f.messages.filter((m) => m.requestId === "cancel").length, 0);
});

test("cloud disconnect cancels active upstream requests", async (t) => {
  let started = false;
  let closed = false;
  const f = await fixture(t, (req, res) => {
    req.resume();
    started = true;
    res.on("close", () => { closed = true; });
  });
  f.send({ type: "http_relay", requestId: "disconnect", path: "/v1/chat/completions", body: "{}" });
  await until(() => started);
  f.socket.close();
  await until(() => closed);
  assert.equal(f.bridge.connected, false);
  assert.equal(f.bridge.activeRequests.size, 0);
});

test("idle timeout terminates upstream and reports 504 once", async (t) => {
  let closed = false;
  const f = await fixture(t, (req, res) => {
    req.resume();
    res.on("close", () => { closed = true; });
  }, { requestTimeout: 50 });
  f.send({ type: "http_relay", requestId: "timeout", path: "/v1/chat/completions", body: "{}" });
  await until(() => closed);
  await until(() => f.messages.some((m) => m.type === "http_error"));
  assert.equal(f.messages.find((m) => m.type === "http_error").statusCode, 504);
  assert.equal(f.messages.filter((m) => m.requestId === "timeout").length, 1);
  assert.equal(f.bridge.activeRequests.size, 0);
});

test("keys can be disabled/deleted without logging secret values", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("{}"));
  f.send({ type: "validate_key", requestId: "valid", key: "test-key" });
  await until(() => f.messages.some((m) => m.requestId === "valid"));
  assert.equal(f.messages.find((m) => m.requestId === "valid").valid, true);
  f.bridge.command({ cmd: "set_keys", keys: [] });
  f.send({ type: "validate_key", requestId: "deleted", key: "test-key" });
  await until(() => f.messages.some((m) => m.requestId === "deleted"));
  assert.equal(f.messages.find((m) => m.requestId === "deleted").valid, false);
  assert.ok(!JSON.stringify(f.events).includes("test-key"));
});

test("rejects unexpected compression instead of corrupting the response", async (t) => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.headers["accept-encoding"], "identity");
    res.writeHead(200, { "Content-Encoding": "gzip" });
    res.end("compressed bytes");
  });
  f.send({ type: "http_relay", requestId: "compressed", path: "/v1/chat/completions", body: "{}" });
  await until(() => f.messages.some((m) => m.type === "http_error"));
  assert.equal(f.messages.find((m) => m.type === "http_error").statusCode, 502);
  assert.equal(f.messages.some((m) => m.type === "http_headers"), false);
  assert.equal(f.bridge.activeRequests.size, 0);
});

test("stopped node rejects work and stale socket close cannot disconnect its replacement", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("{}"));
  f.bridge.command({ cmd: "status_update", serverRunning: false });
  f.send({ type: "http_relay", requestId: "stopped", path: "/v1/chat/completions", body: "{}" });
  await until(() => f.messages.some((m) => m.requestId === "stopped"));
  assert.equal(f.messages.find((m) => m.requestId === "stopped").statusCode, 503);
  const replacement = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(replacement, "listening");
  t.after(async () => {
    for (const socket of replacement.clients) socket.terminate();
    await new Promise((resolve) => replacement.close(resolve));
  });
  replacement.on("connection", (socket) => socket.on("message", (raw) => {
    if (JSON.parse(raw).type === "auth") socket.send(JSON.stringify({ type: "auth_ok", nodeId: "replacement" }));
  }));
  f.bridge.command({ cmd: "connect", url: `http://127.0.0.1:${replacement.address().port}`, password: "test" });
  await until(() => f.bridge.nodeId === "replacement" && f.bridge.connected);
  await delay(20);
  assert.equal(f.bridge.connected, true);
});

test("failed authentication emits an error and closes cleanly", async (t) => {
  const f = await fixture(t, (_req, res) => res.end("{}"));
  f.send({ type: "auth_error", message: "wrong password" });
  await until(() => f.events.some((m) => m.type === "disconnected"));
  assert.ok(f.events.some((m) => m.type === "error" && m.message === "wrong password"));
  assert.equal(f.bridge.activeRequests.size, 0);
});
