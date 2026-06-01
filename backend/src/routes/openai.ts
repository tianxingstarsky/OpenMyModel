import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { validateApiKey, recordUsage } from "../services/key_manager";
import { wsTunnel } from "../services/websocket";

/**
 * OpenAI 兼容 API 路由
 * 对外暴露标准 OpenAI 接口格式
 * 支持多模态（图片输入）
 */

interface ChatMessage {
  role: string;
  content: string | Array<{
    type: string;
    text?: string;
    image_url?: { url: string };
  }>;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string;
}

export function registerOpenAIRoutes(app: FastifyInstance): void {
  // ==================== GET /v1/models ====================
  app.get("/v1/models", async (request: FastifyRequest, reply: FastifyReply) => {
    const nodes = wsTunnel.getOnlineNodes();
    const models = nodes.map((n) => ({
      id: n.modelName || "local-model",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: n.name,
    }));

    // 如果没有在线节点，返回默认
    if (models.length === 0) {
      models.push({
        id: "local-model",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "outmymodel",
      });
    }

    return { object: "list", data: models };
  });

  // ==================== POST /v1/chat/completions ====================
  app.post("/v1/chat/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    // 验证 API Key
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({
        error: { message: "缺少 API Key，请在 Authorization header 中提供 Bearer token", type: "authentication_error" },
      });
    }

    const apiKey = authHeader.slice(7);
    const keyInfo = validateApiKey(apiKey);
    if (!keyInfo) {
      return reply.status(401).send({
        error: { message: "无效的 API Key", type: "authentication_error" },
      });
    }

    // 检查 token 限制
    if (keyInfo.tokenLimit > 0 && keyInfo.monthlyTokens >= keyInfo.tokenLimit) {
      return reply.status(429).send({
        error: { message: "API Key 本月用量已达上限", type: "rate_limit_error" },
      });
    }

    const body = request.body as ChatCompletionRequest;
    const stream = body.stream || false;

    // 获取可用节点
    const node = wsTunnel.getAvailableNode();
    if (!node) {
      return reply.status(503).send({
        error: { message: "暂无可用算力节点在线", type: "server_error" },
      });
    }

    const ip = (request.headers["x-forwarded-for"] as string) || request.ip;
    const userAgent = request.headers["user-agent"] as string;

    try {
      if (stream) {
        // 流式响应 (SSE)
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const result = await wsTunnel.forwardToNode(node.nodeId, {
          type: "chat_completion",
          model: body.model,
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          top_p: body.top_p ?? 0.9,
          max_tokens: body.max_tokens ?? 4096,
          stream: true,
        });

        // 转发流式响应
        if (result && result.chunks) {
          for (const chunk of result.chunks) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        }
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();

        // 记录用量（流式模式下估算）
        recordUsage(keyInfo.id, body.model, "/v1/chat/completions", 0, 0, ip, userAgent);
      } else {
        // 非流式响应
        const result = await wsTunnel.forwardToNode(node.nodeId, {
          type: "chat_completion",
          model: body.model,
          messages: body.messages,
          temperature: body.temperature ?? 0.7,
          top_p: body.top_p ?? 0.9,
          max_tokens: body.max_tokens ?? 4096,
          stream: false,
        });

        // 记录用量
        const usage = result?.usage || {};
        recordUsage(
          keyInfo.id, body.model, "/v1/chat/completions",
          usage.prompt_tokens || 0,
          usage.completion_tokens || 0,
          ip, userAgent,
        );

        return result;
      }
    } catch (err: any) {
      if (stream) {
        reply.raw.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error" } })}\n\n`);
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      } else {
        return reply.status(500).send({
          error: { message: err.message, type: "server_error" },
        });
      }
    }
  });

  // ==================== POST /v1/completions ====================
  // 兼容旧版文本补全接口
  app.post("/v1/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: { message: "请使用 /v1/chat/completions 接口", type: "not_implemented" },
    });
  });
}