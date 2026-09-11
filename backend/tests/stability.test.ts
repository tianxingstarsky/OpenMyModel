import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { request as httpRequest, createServer, Server, IncomingMessage } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { buildApp, AppOptions } from "../src/index";
import { ConfigStore } from "../src/config";
import { hashPassword, verifyPassword, verifyAdminPassword } from "../src/services/auth";
import { WebSocketTunnel } from "../src/services/websocket";
import { relayHeaders } from "../src/routes/openai";

const PASSWORD = "test-only-admin-password";
const passwordHash = hashPassword(PASSWORD);

type Message = Record<string, any>;

async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, "condition timed out");
    await delay(5);
  }
}

async function fixture(t: TestContext, options: AppOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-backend-test-"));
  const store = new ConfigStore(directory, {});
  store.save({ passwordHash: await passwordHash, port: 3000, setupComplete: true });
  const app = await buildApp({ configStore: store, logger: false, heartbeat: false, ...options });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const tunnel = (app as any).tunnel as WebSocketTunnel;
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const socket of clients) socket.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function node(info: Message = {}, handle: (msg: Message, send: (msg: Message) => void) => void = () => {}, autoPong = true) {
    const socket = new WebSocket(url.replace("http:", "ws:") + "/ws/node", { autoPong });
    clients.push(socket);
    const messages: Message[] = [];
    const send = (message: Message) => socket.send(JSON.stringify(message));
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.type === "ping" && autoPong) send({ type: "pong" });
      handle(message, send);
    });
    socket.on("error", () => {});
    await once(socket, "open");
    send({ type: "auth", password: PASSWORD, nodeId: "node-1", modelName: "model-a", ...info });
    await until(() => messages.some(msg => msg.type === "auth_ok" || msg.type === "auth_error"));
    assert.equal(messages.find(msg => msg.type.startsWith("auth_"))?.type, "auth_ok");
    return { socket, messages, send };
  }

  function post(payload: string | object = { model: "model-a", messages: [] }, key = "valid-key") {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const req = httpRequest(url + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "content-length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    const response = once(req, "response").then(([res]) => res as IncomingMessage);
    req.end(body);
    return { req, response };
  }
  return { app, tunnel, store, directory, url, node, post };
}

const keyOwner = (msg: Message, send: (message: Message) => void) => {
  if (msg.type === "validate_key") send({ type: "key_valid", requestId: msg.requestId, valid: msg.key === "valid-key" });
};
const headers = (requestId: string, statusCode = 200, extra: Message = {}) => ({
  type: "http_headers", requestId, statusCode, headers: { "content-type": "application/json", ...extra },
});
async function text(response: IncomingMessage): Promise<string> {
  let body = "";
  response.setEncoding("utf8");
  for await (const chunk of response) body += chunk;
  return body;
}

test("password hashing is versioned, salted, async, strict, and migrates legacy hashes", async () => {
  const hash = await passwordHash;
  assert.match(hash, /^scrypt\$v1\$/);
  assert.notEqual(hash, await hashPassword(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  for (const malformed of [null, {}, "", "salt:hash", "a:b:c", "scrypt$v2$x$y", "f".repeat(32) + ":0".repeat(64)]) {
    assert.equal(await verifyPassword(PASSWORD, malformed), false);
  }
  for (const malformed of [null, {}, [], 4, "", "x".repeat(1025)]) assert.equal(await verifyPassword(malformed, hash), false);
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-auth-test-"));
  try {
    const store = new ConfigStore(directory, {});
    const salt = "a".repeat(32);
    const legacy = salt + ":" + createHash("sha256").update(salt + PASSWORD).digest("hex");
    store.save({ port: 3000, setupComplete: true, passwordHash: legacy });
    assert.equal(await verifyAdminPassword("wrong", store), false);
    assert.equal(store.load().passwordHash, legacy);
    assert.equal(await verifyAdminPassword(PASSWORD, store), true);
    assert.match(store.load().passwordHash, /^scrypt\$v1\$/);
    assert.equal(readFileSync(join(directory, "config.json"), "utf8").includes(PASSWORD), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("startup uses isolated env configuration and requires explicit initialization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-config-test-"));
  try {
    await assert.rejects(buildApp({ dataDir: directory, env: {}, logger: false }), /Set ADMIN_PASSWORD/);
    const store = new ConfigStore(undefined, { OPENMYMODEL_DATA_DIR: directory, ADMIN_PASSWORD: PASSWORD, PORT: "3123" });
    await store.initialize();
    assert.equal(store.load().port, 3123);
    assert.match(store.load().passwordHash, /^scrypt\$v1\$/);
    assert.equal(await verifyPassword(PASSWORD, store.load().passwordHash), true);
    assert.equal(readFileSync(join(directory, "config.json"), "utf8").includes(PASSWORD), false);
    const existing = new ConfigStore(directory, { ADMIN_PASSWORD: "replacement" });
    await existing.initialize();
    assert.equal(existing.load().passwordHash, store.load().passwordHash);
    assert.throws(() => new ConfigStore(directory, { PORT: "bad" }).load(), /Invalid PORT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("JSON validation rejects malformed, non-JSON, and bodies exceeding 32 MiB", async t => {
  const { app } = await fixture(t);
  for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: contentType ? { "content-type": contentType } : {}, payload: "{}" });
    assert.equal(response.statusCode, 415);
  }
  for (const payload of ["{", "[]", "null", '{"stream":"true"}', '{"model":4}']) {
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload });
    assert.equal(response.statusCode, 400);
  }
  const large = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, payload: '"' + "x".repeat(32 * 1024 * 1024) + '"' });
  assert.equal(large.statusCode, 413);
});

test("whitespace JSON stream parsing, delayed headers, raw SSE, and clean timer settlement", async t => {
  const { node, post, tunnel } = await fixture(t, { tunnelOptions: { requestTimeoutMs: 100 } });
  let relay: Message | undefined;
  const peer = await node({}, (msg, send) => { keyOwner(msg, send); if (msg.type === "http_relay") relay = msg; });
  const pending = post('{ "model": "model-a", "stream" : true, "messages": [] }');
  let arrived = false;
  pending.response.then(() => { arrived = true; });
  await until(() => !!relay);
  assert.equal(arrived, false);
  assert.equal(relay!.method, "POST");
  assert.equal(relay!.path, "/v1/chat/completions");
  assert.equal(relay!.key, undefined);
  peer.send(headers(relay!.requestId, 200, { "content-type": "text/event-stream", "retry-after": "4", "content-length": "999" }));
  const response = await pending.response;
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-accel-buffering"], "no");
  assert.equal(response.headers["retry-after"], "4");
  assert.equal(response.headers["content-length"], undefined);
  const chunks = ["data: {\"text\":\"", "\u4f60\u597d  \"}\n", "\n", "data: [DONE]\n\n"];
  const body = text(response);
  for (const data of chunks) peer.send({ type: "http_chunk", requestId: relay!.requestId, data });
  peer.send({ type: "http_done", requestId: relay!.requestId });
  assert.equal(await body, chunks.join(""));
  assert.equal(tunnel.pendingRequestCount, 0);
  await delay(130);
  assert.equal(peer.messages.filter(msg => msg.type === "cancel_request").length, 0);
});

test("nonstream requests preserve upstream 4xx/5xx status, content type, and raw body", async t => {
  const { node, post } = await fixture(t);
  let statusCode = 429;
  await node({}, (msg, send) => {
    keyOwner(msg, send);
    if (msg.type === "http_relay") {
      send(headers(msg.requestId, statusCode, { "content-type": "text/plain", "retry-after": "12" }));
      send({ type: "http_chunk", requestId: msg.requestId, data: "  upstream error\n\n" });
      send({ type: "http_done", requestId: msg.requestId });
    }
  });
  for (statusCode of [400, 429, 500, 503]) {
    const response = await post().response;
    assert.equal(response.statusCode, statusCode);
    assert.equal(response.headers["content-type"], "text/plain");
    assert.equal(await text(response), "  upstream error\n\n");
  }
});

test("transport failures before headers become 502/504 and old chunk-only protocol fails", async t => {
  const { node, post, tunnel } = await fixture(t);
  let mode = "error";
  let code = 502;
  await node({}, (msg, send) => {
    keyOwner(msg, send);
    if (msg.type === "http_relay") send(mode === "error"
      ? { type: "http_error", requestId: msg.requestId, statusCode: code, message: "upstream failed" }
      : { type: "http_chunk", requestId: msg.requestId, data: "not success" });
  });
  for (code of [502, 504]) {
    const response = await post({ stream: true }).response;
    assert.equal(response.statusCode, code);
    assert.match(await text(response), /upstream failed/);
  }
  mode = "old";
  const response = await post().response;
  assert.equal(response.statusCode, 502);
  assert.match(await text(response), /update the compute node bridge/);
  assert.equal(tunnel.pendingRequestCount, 0);
});

test("post-header errors abort stream and nonstream responses instead of ending successfully", async t => {
  const { node, post, tunnel } = await fixture(t);
  let relay: Message | undefined;
  const peer = await node({}, (msg, send) => { keyOwner(msg, send); if (msg.type === "http_relay") relay = msg; });
  for (const stream of [false, true]) {
    relay = undefined;
    const pending = post({ stream });
    await until(() => !!relay);
    peer.send(headers(relay!.requestId));
    const response = await pending.response;
    const body = text(response);
    peer.send({ type: "http_chunk", requestId: relay!.requestId, data: "partial" });
    peer.send({ type: "http_error", requestId: relay!.requestId, statusCode: 502, message: "broken" });
    await assert.rejects(body);
    assert.equal(response.complete, false);
    assert.equal(tunnel.pendingRequestCount, 0);
  }
});

test("HTTP disconnect cancels stream and nonstream requests and clears refreshed timers", async t => {
  const { node, post, tunnel } = await fixture(t, { tunnelOptions: { requestTimeoutMs: 150 } });
  let relay: Message | undefined;
  const peer = await node({}, (msg, send) => { keyOwner(msg, send); if (msg.type === "http_relay") relay = msg; });
  for (const stream of [false, true]) {
    relay = undefined;
    const pending = post({ stream });
    await until(() => !!relay);
    peer.send(headers(relay!.requestId));
    const response = await pending.response;
    response.on("error", () => {});
    peer.send({ type: "http_chunk", requestId: relay!.requestId, data: "partial" });
    await delay(15);
    pending.req.destroy();
    await until(() => peer.messages.some(msg => msg.type === "cancel_request" && msg.requestId === relay!.requestId));
    assert.equal(tunnel.pendingRequestCount, 0);
    await delay(180);
    assert.equal(peer.messages.filter(msg => msg.type === "cancel_request" && msg.requestId === relay!.requestId).length, 1);
  }
});

test("disconnect during key validation settles without sending a request body", async t => {
  const { node, post, tunnel } = await fixture(t);
  const peer = await node();
  const pending = post();
  const responseFailure = pending.response.catch(() => undefined);
  await until(() => peer.messages.some(msg => msg.type === "validate_key"));
  pending.req.destroy();
  await responseFailure;
  await until(() => tunnel.pendingRequestCount === 0);
  assert.equal(peer.messages.some(msg => msg.type === "http_relay"), false);
  await until(() => peer.messages.some(msg => msg.type === "cancel_request"));
});

test("idle timeout cancels and rejects before headers and after partial response", async t => {
  const { node, post, tunnel } = await fixture(t, { tunnelOptions: { requestTimeoutMs: 60 } });
  let relay: Message | undefined;
  const peer = await node({}, (msg, send) => { keyOwner(msg, send); if (msg.type === "http_relay") relay = msg; });
  const response = await post().response;
  assert.equal(response.statusCode, 504);
  await text(response);
  await until(() => peer.messages.some(msg => msg.type === "cancel_request"));
  assert.equal(tunnel.pendingRequestCount, 0);
  relay = undefined;
  const pending = post({ stream: true });
  await until(() => !!relay);
  peer.send(headers(relay!.requestId));
  const streaming = await pending.response;
  const body = text(streaming);
  peer.send({ type: "http_chunk", requestId: relay!.requestId, data: "partial" });
  await assert.rejects(body);
  assert.equal(tunnel.pendingRequestCount, 0);
  await until(() => peer.messages.filter(msg => msg.type === "cancel_request").length === 2);
});

test("node disconnect rejects all pending requests immediately", async t => {
  const { node, post, tunnel } = await fixture(t);
  const peer = await node({}, keyOwner);
  const first = post();
  const second = post({ stream: true });
  await until(() => peer.messages.filter(msg => msg.type === "http_relay").length === 2);
  peer.socket.terminate();
  for (const pending of [first, second]) {
    const response = await pending.response;
    assert.equal(response.statusCode, 502);
    await text(response);
  }
  assert.equal(tunnel.pendingRequestCount, 0);
});

test("node replacement retires old socket without deleting replacement or reusing validation", async t => {
  const { node, tunnel, post } = await fixture(t);
  const old = await node({}, keyOwner);
  const target = await tunnel.findNode("valid-key", "model-a");
  const pending = post();
  await until(() => old.messages.some(msg => msg.type === "http_relay"));
  const replacement = await node({ nodeName: "replacement" }, keyOwner);
  const response = await pending.response;
  assert.equal(response.statusCode, 502);
  await text(response);
  await until(() => old.socket.readyState === WebSocket.CLOSED);
  assert.equal(tunnel.getOnlineNodes()[0].name, "replacement");
  await assert.rejects(tunnel.relayHttp(target, { path: "/v1/chat/completions", body: "{}" }, { onHeaders: () => {} }), /replaced/);
  assert.equal(replacement.messages.some(msg => msg.type === "http_relay"), false);
  assert.equal(tunnel.pendingRequestCount, 0);
});

test("multi-node routing probes key owners sequentially, filters models, and honors serverRunning", async t => {
  const { node, post, tunnel } = await fixture(t);
  const respond = (key: string) => (msg: Message, send: (message: Message) => void) => {
    if (msg.type === "validate_key") send({ type: "key_valid", requestId: msg.requestId, valid: msg.key === key });
    if (msg.type === "http_relay") {
      send(headers(msg.requestId)); send({ type: "http_chunk", requestId: msg.requestId, data: '{"ok":true}' }); send({ type: "http_done", requestId: msg.requestId });
    }
  };
  const first = await node({ nodeId: "z-node", modelName: "model-a" }, respond("first-key"));
  const wrongModel = await node({ nodeId: "middle", modelName: "model-b" }, respond("valid-key"));
  const owner = await node({ nodeId: "a-node", modelName: "model-a" }, respond("valid-key"));
  const unused = await node({ nodeId: "last-node", modelName: "model-a" }, respond("unused-key"));
  const response = await post().response;
  assert.equal(response.statusCode, 200); await text(response);
  assert.equal(first.messages.filter(msg => msg.type === "validate_key").length, 1);
  assert.equal(first.messages.some(msg => msg.type === "http_relay"), false);
  assert.equal(owner.messages.some(msg => msg.type === "http_relay"), true);
  assert.equal(wrongModel.messages.some(msg => msg.type === "validate_key"), false);
  assert.equal(unused.messages.some(msg => msg.type === "validate_key"), false);
  const alias = await post({ model: "local-model" }, "first-key").response;
  assert.equal(alias.statusCode, 200); await text(alias);
  owner.send({ type: "status_update", serverRunning: false, modelName: "" });
  await until(() => tunnel.getOnlineNodes().find(node => node.id === "a-node")?.serverRunning === false);
  const stopped = await post().response;
  assert.equal(stopped.statusCode, 401); await text(stopped);
  const missing = await post({ model: "not-installed" }).response;
  assert.equal(missing.statusCode, 404); await text(missing);
});

test("eligible nodes with the same key rotate deterministically without broadcasting", async t => {
  const { node, tunnel } = await fixture(t);
  const first = await node({ nodeId: "z-first" }, keyOwner);
  const second = await node({ nodeId: "a-second" }, keyOwner);
  const targets = [];
  for (let i = 0; i < 4; i++) targets.push((await tunnel.findNode("valid-key", "model-a")).nodeId);
  assert.deepEqual(targets, ["z-first", "a-second", "z-first", "a-second"]);
  assert.equal(first.messages.filter(msg => msg.type === "validate_key").length, 2);
  assert.equal(second.messages.filter(msg => msg.type === "validate_key").length, 2);
});

test("client disconnect before upstream headers cancels both stream modes", async t => {
  const { node, post, tunnel } = await fixture(t);
  const peer = await node({}, keyOwner);
  for (const stream of [false, true]) {
    const before = peer.messages.filter(msg => msg.type === "http_relay").length;
    const pending = post({ stream });
    const failed = pending.response.catch(() => undefined);
    await until(() => peer.messages.filter(msg => msg.type === "http_relay").length > before);
    const relay = peer.messages.filter(msg => msg.type === "http_relay").at(-1)!;
    pending.req.destroy();
    await failed;
    await until(() => peer.messages.some(msg => msg.type === "cancel_request" && msg.requestId === relay.requestId));
    assert.equal(tunnel.pendingRequestCount, 0);
  }
});

test("key validation timeout rejects, cancels, and leaves no pending entry", async t => {
  const { node, tunnel } = await fixture(t, { tunnelOptions: { keyTimeoutMs: 40 } });
  const peer = await node();
  await assert.rejects(tunnel.findNode("valid-key", "model-a"), (error: any) => error.statusCode === 504);
  assert.equal(tunnel.pendingRequestCount, 0);
  await until(() => peer.messages.some(msg => msg.type === "cancel_request"));
});

test("legacy nodes without a model name remain a local-model fallback", async t => {
  const { node, post } = await fixture(t);
  await node({ modelName: "" }, (msg, send) => {
    keyOwner(msg, send);
    if (msg.type === "http_relay") { send(headers(msg.requestId)); send({ type: "http_done", requestId: msg.requestId }); }
  });
  const response = await post({ model: "client-alias" }).response;
  assert.equal(response.statusCode, 200); await text(response);
});

test("native/JSON heartbeat removes silent nodes and keeps responsive nodes online", async t => {
  const { node, tunnel } = await fixture(t, { heartbeat: true, tunnelOptions: { heartbeatIntervalMs: 30, heartbeatTimeoutMs: 30 } });
  const responsive = await node({ nodeId: "responsive" }, keyOwner);
  const silent = await node({ nodeId: "silent" }, () => {}, false);
  await until(() => silent.socket.readyState === WebSocket.CLOSED);
  assert.deepEqual(tunnel.getOnlineNodes().map(node => node.id), ["responsive"]);
  assert.equal(responsive.socket.readyState, WebSocket.OPEN);
});

test("admin authentication is bounded and malformed passwords fail safely", async t => {
  const { app } = await fixture(t, { authLimit: 2 });
  for (let i = 0; i < 5; i++) {
    const good = await app.inject({ url: "/admin/nodes", headers: { "x-admin-password": PASSWORD } });
    assert.equal(good.statusCode, 200);
  }
  const bad = await app.inject({ url: "/admin/nodes", headers: { "x-admin-password": "wrong" } });
  assert.equal(bad.statusCode, 401);
  const success = await app.inject({ url: "/admin/nodes", headers: { "x-admin-password": PASSWORD } });
  assert.equal(success.statusCode, 200);
  const secondBad = await app.inject({ url: "/admin/nodes", headers: { "x-admin-password": "wrong" } });
  assert.equal(secondBad.statusCode, 401);
  const limited = await app.inject({ url: "/admin/nodes", headers: { "x-admin-password": PASSWORD } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "60");
});

test("relay headers reject injection and remove transport/private headers", () => {
  const safe = relayHeaders({ connection: "x-internal", "x-internal": "secret", "content-length": "123", "set-cookie": "secret", "access-control-allow-origin": "evil", "content-type": "text/plain" });
  assert.deepEqual(Object.keys(safe), ["content-type"]);
  assert.throws(() => relayHeaders({ "bad\nname": "value" }));
  assert.throws(() => relayHeaders({ "x-header": "value\r\nInjected: yes" }));
  assert.throws(() => relayHeaders({ "content-encoding": "gzip" }));
});

test("production CloudBridge E2E preserves split UTF-8 SSE, upstream errors, auth, and cancellation", async t => {
  const { CloudBridge } = require("../../scripts/cloud_bridge.js");
  const { url, post, tunnel } = await fixture(t);
  let mode = "stream";
  let upstreamClosed = false;
  const upstream = createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer llama-secret");
    assert.equal(req.headers["accept-encoding"], "identity");
    req.resume();
    req.on("end", () => {
      if (mode === "error") { res.writeHead(429, { "content-type": "text/plain", "retry-after": "3" }); res.end("limited\n"); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "cancel") {
        res.on("close", () => { upstreamClosed = true; });
        res.write("data: partial\n\n");
        return;
      }
      const bytes = Buffer.from('data: {"text":"\u4f60\u597d  "}\n\n');
      res.write(bytes.subarray(0, 17));
      setTimeout(() => { res.write(bytes.subarray(17, 19)); res.end(bytes.subarray(19)); }, 10);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  const bridge = new CloudBridge();
  t.after(async () => {
    bridge.disconnect();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  bridge.command({ cmd: "set_keys", keys: [{ key: "valid-key", isActive: true }] });
  bridge.command({ cmd: "connect", url, password: PASSWORD, nodeId: "production-bridge", modelName: "model-a", llamaUrl: `http://127.0.0.1:${port}`, llamaApiKey: "llama-secret" });
  await until(() => bridge.connected);
  const streamed = await post('{ "stream" : true, "model": "model-a" }').response;
  assert.equal(await text(streamed), 'data: {"text":"\u4f60\u597d  "}\n\n');
  mode = "error";
  const failed = await post().response;
  assert.equal(failed.statusCode, 429);
  assert.equal(failed.headers["retry-after"], "3");
  assert.equal(await text(failed), "limited\n");
  mode = "cancel";
  const pending = post({ stream: true });
  const response = await pending.response;
  response.on("error", () => {});
  pending.req.destroy();
  await until(() => upstreamClosed && bridge.activeRequests.size === 0 && tunnel.pendingRequestCount === 0);
});
