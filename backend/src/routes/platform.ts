import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AdminAuthenticator } from "../services/auth";
import { NodeKeyInUseError, PlatformService } from "../services/platform";
import { RelayError } from "../services/websocket";

const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
  request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};

function cookie(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const field of raw.split(";")) {
    const separator = field.indexOf("=");
    if (separator > 0 && field.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(field.slice(separator + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

function sessionCookie(request: FastifyRequest, value: string, maxAge: number): string {
  const proto = request.headers["x-forwarded-proto"];
  const secure = request.protocol === "https" || (typeof proto === "string" && proto.split(",")[0].trim() === "https");
  return `omm_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function allowSameOriginMutation(request: FastifyRequest, reply: FastifyReply, platform: PlatformService): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const originHeader = request.headers.origin;
  const refererHeader = request.headers.referer;
  if (originHeader === undefined && refererHeader === undefined) return true;

  let source: string;
  try {
    source = new URL(typeof originHeader === "string" ? originHeader : refererHeader!).origin;
  } catch {
    reply.status(403).send({ error: "Cross-origin request blocked" });
    return false;
  }

  const configuredUrl = platform.getAdminSettings().publicUrl;
  let expected: string | undefined;
  if (configuredUrl) {
    try { expected = new URL(configuredUrl).origin; } catch { /* Fall back to the request host below. */ }
  }
  if (!expected) {
    const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(",", 1)[0].trim();
    const forwardedProtocol = first(request.headers["x-forwarded-proto"]);
    const protocol = forwardedProtocol === "http" || forwardedProtocol === "https" ? forwardedProtocol : request.protocol;
    const host = first(request.headers["x-forwarded-host"]) || request.headers.host;
    try { if (host) expected = new URL(`${protocol}://${host}`).origin; } catch { /* Reject if no valid request origin can be formed. */ }
  }
  if (expected && source === expected) return true;
  reply.status(403).send({ error: "Cross-origin request blocked" });
  return false;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, platform: PlatformService, auth: AdminAuthenticator): Promise<boolean> {
  const session = platform.getSession(cookie(request, "omm_session"));
  if (session?.role === "admin") return allowSameOriginMutation(request, reply, platform);
  if (request.headers["x-admin-password"] !== undefined) {
    const result = await auth.authenticate(request.headers["x-admin-password"], request.ip);
    if (result === "ok") return true;
    if (result === "limited") reply.header("Retry-After", "60").status(429).send({ error: "Too many authentication attempts" });
    else reply.status(401).send({ error: "Invalid administrator password" });
    return false;
  }
  reply.status(401).send({ error: "Administrator login required" });
  return false;
}

function requireUser(request: FastifyRequest, reply: FastifyReply, platform: PlatformService): string | null {
  if (!platform.isProviderMode()) { reply.status(403).send({ error: "Service-provider mode is disabled" }); return null; }
  const session = platform.getSession(cookie(request, "omm_session"));
  if (session?.role !== "user" || !session.userId) { reply.status(401).send({ error: "Sign in required" }); return null; }
  if (!allowSameOriginMutation(request, reply, platform)) return null;
  return session.userId;
}

function apiError(reply: FastifyReply, error: unknown, status = 400) {
  return reply.status(status).send({ error: error instanceof Error ? error.message : "Request failed" });
}

export function registerPlatformRoutes(app: FastifyInstance, platform: PlatformService, auth: AdminAuthenticator): void {
  app.get("/api/public/config", async () => platform.getPublicConfig());
  app.get("/api/public/dashboard", async (_request, reply) => {
    if (platform.isProviderMode()) return reply.status(404).send({ error: "Dashboard is private in service-provider mode" });
    return platform.overview();
  });

  app.post("/api/admin/login", async (request, reply) => {
    if (!allowSameOriginMutation(request, reply, platform)) return;
    const result = await auth.authenticate(bodyOf(request).password, request.ip);
    if (result !== "ok") {
      if (result === "limited") reply.header("Retry-After", "60").status(429);
      else reply.status(401);
      return { error: result === "limited" ? "Too many authentication attempts" : "Invalid administrator password" };
    }
    const token = platform.createSession("admin", null);
    reply.header("set-cookie", sessionCookie(request, token, 30 * 24 * 60 * 60));
    return { ok: true };
  });
  app.get("/api/admin/me", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return { ok: true, settings: platform.getAdminSettings() };
  });
  app.post("/api/admin/logout", async (request, reply) => {
    if (cookie(request, "omm_session") && !allowSameOriginMutation(request, reply, platform)) return;
    platform.revokeSession(cookie(request, "omm_session"));
    reply.header("set-cookie", sessionCookie(request, "", 0));
    return { ok: true };
  });
  app.get("/api/admin/overview", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.overview();
  });
  app.get("/api/admin/nodes", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.adminNodeList();
  });
  app.put<{ Params: { nodeId: string } }>("/api/admin/nodes/:nodeId/api-key", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try { return platform.saveNodeApiKey(request.params.nodeId, bodyOf(request).apiKey); }
    catch (error) { return apiError(reply, error); }
  });
  app.post<{ Params: { nodeId: string } }>("/api/admin/nodes/:nodeId/api-key/verify", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try { return await platform.verifyNodeApiKey(request.params.nodeId); }
    catch (error) { return apiError(reply, error, error instanceof RelayError ? error.statusCode : 400); }
  });
  app.delete<{ Params: { nodeId: string } }>("/api/admin/nodes/:nodeId/api-key", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try {
      return platform.clearNodeApiKey(request.params.nodeId)
        ? { ok: true, keyConfigured: false }
        : reply.status(404).send({ error: "Node not found" });
    } catch (error) {
      return apiError(reply, error, error instanceof NodeKeyInUseError ? 409 : 400);
    }
  });
  app.get("/api/admin/models", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.adminModels();
  });
  app.post("/api/admin/models", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try { return platform.saveModel(bodyOf(request)); } catch (error) { return apiError(reply, error); }
  });
  app.delete<{ Params: { modelId: string } }>("/api/admin/models/:modelId", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    platform.deleteModel(request.params.modelId); return { ok: true };
  });
  app.post<{ Params: { modelId: string } }>("/api/admin/models/:modelId/routes", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try { return platform.saveRoute({ ...bodyOf(request), modelId: request.params.modelId }); } catch (error) { return apiError(reply, error); }
  });
  app.delete<{ Params: { routeId: string } }>("/api/admin/routes/:routeId", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    platform.deleteRoute(request.params.routeId); return { ok: true };
  });
  app.get("/api/admin/keys", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.listKeys();
  });
  app.post("/api/admin/keys", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try {
      const body = bodyOf(request);
      return platform.createGatewayKey(body.name, null, body.tokenLimit, body.rpmLimit, body.modelFilter);
    } catch (error) { return apiError(reply, error); }
  });
  app.patch<{ Params: { keyId: string } }>("/api/admin/keys/:keyId", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try {
      const body = bodyOf(request);
      const key = platform.updateKeyLimits(request.params.keyId, body.tokenLimit, body.rpmLimit, undefined, body.modelFilter);
      return key ?? reply.status(404).send({ error: "API Key not found" });
    } catch (error) { return apiError(reply, error); }
  });
  app.delete<{ Params: { keyId: string } }>("/api/admin/keys/:keyId", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return { ok: platform.disableKey(request.params.keyId) };
  });
  app.get("/api/admin/usage", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    const query = request.query as { limit?: string; userId?: string };
    return platform.adminUsageRows(query.userId || undefined, Number(query.limit || 200));
  });
  app.get("/api/admin/users", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.adminUsers();
  });
  app.patch<{ Params: { userId: string } }>("/api/admin/users/:userId", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try {
      const user = platform.updateUser(request.params.userId, bodyOf(request));
      return user ?? reply.status(404).send({ error: "User not found" });
    } catch (error) { return apiError(reply, error); }
  });
  app.get<{ Params: { userId: string } }>("/api/admin/users/:userId/balance-entries", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.balanceEntries(request.params.userId, Number((request.query as { limit?: string }).limit || 100));
  });
  app.get("/api/admin/orders", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.orders();
  });
  app.get("/api/admin/settings", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    return platform.getAdminSettings();
  });
  app.put("/api/admin/settings", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try { return platform.saveAdminSettings(bodyOf(request)); } catch (error) { return apiError(reply, error); }
  });
  app.post("/api/admin/email-test", async (request, reply) => {
    if (!await requireAdmin(request, reply, platform, auth)) return;
    try { await platform.sendTestEmail(bodyOf(request).email); return { ok: true }; }
    catch (error) { return apiError(reply, error, 503); }
  });

  app.post("/api/auth/email-code", async (request, reply) => {
    if (!allowSameOriginMutation(request, reply, platform)) return;
    const body = bodyOf(request);
    if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return reply.status(400).send({ error: "请输入有效邮箱地址" });
    }
    if (body.purpose !== "register" && body.purpose !== "login") return reply.status(400).send({ error: "验证码用途无效" });
    if (!platform.isProviderMode()) return reply.status(503).send({ error: "服务商模式尚未启用" });

    void platform.sendEmailCode(body.email, body.purpose)
      .catch(error => request.log.error({ err: error }, "Email verification code delivery failed"));
    return { ok: true, message: "如果邮箱符合条件，验证码将发送至邮箱。" };
  });
  for (const purpose of ["register", "login"] as const) {
    app.post(`/api/auth/${purpose}`, async (request, reply) => {
      if (!allowSameOriginMutation(request, reply, platform)) return;
      try {
        const result = platform.loginWithCode(bodyOf(request).email, purpose, bodyOf(request).code);
        reply.header("set-cookie", sessionCookie(request, result.token, 30 * 24 * 60 * 60));
        return { ok: true, email: result.email };
      } catch (error) { return apiError(reply, error, 401); }
    });
  }
  app.get("/api/auth/me", async (request, reply) => {
    const session = platform.getSession(cookie(request, "omm_session"));
    if (session?.role !== "user") return reply.status(401).send({ error: "Sign in required" });
    return { ok: true, email: session.email };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    if (cookie(request, "omm_session") && !allowSameOriginMutation(request, reply, platform)) return;
    platform.revokeSession(cookie(request, "omm_session"));
    reply.header("set-cookie", sessionCookie(request, "", 0));
    return { ok: true };
  });
  app.get("/api/user/dashboard", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.userDashboard(userId);
  });
  app.get("/api/user/models", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.listPublicModels();
  });
  app.get("/api/user/key-models", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.keyModelOptions();
  });
  app.get("/api/user/keys", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.listKeys(userId);
  });
  app.post("/api/user/keys", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    try {
      const body = bodyOf(request);
      return platform.createUserKey(userId, body.name, body.tokenLimit, body.rpmLimit, body.modelFilter);
    } catch (error) { return apiError(reply, error); }
  });
  app.patch<{ Params: { keyId: string } }>("/api/user/keys/:keyId", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    try {
      const body = bodyOf(request);
      const key = platform.updateKeyLimits(request.params.keyId, body.tokenLimit, body.rpmLimit, userId, body.modelFilter);
      return key ?? reply.status(404).send({ error: "API Key not found" });
    } catch (error) { return apiError(reply, error); }
  });
  app.delete<{ Params: { keyId: string } }>("/api/user/keys/:keyId", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return { ok: platform.disableKey(request.params.keyId, userId) };
  });
  app.get("/api/user/usage", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.usageRows(userId, Number((request.query as any)?.limit || 100));
  });
  app.get("/api/user/balance-entries", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.balanceEntries(userId, Number((request.query as any)?.limit || 100));
  });
  app.get("/api/user/orders", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    return platform.orders(userId);
  });
  app.post("/api/user/orders", async (request, reply) => {
    const userId = requireUser(request, reply, platform); if (!userId) return;
    try {
      const base = platform.getAdminSettings().publicUrl;
      return platform.createOrder(userId, bodyOf(request).amount, `${base.replace(/\/$/, "")}/console?payment=return`);
    } catch (error) { return apiError(reply, error); }
  });
  app.post("/api/payments/alipay/notify", { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!platform.processAlipayNotification(bodyOf(request))) return reply.type("text/plain; charset=utf-8").status(400).send("failure");
    return reply.type("text/plain; charset=utf-8").send("success");
  });
}
