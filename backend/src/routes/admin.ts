import { FastifyInstance } from "fastify";
import { AdminAuthenticator } from "../services/auth";
import { WebSocketTunnel } from "../services/websocket";

export function registerAdminRoutes(app: FastifyInstance, tunnel: WebSocketTunnel, auth: AdminAuthenticator): void {
  app.get("/admin/nodes", async (request, reply) => {
    const result = await auth.authenticate(request.headers["x-admin-password"], request.ip);
    if (result === "limited") return reply.header("Retry-After", "60").status(429).send({ error: "Too many authentication attempts" });
    if (result !== "ok") return reply.status(401).send({ error: "Invalid administrator password" });
    return tunnel.getOnlineNodes();
  });
}
