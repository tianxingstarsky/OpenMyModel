import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g,
  character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

for (const page of ["console.html", "admin.html"]) {
  const html = readFileSync(join(__dirname, "../public", page), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(script);
  const stop = page === "console.html" ? "function renderRelayNodes(" : "function renderNodeStats(";
  const helper = script.slice(script.indexOf("function hardwareMemory("), script.indexOf(stop));
  assert.ok(helper.includes("function nodeHardwareHtml("));
  const render = runInNewContext(`${helper}; nodeHardwareHtml`, { esc: escapeHtml,
    fmt: (value: number) => String(Math.round(value * 100) / 100) }) as (node: any, compact?: boolean) => string;

  test(`${page} distinguishes missing hardware, CPU and unknown detection`, () => {
    assert.match(render({}), /等待桌面上报/);
    assert.match(render({ hardware: { status: "cpu_only", devices: [] } }), /CPU · 未检测到可用 GPU/);
    const unknown = render({ hardware: { status: "unknown", devices: [], error: "probe unavailable" } });
    assert.match(unknown, /显卡信息未知/);
    assert.doesNotMatch(unknown, /等待桌面上报/);
    assert.match(unknown, /检测结果未知/);
    assert.match(unknown, /probe unavailable/);
    assert.doesNotMatch(unknown, /GiB|MiB/);
  });

  test(`${page} preserves multiple GPU snapshots offline and escapes reported fields`, () => {
    const malicious = '<img src=x onerror="alert(1)">';
    const result = render({ isOnline: false, hardwareReportedAt: "2026-10-07T08:00:00Z", hardware: {
      status: "detected", source: malicious, os: malicious, arch: "x64", error: malicious,
      detectedAt: "2026-10-07T07:59:59Z", devices: [
        { name: malicious, backend: malicious, totalMemoryMiB: 24576, freeMemoryMiB: 1024 },
        { name: "GPU 2", backend: "CUDA", totalMemoryMiB: 16384, freeMemoryMiB: 0 },
      ],
    } }, true);
    assert.match(result, /24 GiB/);
    assert.match(result, /16 GiB/);
    assert.match(result, /2 张显卡/);
    assert.match(result, /空闲快照：1 GiB/);
    assert.match(result, /空闲快照：0 MiB/);
    assert.match(result, /离线 · 最后上报/);
    assert.match(result, /node-hardware compact/);
    assert.match(result, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(result, /<img|<script/);
  });
}

test("compute application is optional service intent and explains automatic hardware reporting", () => {
  const html = readFileSync(join(__dirname, "../public/console.html"), "utf8");
  const textarea = html.match(/<textarea name="description"[^>]*>/)?.[0];
  assert.ok(textarea);
  assert.doesNotMatch(textarea, /required|minlength/);
  assert.match(html, /服务意愿与可用时间（可选）/);
  assert.match(html, /连接桌面端后自动识别并上报，无需手动填写/);
  assert.doesNotMatch(textarea, /GPU 型号与显存/);
});
