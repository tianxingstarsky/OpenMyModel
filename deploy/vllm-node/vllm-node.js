"use strict";

const { CloudBridge } = require("./cloud_bridge");

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing required setting: ${name}`);
  return ["ADMIN_PASSWORD", "NODE_API_KEY"].includes(name) ? value : value.trim();
}

const config = {
  cloudUrl: required("CLOUD_URL"),
  nodeToken: process.env.NODE_TOKEN?.trim() || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  nodeId: process.env.NODE_ID?.trim() || "",
  nodeName: process.env.NODE_NAME?.trim() || "",
  modelName: required("PUBLIC_MODEL_NAME"),
  apiKey: required("NODE_API_KEY"),
  vllmUrl: process.env.VLLM_URL?.trim() || "http://vllm:8000",
};

if (!!config.nodeToken === !!config.adminPassword) {
  throw new Error("Set exactly one of ADMIN_PASSWORD (personal mode) or NODE_TOKEN (provider/relay mode)");
}
if (config.nodeToken && (!config.nodeToken.startsWith("omm-relay-node-")
  || config.nodeToken.length < 40 || config.nodeToken.length > 256 || /[\r\n]/.test(config.nodeToken))) {
  throw new Error("NODE_TOKEN must be a valid node login token created in your user console");
}
if ((!config.nodeToken && (!config.nodeId || !config.nodeName || config.nodeId.length > 256))
  || config.apiKey.length < 16 || /[\r\n]/.test(config.apiKey)) {
  throw new Error("Personal-mode nodes require NODE_ID and NODE_NAME; NODE_API_KEY must be at least 16 characters without line breaks");
}

const vllmUrl = new URL(config.vllmUrl);
if (!["http:", "https:"].includes(vllmUrl.protocol) || vllmUrl.username || vllmUrl.password || vllmUrl.search || vllmUrl.hash) {
  throw new Error("VLLM_URL must be a plain HTTP(S) origin or base URL");
}
vllmUrl.pathname = vllmUrl.pathname.replace(/\/$/, "");

function endpoint(path) {
  return new URL(`${vllmUrl.pathname}${path}`, vllmUrl.origin);
}

async function probeEngine() {
  const health = await fetch(endpoint("/health"), { signal: AbortSignal.timeout(5000) });
  if (!health.ok) return false;

  const models = await fetch(endpoint("/v1/models"), {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (models.status === 401 || models.status === 403) {
    throw new Error("vLLM rejected NODE_API_KEY; ensure it matches VLLM_API_KEY in the vLLM service");
  }
  if (!models.ok) return false;
  const payload = await models.json();
  const ids = Array.isArray(payload.data) ? payload.data.map(model => model?.id).filter(id => typeof id === "string") : [];
  if (!ids.includes(config.modelName)) {
    throw new Error(`vLLM does not serve PUBLIC_MODEL_NAME (${config.modelName}); served models: ${ids.join(", ") || "none"}`);
  }
  return true;
}

const bridge = new CloudBridge((message) => {
  if (message.type === "connected") {
    reconnectDelay = 1000;
    writeLog(`Connected to OpenMyModel as ${config.nodeName || "your relay node"}`);
  } else if (message.type === "disconnected" || message.type === "error") {
    writeLog(message.type === "error" ? "Tunnel connection failed; reconnecting" : "Tunnel disconnected; reconnecting");
    scheduleReconnect();
  }
});

let stopped = false;
let reconnectTimer;
let reconnectDelay = 1000;
let healthTimer;
let probing = false;
let lastReportedReady;

function writeLog(message) {
  process.stdout.write(`[vllm-node] ${message}\n`);
}

function connect() {
  if (stopped) return;
  try {
    bridge.command({
      cmd: "connect", url: config.cloudUrl, password: config.nodeToken || config.adminPassword,
      nodeId: config.nodeId || undefined, nodeName: config.nodeName || undefined, modelName: config.modelName,
      serverRunning: lastReportedReady === true, llamaUrl: vllmUrl.toString(), llamaApiKey: config.apiKey,
    });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
  reconnectTimer.unref();
}

async function refreshEngineStatus() {
  if (stopped || probing) return;
  probing = true;
  try {
    const ready = await probeEngine();
    if (ready !== lastReportedReady) {
      lastReportedReady = ready;
      bridge.command({ cmd: "status_update", modelName: config.modelName, serverRunning: ready });
      writeLog(ready ? "vLLM is ready" : "vLLM is not ready");
    }
  } catch (error) {
    if (error.message.startsWith("vLLM rejected NODE_API_KEY") || error.message.startsWith("vLLM does not serve PUBLIC_MODEL_NAME")) {
      writeLog(error.message);
    }
    if (lastReportedReady !== false) {
      lastReportedReady = false;
      bridge.command({ cmd: "status_update", modelName: config.modelName, serverRunning: false });
    }
  } finally {
    probing = false;
  }
}

async function start() {
  writeLog("Waiting for vLLM to load the configured model");
  while (!stopped) {
    try {
      if (await probeEngine()) break;
    } catch (error) {
      if (error.message.startsWith("vLLM rejected NODE_API_KEY") || error.message.startsWith("vLLM does not serve PUBLIC_MODEL_NAME")) {
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  if (stopped) return;
  lastReportedReady = true;
  connect();
  healthTimer = setInterval(refreshEngineStatus, 10000);
  healthTimer.unref();
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(healthTimer);
  bridge.command({ cmd: "disconnect" });
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch(error => {
  writeLog(error.message);
  process.exitCode = 1;
});
