import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { wsTunnel } from "../services/websocket";

/**
 * OpenAI 兼容 API 路由
 * - 纯 HTTP 镜像转发，不解析内容
 * - API Key 由 Flutter 本地验证（通过 WebSocket），云端不存储
 */

export function registerOpenAIRoutes(app: FastifyInstance): void {

  app.get("/v1/models", async (_req, _reply) => {
    const nodes = wsTunnel.getOnlineNodes();
    const data = nodes.length > 0
      ? nodes.map(n => ({ id: n.modelName || "local-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: n.name }))
      : [{ id: "local-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: "openmymodel" }];
    return { object: "list", data };
  });

  const relayHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return reply.status(401).send({ error: { message: "Missing API Key", type: "authentication_error" } });

    const node = wsTunnel.getAvailableNode();
    if (!node) return reply.status(503).send({ error: { message: "No compute node online", type: "server_error" } });

    // Key 验证走 WebSocket，由 Flutter 本地判断
    const valid = await wsTunnel.validateKey(auth.slice(7), node.nodeId);
    if (!valid) return reply.status(401).send({ error: { message: "Invalid API Key", type: "authentication_error" } });

    let rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed.max_tokens == null || parsed.max_tokens < 0) {
        parsed.max_tokens = 4096;
        rawBody = JSON.stringify(parsed);
      }
    } catch (_) {}

    const isStream = rawBody.includes('"stream":true');

    try {
      if (isStream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
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
}
