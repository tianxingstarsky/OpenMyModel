import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { validateApiKey } from "../services/key_manager";
import { wsTunnel } from "../services/websocket";

export function registerOpenAIRoutes(app: FastifyInstance): void {

  app.get("/v1/models", async (_req, _reply) => {
    const nodes = wsTunnel.getOnlineNodes();
    const data = nodes.length > 0
      ? nodes.map(n => ({ id: n.modelName || "local-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: n.name }))
      : [{ id: "local-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: "outmymodel" }];
    return { object: "list", data };
  });

  // 原始 HTTP 镜像: 转发所有 /v1/* 请求到本地节点
  const relayHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.status(401).send({ error: { message: "Missing API Key", type: "authentication_error" } });
    if (!validateApiKey(auth.slice(7))) return reply.status(401).send({ error: { message: "Invalid API Key", type: "authentication_error" } });

    const node = wsTunnel.getAvailableNode();
    if (!node) return reply.status(503).send({ error: { message: "No compute node online", type: "server_error" } });

    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    const isStream = rawBody.includes('"stream":true');

    try {
      if (isStream) {
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        await wsTunnel.relayHttp(node.nodeId, { path: request.url, body: rawBody }, (chunk: string) => reply.raw.write(chunk));
        reply.raw.end();
      } else {
        const result = await wsTunnel.relayHttp(node.nodeId, { path: request.url, body: rawBody });
        try { return JSON.parse(result as string); } catch { return result; }
      }
    } catch (err: any) {
      if (isStream) { try { reply.raw.end(); } catch (_) {} }
      else return reply.status(500).send({ error: { message: err.message, type: "server_error" } });
    }
  };

  app.post("/v1/chat/completions", relayHandler);
  // 可扩展更多端点
}
