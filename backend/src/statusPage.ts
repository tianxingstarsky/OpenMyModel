/** Public status page served at "/". Self-contained HTML/CSS/JS with no
 * external assets (works behind restricted networks), showing only
 * non-sensitive aggregates: online nodes, capacity vs active requests,
 * throughput and per-model concurrency. No node IDs, names or addresses. */
export function renderStatusPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenMyModel · 服务状态</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b27; --panel-2: #1b2233;
    --line: #2a3247; --text: #e6e9f0; --muted: #8b93a7;
    --accent: #4f8cff; --ok: #2fbf71; --warn: #e8a33d; --bad: #e5534b;
    --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text); min-height: 100vh;
    font-family: "Microsoft YaHei UI", "PingFang SC", "Segoe UI", system-ui, sans-serif;
    padding: 40px 20px 60px;
  }
  .wrap { max-width: 960px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  .brand-mark { width: 38px; height: 38px; object-fit: contain; flex: none; }
  h1 { font-size: 26px; letter-spacing: .5px; }
  h1 .dot { display: inline-block; width: 11px; height: 11px; border-radius: 50%;
    background: var(--ok); margin-right: 10px; box-shadow: 0 0 10px var(--ok); }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 28px; }
  .sub .live { color: var(--ok); font-variant-numeric: tabular-nums; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 30px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
  .card .k { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .card .v { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .card .v small { font-size: 14px; color: var(--muted); font-weight: 400; margin-left: 2px; }
  .card .note { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .util-bar { height: 7px; border-radius: 4px; background: var(--panel-2); margin-top: 10px; overflow: hidden; }
  .util-bar i { display: block; height: 100%; width: 0; border-radius: 4px;
    background: linear-gradient(90deg, var(--ok), var(--warn) 75%, var(--bad));
    transition: width .6s ease; }
  h2 { font-size: 15px; color: var(--muted); font-weight: 600; margin: 26px 0 12px; letter-spacing: .4px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
    border: 1px solid var(--line); border-radius: 12px; overflow: hidden; font-size: 14px; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-size: 12px; font-weight: 600; background: var(--panel-2); }
  tr:last-child td { border-bottom: none; }
  td.num { font-variant-numeric: tabular-nums; font-family: var(--mono); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: 12px; }
  .pill.ok { color: var(--ok); background: rgba(47,191,113,.12); }
  .pill.idle { color: var(--muted); background: rgba(139,147,167,.12); }
  .empty { color: var(--muted); text-align: center; padding: 34px 0 26px; background: var(--panel);
    border: 1px dashed var(--line); border-radius: 12px; font-size: 14px; }
  .mini-bar { display: inline-block; vertical-align: middle; width: 110px; height: 6px;
    background: var(--panel-2); border-radius: 3px; overflow: hidden; margin-right: 8px; }
  .mini-bar i { display: block; height: 100%; background: var(--accent); }
  footer { margin-top: 40px; color: var(--muted); font-size: 12px; line-height: 1.8; }
  footer code { font-family: var(--mono); background: var(--panel); padding: 1px 6px; border-radius: 4px; }
  @media (max-width: 560px) { h1 { font-size: 21px; } .card .v { font-size: 24px; } }
</style>
</head>
<body>
<div class="wrap">
  <header><img class="brand-mark" src="/brand-mark.png" alt=""><h1><span class="dot"></span>OpenMyModel 服务状态</h1></header>
  <div class="sub">公开状态页 · 每 3 秒自动刷新 · 最近更新 <span class="live" id="updated">—</span></div>

  <div class="cards">
    <div class="card"><div class="k">在线服务节点</div><div class="v" id="nodes">—</div>
      <div class="note" id="models-note">—</div></div>
    <div class="card"><div class="k">并发容量 / 使用中</div>
      <div class="v" id="concurrency">—</div>
      <div class="util-bar"><i id="util-fill"></i></div>
      <div class="note" id="util-note">—</div></div>
    <div class="card"><div class="k">近期吞吐速度</div><div class="v" id="speed">—</div>
      <div class="note">已完成请求输出流量的指数加权均值</div></div>
    <div class="card"><div class="k">累计服务请求</div><div class="v" id="total">—</div>
      <div class="note" id="bytes-note">—</div></div>
  </div>

  <h2>模型并发一览</h2>
  <div id="model-table"></div>

  <footer>
    此页面仅展示公开统计信息（节点数、并发、吞吐），不包含节点标识、地址、密钥或对话内容。<br>
    API 端点：<code>/v1/chat/completions</code> · <code>/v1/models</code> · 机器可读数据：<code>/status.json</code>
  </footer>
</div>
<script>
(function () {
  var lastUpdated = null;
  function fmtBytes(n) {
    if (!n || n < 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + " " + units[i];
  }
  function fmtBytesPerSec(n) {
    if (!n || n <= 0) return "—";
    return fmtBytes(n) + "/s";
  }
  function set(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function setHtml(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
  function int(value) { return /^\\d+$/.test(String(value)) ? String(value) : "0"; }
  function render(data) {
    var t = data.totals || {};
    set("nodes", t.nodesOnline !== undefined ? t.nodesOnline : "—");
    var modelCount = (data.models || []).length;
    set("models-note", modelCount > 0 ? modelCount + " 个模型在线" : "暂无模型");
    if (t.capacitySlots === null || t.capacitySlots === undefined) {
      set("concurrency", t.activeRequests !== undefined ? String(t.activeRequests) : "0");
      set("util-note", "并发容量未上报（旧桌面端），升级后显示容量与排队");
      document.getElementById("util-fill").style.width = "0%";
    } else {
      setHtml("concurrency", int(t.activeRequests) + ' <small>/ ' + int(t.capacitySlots) + "</small>");
      var pct = t.capacitySlots > 0 ? Math.min(100, Math.round(t.activeRequests / t.capacitySlots * 100)) : 0;
      var queued = t.queuedRequests || 0;
      var fill = document.getElementById("util-fill");
      fill.style.width = pct + "%";
      fill.style.background = queued > 0
        ? "linear-gradient(90deg, var(--warn), var(--bad))"
        : "linear-gradient(90deg, var(--ok), var(--warn) 75%, var(--bad))";
      set("util-note", "使用率 " + pct + "%" + (queued > 0 ? " · 排队中 " + queued : ""));
    }
    set("speed", fmtBytesPerSec(t.throughputBytesPerSec));
    set("total", t.totalRequests !== undefined ? t.totalRequests : "—");
    set("bytes-note", "累计转发 " + fmtBytes(t.totalBytes));
    var host = document.getElementById("model-table");
    if (!modelCount) {
      host.innerHTML = '<div class="empty">当前没有模型服务节点在线</div>';
    } else {
      var rows = (data.models || []).map(function (m) {
        var slotsCell = (m.slots === null || m.slots === undefined)
          ? '<span style="color:var(--muted)">未上报</span>'
          : m.activeRequests + ' <span style="color:var(--muted)">/ ' + m.slots + "</span>";
        var util = (m.slots > 0) ? Math.min(100, Math.round(m.activeRequests / m.slots * 100)) : null;
        var utilCell = util === null
          ? '<span style="color:var(--muted)">—</span>'
          : '<span class="mini-bar"><i style="width:' + util + '%"></i></span>' + util + "%";
        var queuedCell;
        if (m.slots === null || m.slots === undefined) {
          queuedCell = '<span style="color:var(--muted)">—</span>';
        } else if (m.queued > 0) {
          queuedCell = '<span class="pill" style="color:var(--warn);background:rgba(232,163,61,.12)">' + m.queued + "</span>";
        } else {
          queuedCell = "0";
        }
        var ready = '<span class="pill ' + (m.readyNodes > 0 ? "ok" : "idle") + '">' +
          (m.readyNodes > 0 ? m.readyNodes + "/" + m.nodes + " 就绪" : "加载中") + "</span>";
        return "<tr><td>" + String(m.model).replace(/&/g, "&amp;").replace(/</g, "&lt;") +
          "</td><td>" + ready + '</td><td class="num">' + slotsCell +
          '</td><td class="num">' + queuedCell + '</td><td class="num">' + utilCell +
          '</td><td class="num">' + (m.totalRequests || 0) + "</td></tr>";
      }).join("");
      host.innerHTML = "<table><thead><tr><th>模型</th><th>节点</th><th>并发 (使用/容量)</th><th>排队</th><th>使用率</th><th>累计请求</th></tr></thead><tbody>" +
        rows + "</tbody></table>";
    }
    var now = new Date();
    set("updated", now.toLocaleTimeString("zh-CN", { hour12: false }));
    if (lastUpdated === null) document.title = "OpenMyModel · 服务状态";
    lastUpdated = now;
  }
  function poll() {
    fetch("/status.json", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(render)
      .catch(function () { set("updated", "获取失败，重试中…"); });
  }
  poll();
  setInterval(poll, 3000);
})();
</script>
</body>
</html>`;
}

/** Public relay-mode landing page. It intentionally contains no node/model or
 * customer usage information; customer dashboards require an account session. */
export function renderRelayStatusPage(serviceName: string): string {
  const name = serviceName.replace(/[&<>"']/g, value => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[value]!));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">
<title>${name} · 网关状态</title><style>
:root{color-scheme:light;--bg:#eef2ed;--card:#fff;--ink:#1c3432;--muted:#617673;--line:#dce6e1;--green:#227c69}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 Inter,"Segoe UI","Microsoft YaHei",sans-serif;min-height:100vh;display:grid;place-items:center;padding:28px}
main{width:min(620px,100%);background:var(--card);border:1px solid var(--line);border-radius:24px;padding:36px;box-shadow:0 16px 44px #12312c10}
.brand{display:flex;gap:14px;align-items:center}.mark{width:46px;height:46px;border-radius:14px;background:#e5f1ec;padding:8px;object-fit:contain}h1{font-size:24px;margin:0}.sub{color:var(--muted);margin:5px 0 28px}.state{display:flex;align-items:center;gap:10px;padding:16px;border:1px solid #cde6d8;background:#f0f8f3;border-radius:14px;color:#236c4b;font-weight:600}.dot{width:10px;height:10px;border-radius:50%;background:#2c9b68;box-shadow:0 0 0 5px #2c9b6818}.copy{color:var(--muted);margin:22px 0}.actions{display:flex;gap:10px;flex-wrap:wrap}.button{display:inline-flex;padding:10px 16px;border-radius:11px;text-decoration:none;font-weight:600;color:#fff;background:var(--green)}.secondary{background:#eef4f1;color:var(--ink)}footer{margin-top:28px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}code{background:#f2f5f3;border-radius:5px;padding:2px 5px}@media(max-width:520px){main{padding:25px}.brand{align-items:flex-start}}
</style></head><body><main><div class="brand"><img class="mark" src="/brand-mark.png" alt=""><div><h1>${name}</h1><div class="sub">代转发网关</div></div></div>
<div class="state"><span class="dot"></span>网关运行正常</div>
<p class="copy">模型节点、路由和用量仅在所属账户内展示。使用者可登录控制台管理自己的节点与 API Key。</p>
<div class="actions"><a class="button" href="/console">打开用户控制台</a><a class="button secondary" href="/api">查看 API 接入信息</a></div>
<footer>公开页面不展示个人节点、模型名称或客户用量。OpenAI 兼容接口：<code>/v1/chat/completions</code> · 模型列表：<code>/v1/models</code></footer></main></body></html>`;
}
