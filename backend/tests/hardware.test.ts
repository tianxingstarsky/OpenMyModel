import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";
import { buildApp } from "../src/index";
import { ConfigStore } from "../src/config";
import { createDatabase } from "../src/db/schema";
import { hashPassword } from "../src/services/auth";
import { parseNodeHardware, readNodeHardware } from "../src/services/hardware";
import { PlatformService } from "../src/services/platform";
import { WebSocketTunnel } from "../src/services/websocket";

const { CloudBridge } = require("../../scripts/cloud_bridge.js");
const PASSWORD = "hardware-test-password";
const passwordHash = hashPassword(PASSWORD);
const inventory = () => ({ os: "windows", arch: "x64", status: "detected", source: "nvidia-smi",
  detectedAt: "2026-10-07T12:00:00.000Z",
  devices: [{ name: "NVIDIA Example GPU", backend: "CUDA", totalMemoryMiB: 24576, freeMemoryMiB: 22000 }] });

async function until(predicate: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < timeout, "hardware condition timed out");
    await delay(5);
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-hardware-"));
  const store = new ConfigStore(directory, {});
  store.save({ passwordHash: await passwordHash, port: 3000, setupComplete: true });
  const app = await buildApp({ configStore: store, logger: false, heartbeat: false });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const database = createDatabase(directory);
  const tunnel = (app as any).tunnel as WebSocketTunnel;
  const platform = new PlatformService(database.sqlite, directory, tunnel);
  const clients: any[] = [];
  t.after(async () => {
    for (const client of clients) client.disconnect();
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const bridge = () => {
    const client = new CloudBridge();
    clients.push(client);
    return client;
  };
  return { app, url, database: database.sqlite, platform, tunnel, bridge, directory };
}

test("hardware inventories have bounded fields, memory, device counts and size; unknown stays distinct from CPU only", () => {
  assert.deepEqual(parseNodeHardware(inventory()), inventory());
  const cpu = { ...inventory(), status: "cpu_only", source: "system", devices: [] };
  const unknown = { ...cpu, status: "unknown", error: "GPU detection unavailable" };
  assert.deepEqual(parseNodeHardware(cpu), cpu);
  assert.deepEqual(parseNodeHardware(unknown), unknown);
  const untrusted = { ...inventory(), admin: true, price: 123, ownerUserId: "other" };
  assert.deepEqual(parseNodeHardware(untrusted), inventory(), "unexpected fields cannot become privileges or billing data");
  const invalid = [null, [], "gpu", { ...inventory(), os: "x".repeat(65) }, { ...inventory(), source: "bad\nsource" },
    { ...inventory(), status: "cpu_only" }, { ...inventory(), detectedAt: "not-a-time" },
    { ...inventory(), devices: Array(17).fill(inventory().devices[0]) },
    { ...inventory(), devices: [{ ...inventory().devices[0], totalMemoryMiB: -1 }] },
    { ...inventory(), devices: [{ ...inventory().devices[0], totalMemoryMiB: Infinity }] },
    { ...inventory(), devices: [{ ...inventory().devices[0], totalMemoryMiB: "24576" }] },
    { ...inventory(), devices: [{ ...inventory().devices[0], freeMemoryMiB: 30000 }] },
    { ...inventory(), devices: [{ ...inventory().devices[0], name: "x".repeat(257) }] },
    { ...inventory(), padding: "x".repeat(4096) }];
  for (const value of invalid) assert.equal(parseNodeHardware(value), null);
  assert.equal(readNodeHardware("{not-json"), null);
});

test("hardware database migration preserves legacy nodes with unknown hardware and is repeatable", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-hardware-migration-"));
  const legacy = new Database(join(directory, "openmymodel.db"));
  legacy.exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY,name TEXT NOT NULL,connected_at TEXT NOT NULL,
    last_heartbeat TEXT,is_online INTEGER NOT NULL DEFAULT 0,model_name TEXT,model_config TEXT);
    INSERT INTO nodes(id,name,connected_at) VALUES('old-node','Legacy node','2026-01-01T00:00:00.000Z');`);
  legacy.close();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const database = createDatabase(directory);
      const node = database.sqlite.prepare("SELECT name,hardware_json,hardware_reported_at FROM nodes WHERE id='old-node'").get();
      assert.deepEqual(node, { name: "Legacy node", hardware_json: null, hardware_reported_at: null });
      database.close();
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("real desktop bridge uploads hardware to owner/admin views, persists offline and clears stale devices on a legacy reconnect", async t => {
  const { app, url, database, platform, tunnel, bridge, directory } = await fixture(t);
  platform.saveAdminSettings({ mode: "relay", relayBillingMode: "free", publicUrl: "https://hardware.example.test",
    mailHost: "smtp.example.test", mailPort: 465, mailUser: "mailer", mailFrom: "mailer@example.test", mailPassword: "smtp-password" });
  for (const owner of ["owner-a", "owner-b"]) database.prepare("INSERT INTO platform_users(id,email,created_at) VALUES(?,?,?)")
    .run(owner, `${owner}@example.test`, new Date().toISOString());
  const node = platform.createRelayNode("owner-a", "GPU desktop");
  const another = platform.createRelayNode("owner-b", "Other desktop");
  const client = bridge();
  client.command({ cmd: "connect", url, password: node.token, hardware: inventory(), modelName: "model-a", serverRunning: false, slots: 4 });
  await until(() => client.connected && platform.listRelayNodes("owner-a")[0].hardware !== null);
  const ownSession = platform.createSession("user", "owner-a");
  const otherSession = platform.createSession("user", "owner-b");
  const owned = (await app.inject({ url: "/api/user/relay/nodes", headers: { cookie: `omm_session=${ownSession}` } })).json();
  assert.deepEqual(owned[0].hardware, inventory());
  assert.ok(Number.isFinite(Date.parse(owned[0].hardwareReportedAt)));
  assert.notEqual(owned[0].hardwareReportedAt, owned[0].hardware.detectedAt, "server receipt time is independent of the client clock");
  const others = (await app.inject({ url: "/api/user/relay/nodes", headers: { cookie: `omm_session=${otherSession}` } })).json();
  assert.equal(others.length, 1);
  assert.equal(others[0].nodeId, another.nodeId);
  assert.equal(others[0].hardware, null, "another account never sees this user's inventory");
  assert.equal((await app.inject({ url: "/api/user/relay/nodes" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/status.json" })).body.includes("NVIDIA"), false);
  const admin = (await app.inject({ url: "/api/admin/nodes", headers: { cookie: `omm_session=${platform.createSession("admin", null)}` } })).json();
  assert.deepEqual(admin.find((item: any) => item.id === node.nodeId).hardware, inventory());
  assert.equal(JSON.stringify(admin).includes("hardwareJson"), false);
  const updated = { ...inventory(), devices: [{ ...inventory().devices[0], freeMemoryMiB: 18000 }] };
  client.command({ cmd: "hardware_update", hardware: updated });
  await until(() => platform.listRelayNodes("owner-a")[0].hardware?.devices[0].freeMemoryMiB === 18000);
  assert.equal(tunnel.getOnlineNodes()[0].serverRunning, false, "inventory-only updates cannot make the model ready");
  assert.equal(tunnel.getOnlineNodes()[0].modelName, "model-a");
  assert.equal(tunnel.getOnlineNodes()[0].slots, 4);
  client.disconnect();
  await until(() => !platform.listRelayNodes("owner-a")[0].isOnline);
  const restored = new PlatformService(database, directory, new WebSocketTunnel({ authenticate: async () => "invalid" }));
  assert.deepEqual(restored.listRelayNodes("owner-a")[0].hardware, updated, "stored inventory survives a fresh service instance");
  assert.deepEqual(restored.adminNodeList().find(item => item.id === node.nodeId)?.hardware, updated);
  assert.deepEqual(JSON.parse((database.prepare("SELECT hardware_json FROM nodes WHERE id=?").get(node.nodeId) as any).hardware_json), updated);
  client.command({ cmd: "connect", url, password: node.token, modelName: "legacy-model" });
  await until(() => client.connected && platform.listRelayNodes("owner-a")[0].isOnline);
  assert.equal(platform.listRelayNodes("owner-a")[0].hardware, null, "new connections do not inherit the previous machine's devices");
  assert.equal(platform.listRelayNodes("owner-a")[0].hardwareReportedAt, null);
});

test("legacy websocket clients remain usable and malformed hardware cannot bypass credentials or break an admitted node", async t => {
  const { url, tunnel, platform } = await fixture(t);
  const socket = new WebSocket(url.replace("http:", "ws:") + "/ws/node");
  t.after(() => socket.terminate());
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "auth", password: PASSWORD, nodeId: "legacy-hardware-node", modelName: "legacy", serverRunning: true }));
  await until(() => tunnel.getOnlineNodes().length === 1);
  assert.equal(platform.adminNodeList()[0].hardware, null);
  socket.send(JSON.stringify({ type: "status_update", hardware: inventory() }));
  await until(() => tunnel.getOnlineNodes()[0].hardware !== null);
  const reportTime = tunnel.getOnlineNodes()[0].hardwareReportedAt;
  socket.send(JSON.stringify({ type: "status_update", slots: 3 }));
  await until(() => tunnel.getOnlineNodes()[0].slots === 3);
  assert.deepEqual(tunnel.getOnlineNodes()[0].hardware, inventory(), "old status updates retain a valid current-session inventory");
  assert.equal(tunnel.getOnlineNodes()[0].hardwareReportedAt, reportTime, "heartbeat/status activity is not a new inventory report");
  socket.send(JSON.stringify({ type: "status_update", hardware: { ...inventory(), devices: Array(17).fill(inventory().devices[0]) } }));
  await until(() => tunnel.getOnlineNodes()[0].hardware === null);
  assert.equal(tunnel.getOnlineNodes()[0].serverRunning, true);
  assert.equal(tunnel.getOnlineNodes()[0].modelName, "legacy");
  const unauthenticated = new WebSocket(url.replace("http:", "ws:") + "/ws/node");
  t.after(() => unauthenticated.terminate());
  await once(unauthenticated, "open");
  const closed = once(unauthenticated, "close");
  unauthenticated.send(JSON.stringify({ type: "auth", password: "wrong", nodeId: "spoofed", hardware: inventory() }));
  await closed;
  assert.equal(tunnel.getOnlineNodes().length, 1);
  assert.equal(platform.adminNodeList().some(item => item.id === "spoofed"), false);
});

test("provider application needs no handwritten hardware before approval and desktop inventory follows permission", async t => {
  const { url, database, platform, bridge } = await fixture(t);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  platform.saveAdminSettings({ mode: "provider", publicUrl: "https://hardware.example.test", mailHost: "smtp.example.test", mailPort: 465,
    mailUser: "mailer", mailFrom: "mailer@example.test", mailPassword: "smtp-password", alipayAppId: "hardware-app",
    alipayPrivateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    alipayPublicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() });
  for (const owner of ["supplier", "too-long"]) database.prepare("INSERT INTO platform_users(id,email,created_at) VALUES(?,?,?)")
    .run(owner, `${owner}@example.test`, new Date().toISOString());
  assert.throws(() => platform.applyComputeProvider("too-long", "x".repeat(2001)), /2000/);
  const pending = platform.applyComputeProvider("supplier", "");
  assert.equal(pending.status, "pending");
  assert.equal(pending.description, "");
  assert.throws(() => platform.createRelayNode("supplier", "GPU node"), /开通/);
  platform.reviewComputeProvider("supplier", { status: "approved" });
  const node = platform.createRelayNode("supplier", "GPU node");
  const client = bridge();
  client.command({ cmd: "connect", url, password: node.token, hardware: inventory(), serverRunning: false });
  await until(() => client.connected && platform.listRelayNodes("supplier")[0].hardware !== null);
  assert.deepEqual(platform.listRelayNodes("supplier")[0].hardware, inventory());
});

test("bridge sends hardware detection that completes during authentication and resets inventory for the next connection", async t => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const messages: Array<Record<string, any>> = [];
  let pendingAuth: WebSocket | undefined;
  server.on("connection", socket => socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (message.type === "auth") pendingAuth = socket;
  }));
  const bridge = new CloudBridge();
  t.after(async () => {
    bridge.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  bridge.command({ cmd: "connect", url, password: "unused", serverRunning: false, modelName: "waiting" });
  await until(() => !!pendingAuth);
  assert.equal(messages[0].hardware, null);
  bridge.command({ cmd: "status_update", modelName: "updated while authenticating", serverRunning: false, slots: 2 });
  bridge.command({ cmd: "hardware_update", hardware: inventory() });
  assert.equal(messages.length, 1, "hardware waits for successful authentication");
  pendingAuth!.send(JSON.stringify({ type: "auth_ok", nodeId: "node" }));
  await until(() => messages.length === 2);
  assert.deepEqual(messages[1].hardware, inventory());
  assert.equal(messages[1].serverRunning, false);
  assert.equal(messages[1].modelName, "updated while authenticating");
  assert.equal(messages[1].slots, 2);
  bridge.disconnect();
  pendingAuth = undefined;
  messages.length = 0;
  bridge.command({ cmd: "connect", url, password: "unused" });
  await until(() => !!pendingAuth);
  assert.equal(messages[0].hardware, null);
});
