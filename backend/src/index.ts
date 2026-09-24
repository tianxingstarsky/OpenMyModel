import Fastify, { FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { ConfigStore } from "./config";
import { createDatabase, nodes } from "./db/schema";
import { registerOpenAIRoutes } from "./routes/openai";
import { registerAdminRoutes } from "./routes/admin";
import { TunnelOptions, WebSocketTunnel } from "./services/websocket";
import { AdminAuthenticator } from "./services/auth";
import { renderStatusPage } from "./statusPage";
import { registerPlatformRoutes } from "./routes/platform";
import { PlatformService } from "./services/platform";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseUrlEncoded } from "querystring";

export interface AppOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  configStore?: ConfigStore;
  logger?: FastifyServerOptions["logger"];
  tunnelOptions?: Omit<TunnelOptions, "authenticate" | "onNodeChange">;
  tunnel?: WebSocketTunnel;
  authLimit?: number;
  heartbeat?: boolean;
  publicUrl?: string;
}

export async function buildApp(options: AppOptions = {}) {
  const store = options.configStore ?? new ConfigStore(options.dataDir, options.env);
  const config = await store.initialize();
  if (!config.setupComplete || !config.passwordHash) {
    throw new Error("Set ADMIN_PASSWORD or run npm run setup before starting the backend");
  }
  const database = createDatabase(store.directory);
  const auth = new AdminAuthenticator(store, options.authLimit);
  const tunnel = options.tunnel ?? new WebSocketTunnel({
    ...options.tunnelOptions,
    authenticate: (password, address) => auth.authenticate(password, address),
    onNodeChange: node => {
      const now = new Date().toISOString();
      const record = { id: node.id, name: node.name, modelName: node.modelName, modelConfig: node.modelConfig,
        isOnline: node.isOnline, lastHeartbeat: now, connectedAt: now };
      const { connectedAt, ...update } = record;
      database.db.insert(nodes).values(record).onConflictDoUpdate({ target: nodes.id, set: update }).run();
    },
  });
  const platformService = new PlatformService(database.sqlite, store.directory, tunnel,
    options.publicUrl ?? process.env.PUBLIC_BASE_URL ?? "");
  const app = Fastify({
    bodyLimit: 32 * 1024 * 1024,
    logger: options.logger ?? {
      level: "info",
      redact: ["req.headers.authorization", "req.headers['x-admin-password']", "password", "body.password", "body.code",
      "body.mailPassword", "body.alipayPrivateKey", "body.alipayPublicKey", "body.upstreamKey", "body.apiKey"],
    },
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) reply.header("Cache-Control", "private, no-store");
    return payload;
  });
  app.decorate("tunnel", tunnel);
  // Close the tunnel before the websocket plugin waits for active sockets.
  app.addHook("preClose", async () => { tunnel.close(); });
  app.addHook("onClose", async () => { database.close(); });
  try {
    await app.register(cors, {
      origin: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "x-admin-password"],
    });
    app.addContentTypeParser(/^application\/[\w.+-]+\+json(?:;.*)?$/, { parseAs: "string" }, app.getDefaultJsonParser("error", "error"));
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      try { done(null, parseUrlEncoded(body as string)); } catch (error) { done(error as Error); }
    });
    await app.register(fastifyWebsocket, { options: { maxPayload: 40 * 1024 * 1024 } });
    registerOpenAIRoutes(app, tunnel, platformService);
    registerAdminRoutes(app, tunnel, auth);
    registerPlatformRoutes(app, platformService, auth);
    tunnel.registerRoutes(app);
    if (options.heartbeat !== false) tunnel.startHeartbeat();
    // Public status page (non-sensitive aggregates only) + machine-readable data.
    app.get("/brand-mark.png", async (_request, reply) => {
      reply.type("image/png").send(readFileSync(join(__dirname, "../public/brand-mark.png")));
    });
    app.get("/", async (_request, reply) => {
      reply.type("text/html; charset=utf-8").send(renderStatusPage());
    });
    app.get("/admin", async (_request, reply) => {
      reply.type("text/html; charset=utf-8").send(readFileSync(join(__dirname, "../public/admin.html"), "utf8"));
    });
    app.get("/dashboard", async (_request, reply) => {
      reply.type("text/html; charset=utf-8").send(readFileSync(join(__dirname, "../public/dashboard.html"), "utf8"));
    });
    app.get("/console", async (_request, reply) => {
      reply.type("text/html; charset=utf-8").send(readFileSync(join(__dirname, "../public/console.html"), "utf8"));
    });
    app.get("/status.json", async () => tunnel.statusSnapshot());
    app.get("/api", async request => ({
      name: "OpenMyModel Cloud API", version: "1.0.0", domain: request.hostname || "localhost",
      endpoints: { status: "/", statusData: "/status.json", models: "/v1/models", chat: "/v1/chat/completions", admin: "/admin", console: "/console", websocket: "/ws/node" },
    }));
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const store = new ConfigStore();
  const app = await buildApp({ configStore: store });
  const stop = async () => { await app.close(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await app.listen({ port: store.load().port, host: "0.0.0.0" });
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "Backend startup failed");
    process.exitCode = 1;
  });
}
