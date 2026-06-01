import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifyAdminPassword } from "../services/auth";
import { wsTunnel } from "../services/websocket";

/**
 * 管理 API 路由
 * 所有管理接口需要 x-admin-password header 认证
 * API Key 由 Flutter 本地管理，服务器不存储
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
  // 节点管理
  app.get("/admin/nodes", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(request, reply)) return;
    return wsTunnel.getOnlineNodes();
  });

  // Key 由 Flutter 本地管理，云端无 Key 相关接口
  // 外部用户验证通过 /v1/* 的 Bearer token → WebSocket validate_key 流程
}
