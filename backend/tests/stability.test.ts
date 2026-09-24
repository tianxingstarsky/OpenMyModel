import assert from "node:assert/strict";
import { test, TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { request as httpRequest, createServer, Server, IncomingMessage } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import Database from "better-sqlite3";
import { buildApp, AppOptions } from "../src/index";
import { ConfigStore } from "../src/config";
import { hashPassword, verifyPassword, verifyAdminPassword } from "../src/services/auth";
import { WebSocketTunnel } from "../src/services/websocket";
import { relayHeaders } from "../src/routes/openai";
import { createDatabase } from "../src/db/schema";
import { PlatformService } from "../src/services/platform";
import { getPlatformSecret, hashPlatformValue } from "../src/services/secrets";

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

test("database migration makes administrator sessions nullable and preserves existing sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-session-migration-"));
  const path = join(directory, "openmymodel.db");
  const oldDatabase = new Database(path);
  oldDatabase.exec(`CREATE TABLE platform_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE INDEX idx_platform_sessions_expiry ON platform_sessions(expires_at);
  INSERT INTO platform_sessions VALUES('existing-session', 'user-1', 'user', '2999-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);
  oldDatabase.close();
  const database = createDatabase(directory);
  try {
    const columns = database.sqlite.pragma("table_info(platform_sessions)") as Array<{ name: string; notnull: number }>;
    assert.equal(columns.find(column => column.name === "user_id")?.notnull, 0);
    assert.equal(database.sqlite.prepare("SELECT token_hash FROM platform_sessions WHERE token_hash='existing-session'").get()?.token_hash,
      "existing-session");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("personal mode exposes only its public dashboard and blocks provider signup until configured", async t => {
  const { app } = await fixture(t);
  const dashboard = await app.inject({ method: "GET", url: "/api/public/dashboard" });
  assert.equal(dashboard.statusCode, 200);
  assert.equal(dashboard.json().onlineNodes, 0);
  const crossOriginSignup = await app.inject({ method: "POST", url: "/api/auth/email-code",
    headers: { origin: "https://evil.example.test" }, payload: { email: "person@example.com", purpose: "register" } });
  assert.equal(crossOriginSignup.statusCode, 403, "browser auth actions reject cross-origin form submissions");
  const signup = await app.inject({ method: "POST", url: "/api/auth/email-code", payload: { email: "person@example.com", purpose: "register" } });
  assert.equal(signup.statusCode, 503);
  assert.match(signup.json().error, /服务商模式尚未启用/);

  const csrfLogin = await app.inject({ method: "POST", url: "/api/admin/login",
    headers: { origin: "https://evil.example.test" }, payload: { password: PASSWORD } });
  assert.equal(csrfLogin.statusCode, 403, "cross-origin login cannot place an authenticated session in another site");
  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const enable = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { cookie },
    payload: { mode: "provider" } });
  assert.equal(enable.statusCode, 400);
  assert.match(enable.json().error, /SMTP/);
  const config = await app.inject({ method: "GET", url: "/api/public/config" });
  assert.equal(config.json().mode, "personal");
});

test("provider dashboards, keys, usage and orders remain isolated between accounts", async t => {
  const { app, directory } = await fixture(t);
  const adminLogin = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  const adminCookie = String(adminLogin.headers["set-cookie"]).split(";", 1)[0];
  const personalKeyResponse = await app.inject({ method: "POST", url: "/api/admin/keys", headers: { cookie: adminCookie },
    payload: { name: "personal-global-key" } });
  assert.equal(personalKeyResponse.statusCode, 200);
  const personalKey = personalKeyResponse.json().key;
  const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alipayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const configured = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { cookie: adminCookie }, payload: {
    mode: "provider", publicUrl: "https://api.example.test", mailHost: "smtp.example.test", mailPort: 465,
    mailUser: "mail-user", mailFrom: "billing@example.test", mailPassword: "mail-pass",
    alipayAppId: "2026000000000001", alipaySellerId: "2088000000000000",
    alipayPrivateKey: appKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    alipayPublicKey: alipayKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  } });
  assert.equal(configured.statusCode, 200, configured.body);
  const csrfModel = await app.inject({ method: "POST", url: "/api/admin/models",
    headers: { cookie: adminCookie, origin: "https://evil.example.test", "content-type": "application/x-www-form-urlencoded" },
    payload: "publicName=csrf-model&inputPrice=0&outputPrice=0" });
  assert.equal(csrfModel.statusCode, 403, "cookie-authenticated admin writes reject cross-origin forms");
  const modelsAfterCsrf = await app.inject({ method: "GET", url: "/api/admin/models", headers: { cookie: adminCookie } });
  assert.equal(modelsAfterCsrf.json().some((model: Message) => model.publicName === "csrf-model"), false);
  const blockedPersonalKey = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${personalKey}` } });
  assert.equal(blockedPersonalKey.statusCode, 403);
  const orphanProviderKey = await app.inject({ method: "POST", url: "/api/admin/keys", headers: { cookie: adminCookie },
    payload: { name: "unowned-provider-key" } });
  assert.equal(orphanProviderKey.statusCode, 400);

  const database = new Database(join(directory, "openmymodel.db"));
  try {
    const createdAt = new Date().toISOString();
    database.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("user-alpha", "alpha@example.test", 12.5, createdAt);
    database.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("user-beta", "beta@example.test", 91, createdAt);
    database.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("user-gamma", "gamma@example.test", 0, createdAt);
    const knownRegister = await app.inject({ method: "POST", url: "/api/auth/email-code",
      payload: { email: "alpha@example.test", purpose: "register" } });
    const unknownLogin = await app.inject({ method: "POST", url: "/api/auth/email-code",
      payload: { email: "unknown@example.test", purpose: "login" } });
    assert.equal(knownRegister.statusCode, 200);
    assert.equal(unknownLogin.statusCode, 200);
    assert.deepEqual(knownRegister.json(), unknownLogin.json(), "email-code responses must not disclose account existence");
    const sessions = new PlatformService(database, directory, new WebSocketTunnel({ authenticate: async () => "ok" }));
    const alphaCookie = `omm_session=${sessions.createSession("user", "user-alpha")}`;
    const betaCookie = `omm_session=${sessions.createSession("user", "user-beta")}`;
    const gammaCookie = `omm_session=${sessions.createSession("user", "user-gamma")}`;
    const adjustmentWithoutReason = await app.inject({ method: "PATCH", url: "/api/admin/users/user-beta",
      headers: { cookie: adminCookie }, payload: { balance: 92 } });
    assert.equal(adjustmentWithoutReason.statusCode, 400);
    assert.equal(database.prepare("SELECT balance FROM platform_users WHERE id='user-beta'").get()?.balance, 91,
      "invalid support adjustments must leave the balance unchanged");
    const adjustment = await app.inject({ method: "PATCH", url: "/api/admin/users/user-beta",
      headers: { cookie: adminCookie }, payload: { balance: 92, reason: "客服补偿测试" } });
    assert.equal(adjustment.statusCode, 200);
    const betaBalanceEntries = await app.inject({ method: "GET", url: "/api/admin/users/user-beta/balance-entries",
      headers: { cookie: adminCookie } });
    assert.equal(betaBalanceEntries.json().length, 1);
    assert.deepEqual([betaBalanceEntries.json()[0].type, betaBalanceEntries.json()[0].amount,
      betaBalanceEntries.json()[0].balanceAfter, betaBalanceEntries.json()[0].actor], ["adjustment", 1, 92, "admin"]);
    const csrfUserKey = await app.inject({ method: "POST", url: "/api/user/keys",
      headers: { cookie: alphaCookie, origin: "https://evil.example.test", "content-type": "application/x-www-form-urlencoded" },
      payload: "name=csrf-key&rpmLimit=0&tokenLimit=0" });
    assert.equal(csrfUserKey.statusCode, 403, "cookie-authenticated user writes reject cross-origin forms");
    const alphaKeyResponse = await app.inject({ method: "POST", url: "/api/user/keys",
      headers: { cookie: alphaCookie, origin: "https://api.example.test" },
      payload: { name: "alpha-private", rpmLimit: 2, tokenLimit: 100 } });
    const betaKeyResponse = await app.inject({ method: "POST", url: "/api/user/keys", headers: { cookie: betaCookie }, payload: { name: "beta-private" } });
    assert.equal(alphaKeyResponse.statusCode, 200);
    assert.equal(betaKeyResponse.statusCode, 200);
    const alphaKey = alphaKeyResponse.json();
    const betaKey = betaKeyResponse.json();
    assert.deepEqual([alphaKey.rpmLimit, alphaKey.tokenLimit], [2, 100]);
    assert.equal("ownerEmail" in alphaKey, false, "a user's key response must not include another account's owner details");
    const adminKeys = await app.inject({ method: "GET", url: "/api/admin/keys", headers: { cookie: adminCookie } });
    assert.equal(adminKeys.json().find((key: Message) => key.id === alphaKey.id).ownerEmail, "alpha@example.test");
    assert.equal(adminKeys.json().find((key: Message) => key.id === betaKey.id).ownerEmail, "beta@example.test");
    const updatedByOwner = await app.inject({ method: "PATCH", url: `/api/user/keys/${alphaKey.id}`, headers: { cookie: alphaCookie },
      payload: { rpmLimit: 7, tokenLimit: 250 } });
    assert.equal(updatedByOwner.statusCode, 200, updatedByOwner.body);
    assert.deepEqual([updatedByOwner.json().rpmLimit, updatedByOwner.json().tokenLimit], [7, 250]);
    assert.equal(updatedByOwner.body.includes(alphaKey.key), false, "changing key limits never returns the secret");
    const foreignKeyLimitUpdate = await app.inject({ method: "PATCH", url: `/api/user/keys/${betaKey.id}`, headers: { cookie: alphaCookie },
      payload: { rpmLimit: 1, tokenLimit: 1 } });
    assert.equal(foreignKeyLimitUpdate.statusCode, 404, "a user cannot inspect or edit another account's key");
    assert.deepEqual([foreignKeyLimitUpdate.json().error,
      (await app.inject({ method: "GET", url: "/api/user/keys", headers: { cookie: betaCookie } })).json()[0].rpmLimit],
      ["API Key not found", 0]);
    const concurrentKeyCreations = await Promise.all(Array.from({ length: 21 }, (_, index) => app.inject({
      method: "POST", url: "/api/user/keys", headers: { cookie: gammaCookie }, payload: { name: `gamma-${index}` },
    })));
    assert.equal(concurrentKeyCreations.filter(response => response.statusCode === 200).length, 20);
    assert.equal(concurrentKeyCreations.filter(response => response.statusCode === 400).length, 1,
      "the active key ceiling stays enforced when requests arrive concurrently");
    const updatedAlphaKey = await app.inject({ method: "PATCH", url: `/api/admin/keys/${alphaKey.id}`, headers: { cookie: adminCookie },
      payload: { rpmLimit: 7, tokenLimit: 250 } });
    assert.equal(updatedAlphaKey.statusCode, 200, updatedAlphaKey.body);
    assert.equal(updatedAlphaKey.json().rpmLimit, 7);
    assert.equal(updatedAlphaKey.json().tokenLimit, 250);
    assert.equal(updatedAlphaKey.body.includes(alphaKey.key), false, "updating key limits never returns the secret");

    const timestamp = new Date().toISOString();
    const addUsage = database.prepare(`INSERT INTO usage_logs(api_key_id,model,endpoint,prompt_tokens,completion_tokens,total_tokens,
      timestamp,ip,user_agent,cost) VALUES(?,?,?,?,?,?,?,?,?,?)`);
    addUsage.run(alphaKey.id, "alpha-model", "/v1/chat/completions", 3, 4, 7, timestamp, "192.0.2.1", "alpha-client", 0.01);
    addUsage.run(betaKey.id, "beta-model", "/v1/chat/completions", 30, 40, 70, timestamp, "198.51.100.1", "beta-client", 0.1);
    const addEvent = database.prepare("INSERT INTO gateway_request_events(key_id,created_at) VALUES(?,?)");
    addEvent.run(alphaKey.id, timestamp);
    addEvent.run(betaKey.id, timestamp);
    database.prepare("INSERT INTO payment_orders(id,user_id,amount,status,description,created_at) VALUES(?,?,?,?,?,?)")
      .run("ORDER-ALPHA", "user-alpha", 5, "paid", "alpha order", timestamp);
    database.prepare("INSERT INTO payment_orders(id,user_id,amount,status,description,created_at) VALUES(?,?,?,?,?,?)")
      .run("ORDER-BETA", "user-beta", 9, "paid", "beta order", timestamp);

    const get = async (path: string) => app.inject({ method: "GET", url: path, headers: { cookie: alphaCookie } });
    const alphaBalanceEntries = await get("/api/user/balance-entries?userId=user-beta");
    assert.deepEqual(alphaBalanceEntries.json(), [], "balance history must always be scoped to the signed-in account");
    const betaOwnBalanceEntries = await app.inject({ method: "GET", url: "/api/user/balance-entries",
      headers: { cookie: betaCookie } });
    assert.deepEqual(betaOwnBalanceEntries.json().map((entry: Message) => entry.description), ["客服补偿测试"]);
    const userLimitEdit = await app.inject({ method: "PATCH", url: `/api/admin/keys/${betaKey.id}`, headers: { cookie: alphaCookie },
      payload: { rpmLimit: 1, tokenLimit: 1 } });
    assert.equal(userLimitEdit.statusCode, 401, "provider accounts cannot use administrator key controls");
    const alphaKeys = await get("/api/user/keys");
    assert.equal(alphaKeys.json().find((key: Message) => key.id === alphaKey.id).rpmLimit, 7);
    assert.equal(alphaKeys.json().find((key: Message) => key.id === alphaKey.id).tokenLimit, 250);
    const dashboard = await get("/api/user/dashboard?userId=user-beta");
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.json().user.email, "alpha@example.test");
    assert.equal(dashboard.json().user.balance, 12.5);
    assert.deepEqual(dashboard.json().keys.map((key: Message) => key.name), ["alpha-private"]);
    assert.deepEqual(dashboard.json().usage.map((row: Message) => row.model), ["alpha-model"]);
    assert.equal(dashboard.json().requestsPerMinute, 1);
    assert.equal(dashboard.body.includes("beta@example.test"), false);
    assert.equal(dashboard.body.includes("beta-private"), false);

    const keys = await get("/api/user/keys");
    assert.deepEqual(keys.json().map((key: Message) => key.name), ["alpha-private"]);
    const usage = await get("/api/user/usage?limit=100&userId=user-beta");
    assert.deepEqual(usage.json().map((row: Message) => row.model), ["alpha-model"]);
    assert.equal(usage.body.includes("beta-model"), false);
    const invalidLimit = await get("/api/user/usage?limit=not-a-number");
    assert.equal(invalidLimit.statusCode, 200);
    assert.deepEqual(invalidLimit.json().map((row: Message) => row.model), ["alpha-model"]);
    const orders = await get("/api/user/orders?userId=user-beta");
    assert.deepEqual(orders.json().map((order: Message) => order.id), ["ORDER-ALPHA"]);

    const adminUsage = await app.inject({ method: "GET", url: "/api/admin/usage?limit=100&userId=user-alpha", headers: { cookie: adminCookie } });
    assert.equal(adminUsage.statusCode, 200);
    assert.deepEqual(adminUsage.json().map((row: Message) => [row.model, row.user_email]), [["alpha-model", "alpha@example.test"]]);
    const adminInvalidLimit = await app.inject({ method: "GET", url: "/api/admin/usage?limit=not-a-number", headers: { cookie: adminCookie } });
    assert.equal(adminInvalidLimit.statusCode, 200);
    const userAdminUsage = await app.inject({ method: "GET", url: "/api/admin/usage?userId=user-beta", headers: { cookie: alphaCookie } });
    assert.equal(userAdminUsage.statusCode, 401);

    const foreignDelete = await app.inject({ method: "DELETE", url: `/api/user/keys/${betaKey.id}`, headers: { cookie: alphaCookie } });
    assert.equal(foreignDelete.statusCode, 200);
    assert.equal(foreignDelete.json().ok, false);
    const betaKeysAfter = await app.inject({ method: "GET", url: "/api/user/keys", headers: { cookie: betaCookie } });
    assert.equal(betaKeysAfter.json()[0].active, true);

    const spoofedKey = await app.inject({ method: "POST", url: "/api/user/keys", headers: { cookie: alphaCookie },
      payload: { name: "still-alpha", userId: "user-beta" } });
    assert.equal(spoofedKey.statusCode, 200);
    assert.equal(database.prepare("SELECT owner_user_id FROM gateway_keys WHERE id=?").get(spoofedKey.json().id)?.owner_user_id, "user-alpha");
    const spoofedOrder = await app.inject({ method: "POST", url: "/api/user/orders", headers: { cookie: alphaCookie },
      payload: { amount: 2, userId: "user-beta" } });
    assert.equal(spoofedOrder.statusCode, 200);
    assert.equal(database.prepare("SELECT user_id FROM payment_orders WHERE id=?").get(spoofedOrder.json().orderId)?.user_id, "user-alpha");
    const injectedHostOrder = await app.inject({ method: "POST", url: "/api/user/orders",
      headers: { cookie: alphaCookie, host: "attacker.example.test" }, payload: { amount: 2 } });
    assert.equal(injectedHostOrder.statusCode, 200);
    const checkout = new URL(injectedHostOrder.json().paymentUrl);
    assert.equal(checkout.searchParams.get("notify_url"), "https://api.example.test/api/payments/alipay/notify");
    assert.equal(checkout.searchParams.get("return_url"), "https://api.example.test/console?payment=return");
    const unauthenticated = await app.inject({ method: "GET", url: "/api/user/dashboard" });
    assert.equal(unauthenticated.statusCode, 401);
    const unauthenticatedBalanceEntries = await app.inject({ method: "GET", url: "/api/user/balance-entries" });
    assert.equal(unauthenticatedBalanceEntries.statusCode, 401);
    const personalMode = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { cookie: adminCookie }, payload: { mode: "personal" } });
    assert.equal(personalMode.statusCode, 200);
    const blockedProviderKey = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${alphaKey.key}` } });
    assert.equal(blockedProviderKey.statusCode, 403);
  } finally {
    database.close();
  }
});

test("provider email codes are single-use and lock after five failed attempts", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-email-code-test-"));
  const database = createDatabase(directory);
  try {
    const settings = database.sqlite.prepare("INSERT INTO platform_settings(key, value) VALUES(?, ?)");
    for (const [key, value] of Object.entries({
      mode: "provider", public_url: "https://api.example.test", mail_host: "smtp.example.test", mail_port: "465", mail_user: "mailer",
      mail_from: "support@example.test", mail_password: "encrypted-placeholder", alipay_app_id: "app",
      alipay_seller_id: "seller", alipay_private_key: "private", alipay_public_key: "public",
    })) settings.run(key, value);

    const now = new Date().toISOString();
    const secret = getPlatformSecret(directory);
    const addUser = database.sqlite.prepare("INSERT INTO platform_users(id, email, created_at) VALUES(?, ?, ?)");
    addUser.run("user-code-valid", "code-valid@example.test", now);
    addUser.run("user-code-locked", "code-locked@example.test", now);
    const addCode = database.sqlite.prepare(`INSERT INTO email_codes(id, email, purpose, code_hash, expires_at, created_at)
      VALUES(?, ?, 'login', ?, ?, ?)`);
    const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
    addCode.run("code-valid", "code-valid@example.test",
      hashPlatformValue("code-valid@example.test\nlogin\n123456", secret), expiry, now);
    addCode.run("code-locked", "code-locked@example.test",
      hashPlatformValue("code-locked@example.test\nlogin\n123456", secret), expiry, now);

    const platform = new PlatformService(database.sqlite, directory,
      new WebSocketTunnel({ authenticate: async () => "ok" }));
    const session = platform.loginWithCode("code-valid@example.test", "login", "123456");
    assert.equal(platform.getSession(session.token)?.userId, "user-code-valid");
    assert.throws(() => platform.loginWithCode("code-valid@example.test", "login", "123456"), /验证码无效/);
    const consumed = database.sqlite.prepare("SELECT attempts, consumed_at FROM email_codes WHERE id='code-valid'").get() as
      { attempts: number; consumed_at: string | null };
    assert.equal(consumed.attempts, 1);
    assert.ok(consumed.consumed_at);

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.throws(() => platform.loginWithCode("code-locked@example.test", "login", "999999"), /验证码无效/);
    }
    assert.throws(() => platform.loginWithCode("code-locked@example.test", "login", "123456"), /验证码无效/);
    const locked = database.sqlite.prepare("SELECT attempts, consumed_at FROM email_codes WHERE id='code-locked'").get() as
      { attempts: number; consumed_at: string | null };
    assert.equal(locked.attempts, 5);
    assert.equal(locked.consumed_at, null);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Alipay settings validate RSA keys and official signed callback fields credit an order once", async t => {
  const { app, directory, tunnel } = await fixture(t);
  const database = createDatabase(directory);
  try {
    const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const alipayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const appPrivateKey = appKeys.privateKey.export({ type: "pkcs1", format: "der" }).toString("base64");
    const alipayPrivateKey = alipayKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const alipayPublicKey = alipayKeys.publicKey.export({ type: "pkcs1", format: "der" }).toString("base64");
    const platform = new PlatformService(database.sqlite, directory, tunnel, "https://api.example.test");
    assert.throws(() => platform.saveAdminSettings({
      mode: "provider", publicUrl: "http://api.example.test", mailHost: "smtp.example.test", mailPort: 465,
      mailUser: "mail-user", mailFrom: "billing@example.test", mailPassword: "mail-pass",
      alipayAppId: "2026000000000001", alipaySellerId: "2088000000000000",
      alipayPrivateKey: appPrivateKey, alipayPublicKey,
    }), /HTTPS 公网地址/);
    assert.equal(platform.getPublicConfig().mode, "personal", "an insecure or incomplete provider setup must not appear enabled");
    database.sqlite.prepare("DELETE FROM platform_settings WHERE key='alipay_seller_id'").run();
    assert.throws(() => platform.saveAdminSettings({
      mode: "provider", publicUrl: "https://api.example.test", mailHost: "smtp.example.test", mailPort: 465, mailUser: "mail-user",
      mailFrom: "billing@example.test", mailPassword: "mail-pass", alipayAppId: "2026000000000001",
      alipayPrivateKey: appPrivateKey, alipayPublicKey,
    }), /支付宝/);
    const settings = platform.saveAdminSettings({
      mode: "provider", publicUrl: "https://api.example.test", mailHost: "smtp.example.test", mailPort: 465, mailUser: "mail-user",
      mailFrom: "billing@example.test", mailPassword: "mail-pass", alipayAppId: "2026000000000001",
      alipaySellerId: "2088000000000000", alipayPrivateKey: appPrivateKey, alipayPublicKey,
    });
    assert.equal(settings.providerReady, true);

    const userId = "payer-1";
    database.sqlite.prepare("INSERT INTO platform_users(id, email, created_at) VALUES(?, ?, ?)")
      .run(userId, "payer@example.test", new Date().toISOString());
    const order = platform.createOrder(userId, 10, "https://api.example.test/console?payment=return");
    const payment = new URL(order.paymentUrl);
    assert.equal(payment.searchParams.get("app_id"), "2026000000000001");
    assert.equal(payment.searchParams.get("notify_url"), "https://api.example.test/api/payments/alipay/notify");
    const paymentFields = Object.fromEntries(payment.searchParams.entries());
    const paymentSignature = paymentFields.sign;
    delete paymentFields.sign;
    const paymentCanonical = Object.keys(paymentFields).sort().map(key => `${key}=${paymentFields[key]}`).join("&");
    assert.equal(createVerify("RSA-SHA256").update(paymentCanonical).verify(appKeys.publicKey, paymentSignature, "base64"), true);

    const signNotification = (fields: Record<string, string>) => ({ ...fields,
      sign: createSign("RSA-SHA256").update(Object.keys(fields).filter(key => key !== "sign_type").sort()
        .map(key => `${key}=${fields[key]}`).join("&"))
        .sign(alipayPrivateKey, "base64") });
    const notification = signNotification({ app_id: "2026000000000001",
      seller_id: "2088000000000000", sign_type: "RSA2", notify_type: "trade_status_sync", notify_id: "notify-1",
      notify_time: "2026-09-24 12:00:00", charset: "utf-8", version: "1.0", out_trade_no: order.orderId,
      total_amount: "10.00", trade_status: "TRADE_SUCCESS", trade_no: "2026092400000001" });
    const callback = () => app.inject({ method: "POST", url: "/api/payments/alipay/notify",
      headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(notification).toString() });
    const firstCallback = await callback();
    assert.equal(firstCallback.statusCode, 200, firstCallback.body);
    assert.equal(firstCallback.body, "success", "Alipay receives the success acknowledgement");
    const duplicateCallback = await callback();
    assert.equal(duplicateCallback.statusCode, 200, "duplicate notifications must be acknowledged");
    assert.equal((database.sqlite.prepare("SELECT balance FROM platform_users WHERE id=?").get(userId) as { balance: number }).balance, 10);
    const topups = platform.balanceEntries(userId) as Array<Message>;
    assert.equal(topups.length, 1, "duplicate Alipay notifications must not duplicate balance ledger entries");
    assert.deepEqual([topups[0].type, topups[0].amount, topups[0].balanceAfter, topups[0].referenceId],
      ["topup", 10, 10, order.orderId]);
    assert.equal(platform.processAlipayNotification(signNotification({ app_id: "2026000000000001", auth_app_id: "different-app",
      seller_id: "2088000000000000", sign_type: "RSA2", notify_type: "trade_status_sync", out_trade_no: order.orderId,
      total_amount: "10.00", trade_status: "TRADE_SUCCESS", trade_no: "2026092400000001" })), false,
    "an optional auth_app_id is checked when Alipay includes it");
    assert.equal(platform.processAlipayNotification(signNotification({ app_id: "2026000000000001",
      seller_id: "2088000000000000", sign_type: "RSA2", notify_type: "trade_status_sync", out_trade_no: order.orderId,
      total_amount: "100.00", trade_status: "TRADE_SUCCESS", trade_no: "2026092400000001" })), false,
    "signed callbacks with an amount that does not match the order must be rejected");
    assert.equal(platform.processAlipayNotification(signNotification({ app_id: "2026000000000001",
      seller_id: "wrong-seller", sign_type: "RSA2", notify_type: "trade_status_sync", out_trade_no: order.orderId,
      total_amount: "10.00", trade_status: "TRADE_SUCCESS", trade_no: "2026092400000001" })), false,
    "notifications for another seller must be rejected");
  } finally {
    database.close();
  }
});

test("provider usage reservations serialize balance holds and settle on actual token usage", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-reservation-test-"));
  const database = createDatabase(directory);
  try {
    const setting = database.sqlite.prepare("INSERT INTO platform_settings(key,value) VALUES(?,?)");
    for (const [name, value] of [
      ["mode", "provider"], ["public_url", "https://api.example.test"], ["mail_host", "smtp.example.test"], ["mail_port", "465"], ["mail_user", "mail-user"],
      ["mail_from", "billing@example.test"], ["mail_password", "configured"], ["alipay_app_id", "app"],
      ["alipay_seller_id", "seller"], ["alipay_private_key", "configured"], ["alipay_public_key", "configured"],
    ]) setting.run(name, value);
    database.sqlite.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("reserve-user", "reserve@example.test", 0.00001, new Date().toISOString());
    database.sqlite.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("other-user", "other@example.test", 0.00001, new Date().toISOString());
    const platform = new PlatformService(database.sqlite, directory, new WebSocketTunnel({ authenticate: async () => "ok" }));
    const key = platform.createUserKey("reserve-user", "reserve test");
    const otherKey = platform.createUserKey("other-user", "other reserve test");
    const gatewayKey = platform.findGatewayKey(key.key)!;
    const otherGatewayKey = platform.findGatewayKey(otherKey.key)!;

    const reservation = platform.reserveProviderUsage(gatewayKey.id, 5, undefined, 1, 1, 1);
    assert.equal(reservation.maxTokens, 5, "omitted output limits are capped to what the balance can cover");
    assert.equal(reservation.reservedCost, 0.00001);
    const otherReservation = platform.reserveProviderUsage(otherGatewayKey.id, 5, undefined, 1, 1, 1);
    assert.equal(otherReservation.reservedCost, 0.00001, "one account's hold cannot reduce another account's available balance");
    assert.throws(() => platform.reserveProviderUsage(gatewayKey.id, 5, 1, 1, 1, 1),
      (error: any) => error.statusCode === 402, "concurrent calls cannot reserve the same balance twice");
    assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS count FROM provider_usage_reservations").get() as any).count, 2);

    platform.recordUsage(gatewayKey.id, "reserve-model", "/v1/chat/completions", 5, 3, "127.0.0.1", "test", 1, 1, reservation.id);
    assert.equal((database.sqlite.prepare("SELECT balance FROM platform_users WHERE id='reserve-user'").get() as any).balance, 0.000002);
    assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS count FROM provider_usage_reservations").get() as any).count, 1,
      "settlement releases the unused portion of a reservation");
    assert.equal((database.sqlite.prepare("SELECT cost FROM usage_logs").get() as any).cost, 0.000008);
    const usageEntries = platform.balanceEntries("reserve-user") as Array<Message>;
    assert.equal(usageEntries.length, 1);
    assert.deepEqual([usageEntries[0].type, usageEntries[0].amount, usageEntries[0].balanceAfter],
      ["usage", -0.000008, 0.000002]);
    assert.equal((database.sqlite.prepare("SELECT balance FROM platform_users WHERE id='other-user'").get() as any).balance, 0.00001);
    platform.releaseProviderUsage(otherReservation.id);
    assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS count FROM provider_usage_reservations").get() as any).count, 0);

    database.sqlite.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("quota-user", "quota@example.test", 1, new Date().toISOString());
    const quotaKey = platform.findGatewayKey(platform.createUserKey("quota-user", "token cap", 8, 0).key)!;
    const quota = platform.reserveProviderUsage(quotaKey.id, 5, undefined, 1, 1, 1);
    assert.equal(quota.maxTokens, 3, "provider output is capped by the key token limit");
    assert.ok(quota.tokenReservationId);
    assert.equal((database.sqlite.prepare("SELECT reserved_tokens FROM gateway_token_reservations WHERE id=?")
      .get(quota.tokenReservationId) as { reserved_tokens: number }).reserved_tokens, 8);
    assert.throws(() => platform.reserveProviderUsage(quotaKey.id, 1, 1, 1, 1, 1),
      (error: any) => error.statusCode === 429, "provider key reservations also include in-flight token usage");
    platform.recordUsage(quotaKey.id, "quota-model", "/v1/chat/completions", 5, 2, "127.0.0.1", "test", 1, 1,
      quota.id, quota.tokenReservationId);
    assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS count FROM gateway_token_reservations").get() as any).count, 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("gateway token limits reserve concurrent prompt and output budgets atomically", () => {
  const directory = mkdtempSync(join(tmpdir(), "openmymodel-token-reservation-test-"));
  const database = createDatabase(directory);
  try {
    const platform = new PlatformService(database.sqlite, directory, new WebSocketTunnel({ authenticate: async () => "ok" }));
    const created = platform.createGatewayKey("limited gateway key", null, 100, 0);
    const key = platform.findGatewayKey(created.key)!;

    const first = platform.reserveGatewayTokenUsage(key.id, 20, 50, 1);
    const second = platform.reserveGatewayTokenUsage(key.id, 20, 50, 1);
    assert.equal(first.maxTokens, 50);
    assert.equal(second.maxTokens, 10, "the second request is capped by the tokens left after the first reservation");
    assert.equal((database.sqlite.prepare("SELECT SUM(reserved_tokens) AS total FROM gateway_token_reservations")
      .get() as { total: number }).total, 100);
    assert.throws(() => platform.reserveGatewayTokenUsage(key.id, 1, 1, 1),
      (error: any) => error.statusCode === 429, "parallel requests cannot reserve beyond a key's cumulative token limit");

    platform.recordUsage(key.id, "limited-model", "/v1/chat/completions", 20, 40, "127.0.0.1", "test",
      0, 0, undefined, first.id);
    platform.recordUsage(key.id, "limited-model", "/v1/chat/completions", 20, 10, "127.0.0.1", "test",
      0, 0, undefined, second.id);
    assert.equal((database.sqlite.prepare("SELECT total_tokens FROM gateway_keys WHERE id=?").get(key.id) as { total_tokens: number }).total_tokens, 90);
    assert.equal((database.sqlite.prepare("SELECT COUNT(*) AS count FROM gateway_token_reservations").get() as { count: number }).count, 0);
    assert.throws(() => platform.reserveGatewayTokenUsage(key.id, 11, 1, 1),
      (error: any) => error.statusCode === 429, "settled usage is included in later quota checks");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
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

test("managed route rotation is independent for each public model", async t => {
  const { app, node, post } = await fixture(t);
  const requests = new Map<string, Array<{ model: string; key: string }>>();
  const respond = (nodeId: string) => (msg: Message, send: (message: Message) => void) => {
    if (msg.type !== "http_relay" || msg.path !== "/v1/chat/completions") return;
    const body = JSON.parse(msg.body);
    const received = requests.get(nodeId) ?? [];
    received.push({ model: body.model, key: msg.upstreamApiKey });
    requests.set(nodeId, received);
    send(headers(msg.requestId, 200));
    send({ type: "http_chunk", requestId: msg.requestId, data: JSON.stringify({
      choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }) });
    send({ type: "http_done", requestId: msg.requestId });
  };
  await node({ nodeId: "route-a", modelName: "internal-a" }, respond("route-a"));
  await node({ nodeId: "route-b", modelName: "internal-b" }, respond("route-b"));
  await node({ nodeId: "route-other", modelName: "internal-other" }, respond("route-other"));

  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const adminHeaders = { cookie, "content-type": "application/json" };
  const createModel = async (publicName: string) => {
    const response = await app.inject({ method: "POST", url: "/api/admin/models", headers: adminHeaders,
      payload: { publicName, inputPrice: 0, outputPrice: 0 } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().id as string;
  };
  const modelA = await createModel("public-a");
  const modelB = await createModel("public-b");
  for (const route of [
    { modelId: modelA, nodeId: "route-a", upstreamModel: "internal-a", upstreamKey: "node-key-a", weight: 2 },
    { modelId: modelA, nodeId: "route-b", upstreamModel: "internal-b", upstreamKey: "node-key-b" },
    { modelId: modelB, nodeId: "route-other", upstreamModel: "internal-other", upstreamKey: "node-key-other" },
  ]) {
    const response = await app.inject({ method: "POST", url: `/api/admin/models/${route.modelId}/routes`, headers: adminHeaders,
      payload: { nodeId: route.nodeId, upstreamModel: route.upstreamModel, upstreamKey: route.upstreamKey, weight: route.weight ?? 1 } });
    assert.equal(response.statusCode, 200, response.body);
  }
  const keyResponse = await app.inject({ method: "POST", url: "/api/admin/keys", headers: adminHeaders,
    payload: { name: "scheduler test" } });
  assert.equal(keyResponse.statusCode, 200, keyResponse.body);
  const gatewayKey = keyResponse.json().key as string;

  const call = async (model: string) => {
    const response = await post({ model, messages: [{ role: "user", content: "hello" }] }, gatewayKey).response;
    assert.equal(response.statusCode, 200);
    await text(response);
  };
  await call("public-a");
  await call("public-b");
  await call("public-a");

  assert.deepEqual(requests.get("route-a"), [
    { model: "internal-a", key: "node-key-a" }, { model: "internal-a", key: "node-key-a" },
  ], "the intervening request to another model must not advance this model's 2:1 route cycle");
  assert.equal(requests.has("route-b"), false, "the lower-weight route is selected on the third request for its model");
  assert.deepEqual(requests.get("route-other"), [{ model: "internal-other", key: "node-key-other" }]);
  await call("public-a");
  assert.deepEqual(requests.get("route-b"), [{ model: "internal-b", key: "node-key-b" }]);
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

test("admin node management keeps disconnected nodes visible with their last reported model", async t => {
  const { app, node, tunnel } = await fixture(t);
  const connected = await node({ nodeId: "retained-node", nodeName: "Retained node", modelName: "last-model" });
  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];

  const model = await app.inject({ method: "POST", url: "/api/admin/models", headers: { cookie },
    payload: { publicName: "retained-model", inputPrice: 0, outputPrice: 0 } });
  assert.equal(model.statusCode, 200);
  const route = await app.inject({ method: "POST", url: `/api/admin/models/${model.json().id}/routes`, headers: { cookie },
    payload: { nodeId: "retained-node", upstreamModel: "last-model", upstreamKey: "node-secret" } });
  assert.equal(route.statusCode, 200, route.body);

  const online = await app.inject({ method: "GET", url: "/api/admin/nodes", headers: { cookie } });
  assert.deepEqual(online.json().map((entry: Message) => [entry.id, entry.isOnline, entry.serverRunning, entry.modelName]),
    [["retained-node", true, true, "last-model"]]);

  connected.socket.close();
  await until(() => tunnel.getOnlineNodes().length === 0);
  const offline = await app.inject({ method: "GET", url: "/api/admin/nodes", headers: { cookie } });
  assert.deepEqual(offline.json().map((entry: Message) => [entry.id, entry.isOnline, entry.serverRunning, entry.modelName]),
    [["retained-node", false, false, "last-model"]]);
  const offlineModels = await app.inject({ method: "GET", url: "/api/admin/models", headers: { cookie } });
  assert.deepEqual(offlineModels.json()[0].routes.map((entry: Message) => [entry.nodeName, entry.nodeModel, entry.nodeOnline]),
    [["Retained node", "last-model", false]]);
});

test("production CloudBridge E2E preserves split UTF-8 SSE, upstream errors, auth, and cancellation", async t => {
  const { CloudBridge } = require("../../scripts/cloud_bridge.js");
  const { app, url, post, tunnel } = await fixture(t);
  let mode = "stream";
  let expectedAuthorization = "Bearer llama-secret";
  let upstreamClosed = false;
  const upstream = createServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, expectedAuthorization);
    assert.equal(req.headers["accept-encoding"], "identity");
    req.resume();
    req.on("end", () => {
      if (mode === "error") { res.writeHead(429, { "content-type": "text/plain", "retry-after": "3" }); res.end("limited\n"); return; }
      if (mode === "usage") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "measured" } }], usage: { prompt_tokens: 13, completion_tokens: 5 } }));
        return;
      }
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
  const anonymousModels = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(anonymousModels.statusCode, 401, "model discovery must require a valid node or gateway key");
  const invalidModels = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer invalid-key" } });
  assert.equal(invalidModels.statusCode, 401, "an invalid key cannot enumerate node models");
  const directModels = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: "Bearer llama-secret" } });
  assert.equal(directModels.statusCode, 200);
  assert.deepEqual(directModels.json().data.map((model: Message) => model.id), ["model-a"]);
  const streamed = await post('{ "stream" : true, "model": "model-a" }').response;
  assert.equal(await text(streamed), 'data: {"text":"\u4f60\u597d  "}\n\n');
  const directNodeKey = await post({ stream: true, model: "model-a" }, "llama-secret").response;
  assert.equal(directNodeKey.statusCode, 200, "personal mode accepts the configured node key for direct-node access");
  assert.equal(await text(directNodeKey), 'data: {"text":"\u4f60\u597d  "}\n\n');
  mode = "usage";
  const measuredDirect = await post({ model: "model-a" }, "llama-secret").response;
  assert.equal(measuredDirect.statusCode, 200);
  await text(measuredDirect);
  const publicDashboard = await app.inject({ method: "GET", url: "/api/public/dashboard" });
  assert.equal(publicDashboard.statusCode, 200);
  assert.deepEqual([publicDashboard.json().requests, publicDashboard.json().input, publicDashboard.json().output], [3, 13, 5],
    "the public dashboard includes token usage reported for node-key calls routed through the gateway");
  const adminLogin = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  const adminCookie = String(adminLogin.headers["set-cookie"]).split(";", 1)[0];
  const directUsage = await app.inject({ method: "GET", url: "/api/admin/usage", headers: { cookie: adminCookie } });
  const directUsageRow = directUsage.json().find((row: Message) => row.prompt_tokens === 13);
  assert.equal(directUsageRow.key_name, "节点 Key 直连");
  assert.match(directUsageRow.api_key_id, /^direct-[a-f0-9]{40}$/);
  mode = "override";
  expectedAuthorization = "Bearer managed-node-secret";
  let relayStatus = 0;
  let relayBody = "";
  await tunnel.relayHttp(tunnel.routeToNode("production-bridge"), {
    path: "/v1/chat/completions", body: "{}", upstreamApiKey: "managed-node-secret",
  }, { onHeaders: status => { relayStatus = status; }, onChunk: chunk => { relayBody += chunk; } });
  assert.equal(relayStatus, 200);
  assert.match(relayBody, /你好/);
  mode = "error";
  expectedAuthorization = "Bearer llama-secret";
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

test("public status page aggregates slots, concurrency and throughput without sensitive fields", async t => {
  const { app, node, post } = await fixture(t);
  const relay = (msg: Message, send: (m: Message) => void) => {
    keyOwner(msg, send);
    if (msg.type === "http_relay") {
      send(headers(msg.requestId));
      send({ type: "http_chunk", requestId: msg.requestId, data: "data: {\"t\":\"one\"}\n\n" });
      send({ type: "http_chunk", requestId: msg.requestId, data: "data: {\"t\":\"two\"}\n\n" });
      send({ type: "http_done", requestId: msg.requestId });
    }
  };
  await node({ slots: 4 }, relay);
  for (let i = 0; i < 2; i++) {
    const response = await post().response;
    assert.equal(await text(response), 'data: {"t":"one"}\n\ndata: {"t":"two"}\n\n');
  }
  const status = await app.inject({ method: "GET", url: "/status.json" });
  assert.equal(status.statusCode, 200);
  const data = status.json();
  assert.equal(data.totals.nodesOnline, 1);
  assert.equal(data.totals.capacitySlots, 4);
  assert.equal(data.totals.activeRequests, 0);
  assert.equal(data.totals.totalRequests, 2);
  assert.ok(data.totals.totalBytes > 0, "relayed bytes counted");
  assert.ok(data.totals.throughputBytesPerSec > 0, "EWMA throughput seeded");
  assert.equal(data.models.length, 1);
  assert.equal(data.models[0].model, "model-a");
  assert.equal(data.models[0].slots, 4);
  assert.equal(data.models[0].readyNodes, 1);
  assert.equal(data.models[0].totalRequests, 2);
  // No node identifiers in the public payload.
  assert.ok(!status.body.includes("node-1"));

  const page = await app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.ok(page.headers["content-type"].includes("text/html"));
  assert.ok(page.body.includes("服务状态"));
  assert.ok(page.body.includes("/status.json"));
  const api = await app.inject({ method: "GET", url: "/api" });
  assert.equal(api.json().endpoints.statusData, "/status.json");
});

test("status_update carries slots and legacy nodes report unknown capacity", async t => {
  const { app, tunnel, node } = await fixture(t);
  const handle = (msg: Message, send: (m: Message) => void) => {
    keyOwner(msg, send);
    if (msg.type === "http_relay") {
      send(headers(msg.requestId));
      send({ type: "http_done", requestId: msg.requestId });
    }
  };
  const legacy = await node({ modelName: "legacy-model" }, handle); // no slots
  let snapshot = tunnel.statusSnapshot();
  assert.equal(snapshot.totals.capacitySlots, null);
  assert.equal(snapshot.models[0].model, "legacy-model");
  assert.equal(snapshot.models[0].slots, null);
  legacy.send({ type: "status_update", modelName: "legacy-model", serverRunning: true, slots: 2 });
  await until(() => tunnel.statusSnapshot().totals.capacitySlots === 2);
  snapshot = tunnel.statusSnapshot();
  assert.equal(snapshot.models[0].slots, 2);
  legacy.send({ type: "status_update", modelName: "legacy-model", serverRunning: true, slots: "bogus" });
  await until(() => tunnel.getOnlineNodes()[0].slots === null);
  assert.equal(tunnel.statusSnapshot().totals.capacitySlots, null);
});

test("requests beyond slot capacity surface as queued; loading nodes contribute no capacity", async t => {
  const { app, tunnel, node, post } = await fixture(t);
  const pendingRelays: Array<() => void> = [];
  await node({ slots: 2, modelName: "queued-model" }, (msg, send) => {
    keyOwner(msg, send);
    if (msg.type === "http_relay") {
      pendingRelays.push(() => {
        send(headers(msg.requestId));
        send({ type: "http_done", requestId: msg.requestId });
      });
    }
  });
  const flights = Array.from({ length: 5 }, () => post({ model: "queued-model", messages: [] }));
  await until(() => tunnel.statusSnapshot().totals.activeRequests === 5);
  await until(() => pendingRelays.length === 5);
  let snapshot = tunnel.statusSnapshot();
  assert.equal(snapshot.totals.capacitySlots, 2);
  assert.equal(snapshot.totals.queuedRequests, 3, "5 in flight vs 2 slots -> 3 queued in the engine");
  assert.equal(snapshot.models[0].queued, 3);
  assert.equal(snapshot.models[0].readyNodes, 1);
  for (const release of pendingRelays) release();
  await Promise.all(flights.map(flight => flight.response.then(text)));
  await until(() => tunnel.statusSnapshot().totals.activeRequests === 0);
  snapshot = tunnel.statusSnapshot();
  assert.equal(snapshot.totals.queuedRequests, 0);
  assert.equal(snapshot.totals.totalRequests, 5);

  // A node still loading (serverRunning=false) must not count towards capacity.
  const loading = await node({ slots: 8, modelName: "loading-model", serverRunning: false, nodeId: "loading-node" }, keyOwner);
  await until(() => tunnel.statusSnapshot().models.length === 2);
  snapshot = tunnel.statusSnapshot();
  assert.equal(snapshot.totals.capacitySlots, 2, "loading node slots excluded");
  assert.equal(snapshot.models.find(m => m.model === "loading-model")?.slots, null);
  loading.socket.terminate();
});

test("managed gateway routes with the configured llama-server key and meters usage", async t => {
  const { app, node, post, directory } = await fixture(t);
  const nodeKey = "node-secret-for-llama-server";
  let relayed = false;
  await node({ modelName: "internal-model" }, (msg, send) => {
    if (msg.type !== "http_relay") return;
    if (msg.path === "/apply-template") {
      send(headers(msg.requestId, 200, { "content-type": "application/json" }));
      send({ type: "http_chunk", requestId: msg.requestId, data: JSON.stringify({ prompt: "formatted prompt" }) });
      send({ type: "http_done", requestId: msg.requestId });
      return;
    }
    if (msg.path === "/tokenize") {
      send(headers(msg.requestId, 200, { "content-type": "application/json" }));
      send({ type: "http_chunk", requestId: msg.requestId, data: JSON.stringify({ tokens: [1, 2, 3] }) });
      send({ type: "http_done", requestId: msg.requestId });
      return;
    }
    relayed = true;
    assert.equal(msg.upstreamApiKey, nodeKey);
    const requestBody = JSON.parse(msg.body);
    assert.equal(requestBody.model, "internal-model-v2");
    const streaming = requestBody.stream === true;
    if (streaming) assert.equal(requestBody.stream_options.include_usage, true);
    const body = streaming
      ? 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'
      : JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
    send(headers(msg.requestId, 200, { "content-type": streaming ? "text/event-stream" : "application/json" }));
    send({ type: "http_chunk", requestId: msg.requestId, data: body });
    send({ type: "http_done", requestId: msg.requestId });
  });

  const login = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const adminHeaders = { cookie, "content-type": "application/json" };
  const modelResponse = await app.inject({ method: "POST", url: "/api/admin/models", headers: adminHeaders,
    payload: { publicName: "public-chat", remark: "调度验证", inputPrice: 2, outputPrice: 4 } });
  assert.equal(modelResponse.statusCode, 200, modelResponse.body);
  const modelId = modelResponse.json().id;
  const routeResponse = await app.inject({ method: "POST", url: `/api/admin/models/${modelId}/routes`, headers: adminHeaders,
    payload: { nodeId: "node-1", upstreamModel: "internal-model-v2", upstreamKey: nodeKey, weight: 1 } });
  assert.equal(routeResponse.statusCode, 200, routeResponse.body);
  assert.equal(routeResponse.json().routes[0].keyConfigured, true);
  assert.equal(routeResponse.body.includes(nodeKey), false, "admin route listing must not disclose the node key");
  const storedRoutes = new Database(join(directory, "openmymodel.db"));
  try {
    const storedKey = storedRoutes.prepare("SELECT upstream_key FROM model_routes WHERE id=?")
      .get(routeResponse.json().routes[0].id)?.upstream_key as string;
    assert.match(storedKey, /^v1\./, "the node's llama-server key must be encrypted at rest");
    assert.notEqual(storedKey, nodeKey);
  } finally { storedRoutes.close(); }
  const existingRoute = routeResponse.json().routes[0];
  const editedRouteResponse = await app.inject({ method: "POST", url: `/api/admin/models/${modelId}/routes`, headers: adminHeaders,
    payload: { id: existingRoute.id, nodeId: existingRoute.nodeId, upstreamModel: "internal-model-v2", upstreamKey: "", weight: 3 } });
  assert.equal(editedRouteResponse.statusCode, 200, editedRouteResponse.body);
  assert.equal(editedRouteResponse.json().routes[0].weight, 3);
  assert.equal(editedRouteResponse.json().routes[0].keyConfigured, true, "leaving the node key blank keeps the encrypted value");
  assert.equal(editedRouteResponse.body.includes(nodeKey), false, "editing a route still never returns the node key");

  const keyResponse = await app.inject({ method: "POST", url: "/api/admin/keys", headers: adminHeaders,
    payload: { name: "integration key", tokenLimit: 100, rpmLimit: 3 } });
  assert.equal(keyResponse.statusCode, 200, keyResponse.body);
  const gatewayKey = keyResponse.json().key as string;
  const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${gatewayKey}` } });
  assert.equal(models.statusCode, 200);
  assert.equal(models.json().data[0].id, "public-chat");

  const response = await post({ model: "public-chat", messages: [{ role: "user", content: "hello" }] }, gatewayKey).response;
  assert.equal(response.statusCode, 200);
  const responseBody = JSON.parse(await text(response));
  assert.equal(responseBody.usage.prompt_tokens, 11);
  assert.equal(responseBody.usage.completion_tokens, 7);
  assert.equal(relayed, true);

  const streamed = await post({ model: "public-chat", stream: true, stream_options: { include_usage: false }, messages: [] }, gatewayKey).response;
  assert.equal(streamed.statusCode, 200);
  assert.match(await text(streamed), /"prompt_tokens":3/);

  const limited = await post({ model: "public-chat", messages: [] }, gatewayKey).response;
  assert.equal(limited.statusCode, 429);
  await text(limited);
  const usage = await app.inject({ method: "GET", url: "/api/admin/usage", headers: adminHeaders });
  assert.equal(usage.statusCode, 200);
  const nonstreamUsage = usage.json().find((row: Message) => row.prompt_tokens === 11);
  assert.equal(nonstreamUsage.model, "public-chat");
  assert.equal(nonstreamUsage.completion_tokens, 7);
  assert.equal(nonstreamUsage.cost, 0.00005);
  const streamUsage = usage.json().find((row: Message) => row.prompt_tokens === 3);
  assert.equal(streamUsage.completion_tokens, 2);
  assert.equal(streamUsage.cost, 0.000014);
  const keys = await app.inject({ method: "GET", url: "/api/admin/keys", headers: adminHeaders });
  assert.equal(keys.json()[0].requestsLastMinute, 3);
});

test("provider gateway preflights node tokens and reserves no more than the available balance", async t => {
  const { app, tunnel, node, post, directory } = await fixture(t);
  const nodeKey = "provider-node-api-key";
  const relayedPaths: string[] = [];
  let inferenceCalls = 0;
  let cancelledStream = false;
  await node({ modelName: "internal-model" }, (msg, send) => {
    if (msg.type === "cancel_request") { cancelledStream = true; return; }
    if (msg.type !== "http_relay") return;
    relayedPaths.push(msg.path);
    assert.equal(msg.upstreamApiKey, nodeKey);
    let value: unknown;
    if (msg.path === "/apply-template") {
      const body = JSON.parse(msg.body);
      assert.equal(body.model, "internal-model-v2");
      value = { prompt: "formatted prompt" };
    } else if (msg.path === "/tokenize") {
      const body = JSON.parse(msg.body);
      if (body.content === "formatted prompt") {
        assert.equal(body.add_special, true);
        value = { tokens: [1, 2, 3, 4, 5] };
      } else {
        assert.equal(body.add_special, false);
        value = { tokens: body.content === "ok" ? [6, 7, 8] : [9, 10, 11, 12] };
      }
    } else {
      inferenceCalls++;
      const body = JSON.parse(msg.body);
      assert.equal(body.n, 1);
      if (body.stream === true) {
        assert.equal(body.max_tokens, 15);
        send(headers(msg.requestId, 200, { "content-type": "text/event-stream" }));
        send({ type: "http_chunk", requestId: msg.requestId, data: 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' });
        return;
      }
      assert.equal(body.max_tokens, 5, "the output cap is reduced to the remaining affordable balance");
      value = { choices: [{ message: { content: "ok" } }] };
    }
    send(headers(msg.requestId, 200, { "content-type": "application/json" }));
    send({ type: "http_chunk", requestId: msg.requestId, data: JSON.stringify(value) });
    send({ type: "http_done", requestId: msg.requestId });
  });

  const adminLogin = await app.inject({ method: "POST", url: "/api/admin/login", payload: { password: PASSWORD } });
  const adminCookie = String(adminLogin.headers["set-cookie"]).split(";", 1)[0];
  const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alipayKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const settings = await app.inject({ method: "PUT", url: "/api/admin/settings", headers: { cookie: adminCookie }, payload: {
    mode: "provider", publicUrl: "https://api.example.test", mailHost: "smtp.example.test", mailPort: 465,
    mailUser: "mail-user", mailFrom: "billing@example.test", mailPassword: "mail-pass",
    alipayAppId: "2026000000000001", alipaySellerId: "2088000000000000",
    alipayPrivateKey: appKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    alipayPublicKey: alipayKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  } });
  assert.equal(settings.statusCode, 200, settings.body);
  const adminHeaders = { cookie: adminCookie, "content-type": "application/json" };
  const model = await app.inject({ method: "POST", url: "/api/admin/models", headers: adminHeaders,
    payload: { publicName: "public-chat", inputPrice: 1, outputPrice: 1 } });
  const route = await app.inject({ method: "POST", url: `/api/admin/models/${model.json().id}/routes`, headers: adminHeaders,
    payload: { nodeId: "node-1", upstreamModel: "internal-model-v2", upstreamKey: nodeKey, weight: 1 } });
  assert.equal(route.statusCode, 200, route.body);

  const database = new Database(join(directory, "openmymodel.db"));
  try {
    database.prepare("INSERT INTO platform_users(id,email,balance,created_at) VALUES(?,?,?,?)")
      .run("provider-user", "provider@example.test", 0.00001, new Date().toISOString());
    const sessions = new PlatformService(database, directory, tunnel);
    const userCookie = `omm_session=${sessions.createSession("user", "provider-user")}`;
    const keyResponse = await app.inject({ method: "POST", url: "/api/user/keys", headers: { cookie: userCookie }, payload: { name: "budgeted" } });
    assert.equal(keyResponse.statusCode, 200, keyResponse.body);
    const gatewayKey = keyResponse.json().key;

    const blockedNodeKey = await post({ model: "public-chat", messages: [{ role: "user", content: "hello" }] }, nodeKey).response;
    assert.equal(blockedNodeKey.statusCode, 401, "provider mode keeps node credentials private to the selected route");
    await text(blockedNodeKey);
    assert.equal(inferenceCalls, 0);

    const response = await post({ model: "public-chat", messages: [{ role: "user", content: "hello" }] }, gatewayKey).response;
    assert.equal(response.statusCode, 200);
    await text(response);
    assert.equal(inferenceCalls, 1);
    assert.deepEqual(relayedPaths, ["/apply-template", "/tokenize", "/v1/chat/completions", "/tokenize"]);
    assert.equal(tunnel.statusSnapshot().totals.totalRequests, 1,
      "internal billing tokenization calls do not inflate public inference request statistics");
    const balance = database.prepare("SELECT balance FROM platform_users WHERE id='provider-user'").get() as { balance: number };
    assert.equal(balance.balance, 0.000002);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM provider_usage_reservations").get() as any).count, 0);

    const insufficient = await post({ model: "public-chat", messages: [{ role: "user", content: "hello" }] }, gatewayKey).response;
    assert.equal(insufficient.statusCode, 402);
    await text(insufficient);
    assert.equal(inferenceCalls, 1, "an unaffordable prompt must not reach inference");

    database.prepare("UPDATE platform_users SET balance=0.00002 WHERE id='provider-user'").run();
    const stream = post({ model: "public-chat", stream: true, messages: [{ role: "user", content: "hello" }] }, gatewayKey);
    const streamResponse = await stream.response;
    streamResponse.on("error", () => {});
    await once(streamResponse, "data");
    stream.req.destroy();
    await until(() => cancelledStream &&
      (database.prepare("SELECT COUNT(*) AS count FROM provider_usage_reservations").get() as any).count === 0);
    const afterCancel = database.prepare("SELECT balance FROM platform_users WHERE id='provider-user'").get() as { balance: number };
    assert.equal(afterCancel.balance, 0.000011, "cancelled streams charge input tokens and tokenize emitted output when upstream usage is absent");
  } finally { database.close(); }
});
