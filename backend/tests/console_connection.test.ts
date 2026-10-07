import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { test } from "node:test";

const html = readFileSync(join(__dirname, "../public/console.html"), "utf8");
const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
assert.ok(script);
function section(start: string, end: string) {
  const position = script!.indexOf(start);
  assert.ok(position >= 0, start);
  const stop = script!.indexOf(end, position + start.length);
  assert.ok(stop > position, end);
  return script!.slice(position, stop);
}

function fakeElements() {
  const elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) {
      const classes = new Set<string>();
      elements.set(selector, { hidden: false, innerHTML: "", textContent: "", style: {},
        classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
          contains: (name: string) => classes.has(name) }, append: () => {} });
    }
    return elements.get(selector);
  };
  return { elements, element };
}

test("desktop connection bundle is complete and unavailable without node permissions", () => {
  const { element } = fakeElements();
  const context = createContext({ $: element, portalSessionActive: true, portalMode: "provider",
    data: { computeProvider: { canManageNodes: true } }, lastConnection: null,
    location: { origin: "https://models.example.com" } });
  runInContext(section("function showRelayNodeToken(result)", "$('#copyRelayNodeConnection')"), context);
  runInContext("showRelayNodeToken({name:'4090 节点',token:'omm-relay-node-test'})", context);
  assert.deepEqual(JSON.parse(runInContext("JSON.stringify(lastConnection)", context)), {
    version: 1, serverUrl: "https://models.example.com", mode: "provider",
    nodeName: "4090 节点", nodeToken: "omm-relay-node-test",
  });
  assert.equal(element("#relayNodeTokenModal").classList.contains("show"), true);
  runInContext("data.computeProvider.canManageNodes=false; lastConnection=null; showRelayNodeToken({token:'denied'})", context);
  assert.equal(context.lastConnection, null);
});

test("automatic review refresh preserves an unfinished application and hides nodes when suspended", () => {
  const { element } = fakeElements();
  let closeCount = 0;
  let writes = 0;
  let contents = "";
  Object.defineProperty(element("#computeApplication"), "innerHTML", {
    get: () => contents, set: (value: string) => { contents = value; writes++; },
  });
  const context = createContext({ $: (selector: string) => selector === "#computeApplyForm" ? null : element(selector),
    portalMode: "provider", computeAccessSignature: "",
    data: { computeProvider: { status: "not_applied", canManageNodes: false } },
    closeRelayNodeToken: () => closeCount++, esc: (value: unknown) => String(value ?? ""), dt: String });
  runInContext(section("function renderComputeAccess()", "function renderNodeEarnings()"), context);
  runInContext("renderComputeAccess(); renderComputeAccess()", context);
  assert.equal(writes, 1, "unchanged permission polling must not rebuild the draft form");
  runInContext("data.computeProvider={status:'approved',canManageNodes:true}; renderComputeAccess()", context);
  assert.equal(element("#page-relay-nodes").hidden, false);
  assert.equal(element("#computeApplication").hidden, true);
  runInContext("data.computeProvider={status:'suspended',canManageNodes:false}; renderComputeAccess()", context);
  assert.equal(element("#page-relay-nodes").hidden, true);
  assert.equal(element("#nodeEarnings").hidden, true);
  assert.match(contents, /Token 发放已暂停/);
  assert.equal(closeCount, 3, "every denied state clears any displayed node secret");
});

test("console API omits JSON content type for empty DELETE requests and clears expired sessions", async () => {
  const requests: RequestInit[] = [];
  let expired = false;
  let cleared = "";
  const context = {
    portalSessionActive: true, portalEpoch: 1, AbortController, setTimeout, clearTimeout,
    clearPortal: (message: string) => { cleared = message; },
    fetch: async (_path: string, options: RequestInit) => {
      requests.push(options);
      return { ok: !expired, status: expired ? 401 : 200, json: async () => expired ? { error: "Unauthorized" } : {} };
    },
  };
  const api = runInNewContext(section("async function api(path,opt={})", "function fillUserModelFilter") + "; api", context);
  await api("/api/user/relay/nodes/node-1", { method: "DELETE" });
  assert.equal((requests[0].headers as Record<string, string>)["Content-Type"], undefined);
  await api("/api/user/relay/nodes", { method: "POST", body: "{}" });
  assert.equal((requests[1].headers as Record<string, string>)["Content-Type"], "application/json");
  expired = true;
  await assert.rejects(api("/api/user/dashboard"), (error: any) => error.status === 401);
  assert.match(cleared, /登录已过期/);
});

test("dashboard response received after logout cannot reopen node access", async () => {
  let resolveDashboard!: (value: unknown) => void;
  let renders = 0;
  const pending = new Promise(resolve => { resolveDashboard = resolve; });
  const context = createContext({ portalEpoch: 1, portalSessionActive: true, refreshInFlight: null,
    portalMode: "provider", api: () => pending, renderDashboard: () => renders++,
    data: null, models: [] });
  runInContext(section("async function refresh(force=false)", "function renderDashboard()"), context);
  const refresh = runInContext("refresh()", context);
  runInContext("portalSessionActive=false; portalEpoch++", context);
  resolveDashboard({ mode: "provider", computeProvider: { canManageNodes: true } });
  await refresh;
  assert.equal(renders, 0);
  assert.equal(context.data, null);
});

test("a delayed key response from a previous login is discarded", async () => {
  let resolveResponse!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveResponse = resolve; });
  const context = createContext({ portalSessionActive: true, portalEpoch: 1,
    AbortController, setTimeout, clearTimeout, fetch: () => pending });
  runInContext(section("async function api(path,opt={})", "function fillUserModelFilter"), context);
  const request = runInContext("api('/api/user/keys',{method:'POST',body:'{}'})", context);
  runInContext("portalEpoch=2", context);
  resolveResponse({ ok: true, status: 200, json: async () => ({ key: "old-session-secret" }) });
  await assert.rejects(request, /登录状态已变更/);
});
