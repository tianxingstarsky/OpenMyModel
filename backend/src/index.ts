import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import { loadConfig } from "./config";
import { initDatabase } from "./db/schema";
import { registerOpenAIRoutes } from "./routes/openai";
import { registerAdminRoutes } from "./routes/admin";
import { wsTunnel, startHeartbeat } from "./services/websocket";

/**
 * OutMyModel 云后端入口
 */

async function main() {
  // 初始化数据库
  initDatabase();

  // 加载配置
  const config = loadConfig();

  if (!config.setupComplete) {
    console.log("");
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║  OutMyModel 云后端尚未初始化                  ║");
    console.log("║  请运行 npm run setup 完成初始配置            ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log("");
    process.exit(0);
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
  app.get("/", async () => ({
    name: "OutMyModel Cloud API",
    version: "1.0.0",
    domain: config.domain,
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
    console.log(`║  OutMyModel 云服务已启动                      ║`);
    console.log(`║  地址: http://0.0.0.0:${config.port}                  ║`);
    console.log(`║  域名: ${config.domain.padEnd(35)}║`);
    console.log("╚══════════════════════════════════════════════╝");
    console.log("");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();