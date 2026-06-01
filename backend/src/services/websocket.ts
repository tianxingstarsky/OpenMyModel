import { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { verifyAdminPassword } from "./auth";
import { nodes, db, apiKeys as apiKeysTable } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

/**
 * WebSocket 隧道管理器
 * - 接受本地 Flutter 客户端的连接
 * - 将外部 API 请求转发到本地节点
 * - 管理活跃节点
 */

interface TunnelConnection {
  ws: WebSocket;
  nodeId: string;
  nodeName: string;
  modelName: string;
  modelConfig: string;
  authenticated: boolean;
  pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>;
}

function syncApiKeys(keys) {
  const existingIds = new Set(db.select({id: apiKeysTable.id}).from(apiKeysTable).all().map(r => r.id));
  for (const k of keys) {
    if (existingIds.has(k.id)) {
      db.update(apiKeysTable).set({ name: k.name, key: k.key, isActive: k.isActive !== false, tokenLimit: k.tokenLimit || 0 })
        .where(eq(apiKeysTable.id, k.id)).run();
    } else {
      try {
        db.insert(apiKeysTable).values({
          id: k.id, name: k.name, key: k.key, createdAt: k.createdAt || new Date().toISOString(),
          isActive: k.isActive !== false, totalTokens: 0, totalRequests: 0,
          monthlyTokens: 0, monthlyRequests: 0, tokenLimit: k.tokenLimit || 0,
        }).run();
      } catch (_) {}
    }
  }
  const syncIds = new Set(keys.map(k => k.id));
  for (const id of existingIds) {
    if (!syncIds.has(id)) db.update(apiKeysTable).set({ isActive: false }).where(eq(apiKeysTable.id, id)).run();
  }
}
function getSyncedKeys() {
  return db.select().from(apiKeysTable).all();
}

class WebSocketTunnel {
  private connections: Map<string, TunnelConnection> = new Map();
  private requestTimeout = 120000; // 2 分钟超时

  registerRoutes(app: FastifyInstance): void {
    // 本地节点 WebSocket 连接端点
    app.get("/ws/node", { websocket: true }, (socket, req) => {
      const conn: TunnelConnection = {
        ws: socket,
        nodeId: "",
        nodeName: "未知节点",
        modelName: "",
        modelConfig: "",
        authenticated: false,
        pendingRequests: new Map(),
      };

      socket.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (!conn.authenticated) {
            // 第一条消息必须是认证
            if (msg.type === "auth") {
              if (verifyAdminPassword(msg.password)) {
                conn.authenticated = true;
                conn.nodeId = msg.nodeId || uuidv4();
                conn.nodeName = msg.nodeName || "未命名节点";
                conn.modelName = msg.modelName || "";
                conn.modelConfig = msg.modelConfig || "";

                this.connections.set(conn.nodeId, conn);
                this.registerNode(conn);

                socket.send(JSON.stringify({
                  type: "auth_ok",
                  nodeId: conn.nodeId,
                  message: "认证成功，已连接到 OutMyModel 云服务",
                }));

                console.log(`✅ 节点已连接: ${conn.nodeName} (${conn.nodeId})`);
              } else {
                socket.send(JSON.stringify({
                  type: "auth_error",
                  message: "密码错误，认证失败",
                }));
                socket.close();
              }
            } else {
              socket.send(JSON.stringify({
                type: "auth_required",
                message: "请先发送认证消息",
              }));
            }
            return;
          }

          // 已认证的消息处理
          switch (msg.type) {
            case "pong":
              this.updateHeartbeat(conn.nodeId);
              break;

            case "chat_response":
              // 将本地模型的响应返回给等待中的 HTTP 请求
              const pending = conn.pendingRequests.get(msg.requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                conn.pendingRequests.delete(msg.requestId);
                pending.resolve(msg.data);
              }
              break;

            case "chat_error":
              const pendingErr = conn.pendingRequests.get(msg.requestId);
              if (pendingErr) {
                clearTimeout(pendingErr.timeout);
                conn.pendingRequests.delete(msg.requestId);
                pendingErr.reject(new Error(msg.error));
              }
              break;

            case "status_update":
              conn.modelName = msg.modelName || conn.modelName;
              this.updateNodeInfo(conn.nodeId, conn.modelName);
              break;

            case "sync_keys":
              if (msg.keys && Array.isArray(msg.keys)) {
                syncApiKeys(msg.keys);
                socket.send(JSON.stringify({ type: "keys_synced", keys: getSyncedKeys() }));
              }
              break;
          }
        } catch (e) {
          console.error("WebSocket 消息解析错误:", e);
        }
      });

      socket.on("close", () => {
        if (conn.nodeId) {
          this.connections.delete(conn.nodeId);
          this.markNodeOffline(conn.nodeId);
          console.log(`🔌 节点断开: ${conn.nodeName} (${conn.nodeId})`);
        }
      });

      socket.on("error", (err) => {
        console.error("WebSocket 错误:", err.message);
      });
    });
  }

  /** 转发聊天请求到本地节点，等待响应 */
  forwardToNode(
    nodeId: string,
    requestData: any,
  ): Promise<any> {
    const conn = this.connections.get(nodeId);
    if (!conn) {
      return Promise.reject(new Error("节点未连接"));
    }

    return new Promise((resolve, reject) => {
      const requestId = uuidv4();

      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error("请求超时：本地节点未响应"));
      }, this.requestTimeout);

      conn.pendingRequests.set(requestId, { resolve, reject, timeout });

      conn.ws.send(JSON.stringify({
        type: "chat_request",
        requestId,
        data: requestData,
      }));
    });
  }

  /** 获取在线节点列表 */
  getOnlineNodes(): any[] {
    const result: any[] = [];
    for (const [id, conn] of this.connections) {
      result.push({
        id,
        name: conn.nodeName,
        modelName: conn.modelName,
        online: true,
      });
    }
    return result;
  }

  /** 获取一个可用节点（目前返回第一个） */
  getAvailableNode(): TunnelConnection | null {
    for (const conn of this.connections.values()) {
      if (conn.authenticated) return conn;
    }
    return null;
  }

  private registerNode(conn: TunnelConnection): void {
    const now = new Date().toISOString();
    // 检查是否已存在
    const existing = db.select().from(nodes).where(eq(nodes.id, conn.nodeId)).all();
    if (existing.length > 0) {
      db.update(nodes).set({
        isOnline: true,
        lastHeartbeat: now,
        modelName: conn.modelName,
        modelConfig: conn.modelConfig,
      }).where(eq(nodes.id, conn.nodeId)).run();
    } else {
      db.insert(nodes).values({
        id: conn.nodeId,
        name: conn.nodeName,
        connectedAt: now,
        lastHeartbeat: now,
        isOnline: true,
        modelName: conn.modelName,
        modelConfig: conn.modelConfig,
      }).run();
    }
  }

  private updateHeartbeat(nodeId: string): void {
    db.update(nodes).set({
      lastHeartbeat: new Date().toISOString(),
      isOnline: true,
    }).where(eq(nodes.id, nodeId)).run();
  }

  private updateNodeInfo(nodeId: string, modelName: string): void {
    db.update(nodes).set({
      modelName,
      lastHeartbeat: new Date().toISOString(),
    }).where(eq(nodes.id, nodeId)).run();
  }

  private markNodeOffline(nodeId: string): void {
    db.update(nodes).set({
      isOnline: false,
      lastHeartbeat: new Date().toISOString(),
    }).where(eq(nodes.id, nodeId)).run();
  }
}

// 心跳定时器
let heartbeatInterval: NodeJS.Timeout | null = null;

export function startHeartbeat(tunnel: WebSocketTunnel): void {
  heartbeatInterval = setInterval(() => {
    for (const conn of tunnel["connections"].values() as Iterable<TunnelConnection>) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: "ping" }));
      }
    }
  }, 30000); // 每 30 秒心跳
}

export const wsTunnel = new WebSocketTunnel();