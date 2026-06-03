import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { loadConfig } from "./config";
import { initDatabase } from "./db/schema";
import { registerOpenAIRoutes } from "./routes/openai";
import { registerAdminRoutes } from "./routes/admin";
import { wsTunnel, startHeartbeat } from "./services/websocket";

/**
 * OpenMyModel 云后端入口
 */

async function main() {
  // 初始化数据库
  initDatabase();

  // 加载配置
  const config = loadConfig();

  if (!config.setupComplete) {
    // 自动初始化：生成随机密码，打印到日志
    const { createHash, randomBytes } = require("crypto");
    const autoPassword = randomBytes(8).toString("hex");
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(salt + autoPassword).digest("hex");
    config.passwordHash = salt + ":" + hash;
    config.setupComplete = true;
    const { saveConfig } = require("./config");
    saveConfig(config);
    console.log("");
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║  OpenMyModel - 首次启动，已自动初始化          ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log("");
    console.log("  ⚠ 自动生成的管理员密码（请妥善保存）：");
    console.log(`     ${autoPassword}`);
    console.log("");
    console.log("  修改密码：npm run setup → 选择「重置密码」");
    console.log("");
  }

  // 创建 Fastify 实例
  const app = Fastify({
    logger: {
      level: "info",
      transport: {
        target: "pino-pretty",
        options: { colorize: true },
      },
    },
  });

  // 注册 CORS
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-password"],
  });

  // 注册 WebSocket
  await app.register(fastifyWebsocket);

  // 注册路由
  registerOpenAIRoutes(app);
  registerAdminRoutes(app);

  // 注册 WebSocket 隧道
  wsTunnel.registerRoutes(app);

  // 启动心跳
  startHeartbeat(wsTunnel);

  // 健康检查
  app.get("/", async (request) => ({
    name: "OpenMyModel Cloud API",
    version: "1.0.0",
    domain: request.hostname || 'localhost',
    endpoints: {
      models: "/v1/models",
      chat: "/v1/chat/completions",
      admin: "/admin/*",
      websocket: "/ws/node",
    },
  }));

  // 启动服务
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    console.log("");
    console.log("╔══════════════════════════════════════════════╗");
    console.log(`║  OpenMyModel 云服务已启动                      ║`);
    console.log(`║  地址: http://0.0.0.0:${config.port}                  ║`);
    console.log("╚══════════════════════════════════════════════╝");
    console.log("");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();