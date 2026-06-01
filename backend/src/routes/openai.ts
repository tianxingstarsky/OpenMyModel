import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { validateApiKey, recordUsage } from "../services/key_manager";
import { wsTunnel } from "../services/websocket";

export function registerOpenAIRoutes(app: FastifyInstance): void {

  app.get("/v1/models", async (_req, _reply) => {
    const nodes = wsTunnel.getOnlineNodes();
    const data = nodes.length > 0
      ? nodes.map(n => ({ id: n.modelName || "local-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: n.name }))
      : [{ id: "local-model", object: "model", created: Math.floor(Date.now()/1000), owned_by: "outmymodel" }];
    return { object: "list", data };
  });

  app.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer "))
      return reply.status(401).send({ error: { message: "Missing API Key", type: "authentication_error" } });
    const keyInfo: any = validateApiKey(auth.slice(7));
    if (!keyInfo) return reply.status(401).send({ error: { message: "Invalid API Key", type: "authentication_error" } });
    if (keyInfo.tokenLimit > 0 && keyInfo.monthlyTokens >= keyInfo.tokenLimit)
      return reply.status(429).send({ error: { message: "Quota exceeded", type: "rate_limit_error" } });

    const node = wsTunnel.getAvailableNode();
    if (!node) return reply.status(503).send({ error: { message: "No compute node online", type: "server_error" } });

    const body = request.body as any;
    const stream = body?.stream === true;
    const forwardData: any = { ...body };
    delete forwardData.type;

    try {
      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        const result: any = await wsTunnel.forwardToNode(node.nodeId, forwardData);
        if (result?.chunks) for (const c of result.chunks) reply.raw.write("data: " + JSON.stringify(c) + "\n\n");
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } else {
        return await wsTunnel.forwardToNode(node.nodeId, forwardData);
      }
    } catch (err: any) {
      if (stream) {
        try { reply.raw.write("data: " + JSON.stringify({error:{message:err.message,type:"server_error"}}) + "\n\ndata: [DONE]\n\n"); reply.raw.end(); } catch (_) {}
      } else {
        return reply.status(500).send({ error: { message: err.message, type: "server_error" } });
      }
    }

    recordUsage(keyInfo.id, body?.model || "", "/v1/chat/completions", 0, 0,
      (request.headers["x-forwarded-for"] as string) || request.ip,
      (request.headers["user-agent"] as string) || "");
  });
}
