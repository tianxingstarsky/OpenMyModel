// Uses the production bridge against a real or fake local llama HTTP server.
const { CloudBridge } = require("./cloud_bridge");

const password = process.env.ADMIN_PASSWORD;
const key = process.env.TEST_API_KEY;
if (!password || !key) {
  console.error("Set ADMIN_PASSWORD and TEST_API_KEY. Optional: CLOUD_URL, LLAMA_URL, LLAMA_API_KEY.");
  process.exit(1);
}
const bridge = new CloudBridge((message) => console.log(JSON.stringify(message)));
bridge.command({ cmd: "set_keys", keys: [{ key, isActive: true }] });
bridge.command({
  cmd: "connect", url: process.env.CLOUD_URL || "http://127.0.0.1:3000",
  password, llamaUrl: process.env.LLAMA_URL || "http://127.0.0.1:8080",
  llamaApiKey: process.env.LLAMA_API_KEY || "", nodeName: "smoke-node",
  modelName: process.env.MODEL_NAME || "local-model",
  ...(process.env.SLOTS ? { slots: Number(process.env.SLOTS) } : {}),
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { bridge.disconnect(); process.exit(0); });
}
