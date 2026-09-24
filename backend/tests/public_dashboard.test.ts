import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

test("public dashboard escapes caller-controlled model names before inserting HTML", async () => {
  const html = readFileSync(join(__dirname, "../public/dashboard.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(script, "dashboard inline script exists");

  const maliciousModel = '<img src=x onerror="alert(1)">';
  const data = {
    requests: 1, input: 1, output: 1, requestsPerMinute: 1, onlineNodes: 1, totalNodes: 1,
    hourly: [], models: [{ model: maliciousModel, requests: 1 }],
    tunnel: { models: [{ model: maliciousModel, nodes: 1, readyNodes: 1, activeRequests: 0, totalRequests: 1 }] },
  };
  const context2d = new Proxy({ createLinearGradient: () => ({ addColorStop: () => {} }) }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return () => {};
    },
    set(target, property, value) {
      Reflect.set(target, property, value);
      return true;
    },
  });
  const elements = new Map<string, Record<string, any>>();
  const element = (id: string) => {
    let value = elements.get(id);
    if (!value) {
      value = { innerHTML: "", textContent: "", style: {}, clientWidth: 900, clientHeight: 240,
        getContext: () => context2d };
      elements.set(id, value);
    }
    return value;
  };
  runInNewContext(script, {
    document: { querySelector: (selector: string) => element(selector.slice(1)) },
    fetch: async () => ({ status: 200, ok: true, json: async () => data }),
    setInterval: () => 0,
    devicePixelRatio: 1,
  });
  await new Promise(resolve => setImmediate(resolve));

  const escaped = '&lt;img src=x onerror="alert(1)"&gt;';
  assert.ok(elements.get("models")?.innerHTML.includes(escaped));
  assert.ok(elements.get("nodes")?.innerHTML.includes(escaped));
  assert.equal(elements.get("models")?.innerHTML.includes(maliciousModel), false);
  assert.equal(elements.get("nodes")?.innerHTML.includes(maliciousModel), false);
});

test("admin panel inline scripts remain syntactically valid", () => {
  const html = readFileSync(join(__dirname, "../public/admin.html"), "utf8");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0, "admin panel scripts exist");
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test("admin node page distinguishes protected node keys from caller keys and supports filtering", () => {
  const html = readFileSync(join(__dirname, "../public/admin.html"), "utf8");
  assert.match(html, /节点访问 Key 用于网关认证到对应的 llama-server/);
  assert.match(html, /统一调用者 Key 在「API 密钥」中单独管理/);
  assert.match(html, /id="nodeSearch"/);
  assert.match(html, /id="nodeStatusFilter"/);
  assert.match(html, /function renderNodeStats\(\)/);
});

test("admin node summary and combined search/status filters use current node state", () => {
  const html = readFileSync(join(__dirname, "../public/admin.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(script, "admin panel inline script exists");
  const renderers = script.match(/function renderNodeStats\(\)[^\n]*\nfunction renderNodes\(\)[^\n]*/)?.[0];
  assert.ok(renderers, "node rendering functions exist");
  const elements = new Map<string, Record<string, any>>();
  const element = (selector: string) => {
    let value = elements.get(selector);
    if (!value) { value = { value: selector === "#nodeStatusFilter" ? "all" : "", innerHTML: "", textContent: "" }; elements.set(selector, value); }
    return value;
  };
  const context = {
    nodes: [
      { id: "node-01", name: "Chat node", modelName: "chat-32b", isOnline: true, serverRunning: true, keyConfigured: true, routeCount: 2, slots: 4 },
      { id: "node-02", name: "Offline node", modelName: "embedding", isOnline: false, serverRunning: false, keyConfigured: false, routeCount: 1, slots: null },
      { id: "node-03", name: "Starting node", modelName: "chat-debug", isOnline: true, serverRunning: false, keyConfigured: true, routeCount: 0, slots: 2 },
    ],
    $: element,
    fmt: (value: unknown) => String(value ?? 0),
    esc: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!),
    document: { querySelectorAll: () => [] },
  };
  runInNewContext(`${renderers}; renderNodeStats(); renderNodes()`, context);
  assert.match(element("#nodeStats").innerHTML, /可调度节点[\s\S]*?metric-value">1</);
  assert.equal(element("#nodeResultCount").textContent, "3 个节点");
  assert.match(element("#nodesTable").innerHTML, /node-02/);

  element("#nodeSearch").value = "chat";
  element("#nodeStatusFilter").value = "ready";
  runInNewContext(`${renderers}; renderNodeStats(); renderNodes()`, context);
  assert.equal(element("#nodeResultCount").textContent, "显示 1 / 3 个");
  assert.match(element("#nodesTable").innerHTML, /node-01/);
  assert.doesNotMatch(element("#nodesTable").innerHTML, /node-02|node-03/);
});

test("admin API helper omits JSON content type for bodyless requests", async () => {
  const html = readFileSync(join(__dirname, "../public/admin.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(script, "admin panel inline script exists");
  const helper = script.match(/async function api\(path,options=\{\}\)[\s\S]*?\}function fillModelFilter/)?.[0]
    ?.replace(/function fillModelFilter$/, "");
  assert.ok(helper, "admin API helper exists");
  const requests: Array<{ headers: Record<string, string>; method?: string; body?: string }> = [];
  const callApi = runInNewContext(`${helper}; api`, {
    fetch: async (_path: string, options: { headers: Record<string, string>; method?: string; body?: string }) => {
      requests.push(options);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  }) as (path: string, options: Record<string, unknown>) => Promise<unknown>;

  await callApi("/api/admin/nodes/offline-node", { method: "DELETE" });
  assert.equal(Object.keys(requests[0].headers).some(name => name.toLowerCase() === "content-type"), false);
  await callApi("/api/admin/nodes/offline-node/api-key", { method: "PUT", body: JSON.stringify({ apiKey: "test" }) });
  assert.equal(requests[1].headers["Content-Type"], "application/json");
});
