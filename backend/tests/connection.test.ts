import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp } from "../src/index";
import { ConfigStore } from "../src/config";
import { createDatabase } from "../src/db/schema";
import { hashPassword } from "../src/services/auth";
import { PlatformService } from "../src/services/platform";
import { WebSocketTunnel } from "../src/services/websocket";

const { CloudBridge, cloudUrl } = require("../../scripts/cloud_bridge.js");
const PASSWORD = "connection-lifecycle-test-password";
const passwordHash = hashPassword(PASSWORD);
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });

async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, "connection condition timed out");
    await delay(5);
  }
}

async function fixture(t: TestContext, tunnelOverride?: WebSocketTunnel) {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-connections-"));
  const store = new ConfigStore(directory, {});
  store.save({ passwordHash: await passwordHash, port: 3000, setupComplete: true });
  const app = await buildApp({ configStore: store, logger: false, heartbeat: false, tunnel: tunnelOverride });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const database = createDatabase(directory);
  const tunnel = (app as any).tunnel as WebSocketTunnel;
  const platform = new PlatformService(database.sqlite, directory, tunnel);
  t.after(async () => {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const configure = (mode = "provider") => platform.saveAdminSettings({
    mode, relayBillingMode: "free", publicUrl: "https://connections.example.test",
    mailHost: "smtp.example.test", mailPort: 465, mailUser: "mailer", mailFrom: "mailer@example.test", mailPassword: "smtp-secret",
    alipayAppId: "app-id", alipayPrivateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    alipayPublicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  const bridge = () => {
    const events: Array<Record<string, any>> = [];
    const client = new CloudBridge((event: Record<string, any>) => events.push(event));
    t.after(() => client.disconnect());
    return { client, events, connect: (token: string, nodeId = "desktop-test-node") => {
      client.command({ cmd: "connect", url, password: token, nodeId, modelName: "model-a" });
    } };
  };
  return { app, url, tunnel, platform, database: database.sqlite, configure, bridge };
}

test("node token rotation, provider suspension, account disablement and revocation stop automatic reconnect", async t => {
  const { tunnel, platform, database, configure, bridge } = await fixture(t);
  configure();
  database.prepare("INSERT INTO platform_users(id,email,created_at) VALUES(?,?,?)")
    .run("supplier", "supplier@example.test", new Date().toISOString());
  platform.applyComputeProvider("supplier", "GPU node available all day with local model");
  platform.reviewComputeProvider("supplier", { status: "approved" });
  const node = platform.createRelayNode("supplier", "Supplier desktop");
  const { client, events, connect } = bridge();
  const disconnected = async (code: string) => {
    await until(() => events.some(event => event.type === "disconnected" && event.code === code));
    const event = events.find(event => event.type === "disconnected" && event.code === code)!;
    assert.equal(event.retryable, false, "permission failures must wait for user action");
    assert.ok(event.message, "the desktop receives an explanation rather than a generic network failure");
    assert.equal(tunnel.getOnlineNodes().length, 0);
  };
  connect(node.token);
  await until(() => client.connected);
  const rotated = platform.rotateRelayNodeToken("supplier", node.nodeId);
  await disconnected("token_rotated");
  assert.equal(platform.authenticateRelayNodeToken(node.token, "old-token").status, "invalid");
  connect(rotated.token);
  await until(() => client.connected);
  platform.reviewComputeProvider("supplier", { status: "suspended", reviewNote: "Node maintenance" });
  await disconnected("compute_provider_suspended");
  assert.equal(platform.authenticateRelayNodeToken(rotated.token, "suspended").status, "invalid");
  platform.reviewComputeProvider("supplier", { status: "approved" });
  connect(rotated.token);
  await until(() => client.connected);
  platform.updateUser("supplier", { active: false });
  await disconnected("account_disabled");
  assert.equal(platform.computeProviderAccess("supplier").canManageNodes, false);
  assert.equal((platform.authenticateRelayNodeToken(rotated.token, "disabled") as any).code, "account_disabled");
  platform.updateUser("supplier", { active: true });
  connect(rotated.token);
  await until(() => client.connected);
  assert.equal(platform.revokeRelayNode("supplier", node.nodeId), true);
  await disconnected("token_revoked");
  assert.equal((platform.authenticateRelayNodeToken(rotated.token, "revoked") as any).code, "token_revoked");
});

test("a second desktop using the same node token retires the first without reconnect competition", async t => {
  const { tunnel, platform, database, configure, bridge } = await fixture(t);
  configure("relay");
  database.prepare("INSERT INTO platform_users(id,email,created_at) VALUES(?,?,?)")
    .run("owner", "owner@example.test", new Date().toISOString());
  const node = platform.createRelayNode("owner", "One desktop");
  const first = bridge();
  first.connect(node.token);
  await until(() => first.client.connected);
  const second = bridge();
  second.connect(node.token);
  await until(() => second.client.connected && first.events.some(event => event.type === "disconnected"));
  assert.equal(first.events.at(-1)?.code, "connection_replaced");
  assert.equal(first.events.at(-1)?.retryable, false);
  assert.equal(tunnel.getOnlineNodes().length, 1);
  assert.equal(tunnel.getOnlineNodes()[0].id, node.nodeId);
  second.client.command({ cmd: "status_update", slots: 4 });
  await until(() => tunnel.getOnlineNodes()[0].slots === 4);
  second.client.command({ cmd: "status_update", slots: null });
  await until(() => tunnel.getOnlineNodes()[0].slots === null);
  tunnel.close();
  await until(() => second.events.some(event => event.type === "disconnected"));
  assert.equal(second.events.at(-1)?.code, "server_shutdown");
  assert.equal(second.events.at(-1)?.retryable, true, "server restart permits automatic recovery with the saved credential");
});

test("desktop bridge accepts pasted console links and uses HTTPS for public addresses", () => {
  assert.equal(cloudUrl("api.example.test").href, "wss://api.example.test/ws/node");
  assert.equal(cloudUrl("https://api.example.test/gateway/console").href, "wss://api.example.test/gateway/ws/node");
  assert.equal(cloudUrl("localhost:3000/admin").href, "ws://localhost:3000/ws/node");
  assert.equal(cloudUrl("http://127.0.0.1:3000/ws/node/").href, "ws://127.0.0.1:3000/ws/node");
  assert.equal(cloudUrl("https://api.example.test/prefix/admin/console").href, "wss://api.example.test/prefix/admin/ws/node");
  assert.equal(cloudUrl("https://api.example.test/prefix/admin/ws/node").href, "wss://api.example.test/prefix/admin/ws/node");
  assert.equal(cloudUrl("https://api.example.test/prefix/admin", { serverUrlIsCanonical: true }).href,
    "wss://api.example.test/prefix/admin/ws/node");
  assert.equal(cloudUrl("https://api.example.test/prefix/ws/node", { serverUrlIsCanonical: true }).href,
    "wss://api.example.test/prefix/ws/node/ws/node");
  assert.throws(() => cloudUrl("http://api.example.test"), /HTTPS/);
  assert.throws(() => cloudUrl("https://user:password@api.example.test"), /账号/);
});

test("CloudBridge preserves canonical proxy directories while accepting copied page links from CLI input", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const paths: string[] = [];
  server.on("connection", (socket, request) => {
    paths.push(request.url || "");
    socket.on("message", () => socket.send(JSON.stringify({ type: "auth_ok", nodeId: "prefix-node" })));
  });
  const bridge = new CloudBridge();
  t.after(async () => {
    bridge.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  bridge.command({ cmd: "connect", url: `${url}/prefix/admin`, password: "unused", serverUrlIsCanonical: true });
  await until(() => bridge.connected);
  assert.equal(paths[0], "/prefix/admin/ws/node");
  bridge.disconnect();
  bridge.command({ cmd: "connect", url: `${url}/prefix/admin/console`, password: "unused" });
  await until(() => bridge.connected);
  assert.equal(paths[1], "/prefix/admin/ws/node");
});

test("operating mode changes close sockets awaiting authentication before an obsolete result can admit them", async t => {
  let accept: ((value: "ok") => void) | undefined;
  const tunnel = new WebSocketTunnel({ authenticate: () => new Promise(resolve => { accept = resolve; }) });
  const { url, platform, configure } = await fixture(t, tunnel);
  const socket = new WebSocket(url.replace("http:", "ws:") + "/ws/node");
  const messages: Array<Record<string, any>> = [];
  socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
  socket.on("error", () => {});
  t.after(() => socket.terminate());
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth", password: PASSWORD, nodeId: "late-node" }));
  await until(() => !!accept);
  configure("relay");
  await until(() => socket.readyState === WebSocket.CLOSED);
  accept!("ok");
  await delay(20);
  assert.equal(messages.find(message => message.type === "connection_closed")?.code, "mode_changed");
  assert.equal(messages.some(message => message.type === "auth_ok"), false);
  assert.equal(tunnel.getOnlineNodes().length, 0);
  platform.saveAdminSettings({ mode: "personal" });
});

test("CloudBridge keeps authentication failures terminal and times out servers that never finish authentication", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let failAuth = true;
  server.on("connection", socket => socket.on("message", () => {
    if (failAuth) socket.send(JSON.stringify({ type: "auth_error", message: "Wrong token", code: "invalid_node_token", retryable: false }));
  }));
  const events: Array<Record<string, any>> = [];
  const bridge = new CloudBridge((event: Record<string, any>) => events.push(event), { authTimeout: 35 });
  t.after(async () => {
    bridge.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  bridge.command({ cmd: "connect", url: address, password: "invalid" });
  await until(() => events.some(event => event.type === "disconnected"));
  assert.equal(events.at(-1)?.code, "invalid_node_token");
  assert.equal(events.at(-1)?.retryable, false, "the close event must preserve the preceding auth error");
  failAuth = false;
  events.length = 0;
  bridge.command({ cmd: "connect", url: address, password: "unused" });
  await until(() => events.some(event => event.type === "disconnected"));
  assert.equal(events.at(-1)?.code, "auth_timeout");
  assert.equal(events.at(-1)?.retryable, true);
});

test("CloudBridge treats HTTP route errors as configuration failures and server downtime as retryable", async t => {
  let statusCode = 404;
  const server = createServer((_request, response) => { response.writeHead(statusCode); response.end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const events: Array<Record<string, any>> = [];
  const bridge = new CloudBridge((event: Record<string, any>) => events.push(event));
  t.after(async () => {
    bridge.disconnect();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  for (const [status, code, retryable] of [[404, "invalid_endpoint", false], [503, "server_unavailable", true]] as const) {
    statusCode = status;
    events.length = 0;
    bridge.command({ cmd: "connect", url, password: "unused" });
    await until(() => events.some(event => event.type === "disconnected"));
    assert.equal(events.at(-1)?.code, code);
    assert.equal(events.at(-1)?.retryable, retryable);
  }
});
