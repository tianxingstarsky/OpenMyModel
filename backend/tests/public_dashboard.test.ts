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
