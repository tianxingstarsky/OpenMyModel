import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { OutgoingHttpHeaders, validateHeaderName, validateHeaderValue } from "http";
import { WebSocketTunnel, RelayError } from "../services/websocket";

const MAX_WRITE_QUEUE = 8 * 1024 * 1024;

export function relayHeaders(headers: Record<string, unknown>): OutgoingHttpHeaders {
  const blocked = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding",
    "upgrade", "content-length", "content-encoding", "set-cookie",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "content-encoding" && value !== "identity") throw new RelayError("Unsupported upstream content encoding");
    if (name.toLowerCase() === "connection" && typeof value === "string") {
      for (const token of value.split(",")) blocked.add(token.trim().toLowerCase());
    }
  }
  const result: OutgoingHttpHeaders = Object.create(null);
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower) || lower.startsWith("access-control-")) continue;
    validateHeaderName(lower);
    if (typeof value !== "string" && !(Array.isArray(value) && value.every(item => typeof item === "string"))) {
      throw new RelayError("Invalid upstream header value");
    }
    for (const item of Array.isArray(value) ? value : [value]) validateHeaderValue(lower, item);
    result[lower] = value;
  }
  return result;
}

export function registerOpenAIRoutes(app: FastifyInstance, tunnel: WebSocketTunnel): void {
  app.get("/v1/models", async () => {
    const nodes = tunnel.getOnlineNodes().filter(node => node.serverRunning);
    const data = nodes.length > 0
      ? nodes.map(node => ({ id: node.modelName || "local-model", object: "model", created: Math.floor(Date.now() / 1000), owned_by: node.name }))
      : [{ id: "local-model", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "openmymodel" }];
    return { object: "list", data };
  });

  const relayHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)
      || (body.stream !== undefined && typeof body.stream !== "boolean")
      || (body.model !== undefined && typeof body.model !== "string")) {
      return reply.status(400).send({ error: { message: "Expected a JSON object with boolean stream and string model", type: "invalid_request_error" } });
    }
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ") || !auth.slice(7).trim()) {
      return reply.status(401).send({ error: { message: "Missing API Key", type: "authentication_error" } });
    }

    const controller = new AbortController();
    const disconnect = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.on("aborted", disconnect);
    reply.raw.on("close", disconnect);
    reply.raw.on("error", disconnect);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();

    try {
      const node = await tunnel.findNode(auth.slice(7), body.model as string | undefined, controller.signal);
      await tunnel.relayHttp(node, { path: request.url, body: JSON.stringify(body) }, {
        signal: controller.signal,
        onHeaders: (statusCode, headers) => {
          const safeHeaders = relayHeaders(headers);
          if (!safeHeaders["content-type"]) safeHeaders["content-type"] = body.stream === true && statusCode < 400
            ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8";
          if (body.stream === true) safeHeaders["x-accel-buffering"] = "no";
          if (reply.raw.destroyed || controller.signal.aborted) throw new RelayError("HTTP client disconnected", 499);
          reply.hijack();
          reply.raw.writeHead(statusCode, { ...reply.getHeaders(), ...safeHeaders } as OutgoingHttpHeaders);
          reply.raw.flushHeaders();
        },
        onChunk: chunk => {
          if (reply.raw.destroyed || controller.signal.aborted) throw new RelayError("HTTP client disconnected", 499);
          if (reply.raw.writableLength + Buffer.byteLength(chunk) > MAX_WRITE_QUEUE) {
            throw new RelayError("Downstream response is too slow");
          }
          reply.raw.write(chunk, "utf8");
        },
      });
      if (!reply.raw.destroyed) reply.raw.end();
    } catch (error) {
      if (reply.raw.destroyed || controller.signal.aborted) return;
      if (reply.raw.headersSent) {
        // Once upstream headers have been forwarded an error must abort the body.
        reply.raw.destroy();
        return;
      }
      const statusCode = error instanceof RelayError ? error.statusCode : 502;
      return reply.status(statusCode).send({ error: {
        message: error instanceof RelayError ? error.message : "Upstream request failed",
        type: statusCode === 401 ? "authentication_error" : "server_error",
      } });
    } finally {
      request.raw.off("aborted", disconnect);
      reply.raw.off("close", disconnect);
      reply.raw.off("error", disconnect);
    }
  };

  app.post("/v1/chat/completions", {
    onRequest: async (request, reply) => {
      const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
      if (!contentType || !/^application\/(?:json|[\w.+-]+\+json)$/.test(contentType)) {
        return reply.status(415).send({ error: { message: "Content-Type must be application/json", type: "invalid_request_error" } });
      }
    },
  }, relayHandler);
}
