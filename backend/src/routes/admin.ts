import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifyAdminPassword } from "../services/auth";
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  getUsageStats,
  resetMonthlyStats,
} from "../services/key_manager";
import { wsTunnel } from "../services/websocket";

/**
 * 管理 API 路由
 * 所有管理接口需要 admin-password header 认证
 * 这些接口由 Flutter 前端通过 WebSocket 或直接 HTTP 调用
 */

function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const password = request.headers["x-admin-password"] as string;
  if (!password || !verifyAdminPassword(password)) {
    reply.status(401).send({ error: "管理员密码错误" });
    return false;
  }
  return true;
}

export function registerAdminRoutes(app: FastifyInstance): void {
  // ==================== 节点管理 ====================

  app.get("/admin/nodes", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    return wsTunnel.getOnlineNodes();
  });

  // ==================== API Key 管理 ====================

  app.get("/admin/keys", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    return listApiKeys();
  });

  app.post("/admin/keys", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    const { name, tokenLimit } = request.body as any;
    if (!name) {
      return reply.status(400).send({ error: "请提供密钥名称 (name)" });
    }
    const key = createApiKey(name, tokenLimit || 0);
    return { ok: true, key };
  });

  app.delete("/admin/keys/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    const { id } = request.params as any;
    const ok = revokeApiKey(id);
    return { ok };
  });

  // ==================== 用量统计 ====================

  app.get("/admin/usage", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    const { keyId } = request.query as any;
    return getUsageStats(keyId || undefined);
  });

  app.post("/admin/usage/reset", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    resetMonthlyStats();
    return { ok: true, message: "月度统计已重置" };
  });
}