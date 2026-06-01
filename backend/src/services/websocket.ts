import { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { verifyAdminPassword } from "./auth";
import { nodes, db } from "../db/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

/**
 * WebSocket 隧道管理器
 * - 接受本地 Flutter 客户端的连接
 * - 将外部 API 请求转发到本地节点
 * - API Key 验证由 Flutter 本地处理，服务器不存储任何 Key
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
    rawChunks?: string[];
    onRawChunk?: (chunk: string) => void;
  }>;
}

class WebSocketTunnel {
  private connections: Map<string, TunnelConnection> = new Map();
  private requestTimeout = 120000;

  registerRoutes(app: FastifyInstance): void {
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

                console.log(`Node connected: ${conn.nodeName} (${conn.nodeId})`);
              } else {
                socket.send(JSON.stringify({ type: "auth_error", message: "密码错误，认证失败" }));
                socket.close();
              }
            } else {
              socket.send(JSON.stringify({ type: "auth_required", message: "请先发送认证消息" }));
            }
            return;
          }

          switch (msg.type) {
            case "http_chunk":
              const prc = conn.pendingRequests.get(msg.requestId);
              if (prc && msg.data != null) {
                clearTimeout(prc.timeout);
                prc.rawChunks!.push(msg.data);
                if (prc.onRawChunk) prc.onRawChunk(msg.data);
                prc.timeout = setTimeout(() => {
                  conn.pendingRequests.delete(msg.requestId);
                  prc.resolve(prc.rawChunks!.join(""));
                }, this.requestTimeout);
              }
              break;

            case "http_done":
              const prd = conn.pendingRequests.get(msg.requestId);
              if (prd) {
                clearTimeout(prd.timeout);
                conn.pendingRequests.delete(msg.requestId);
                prd.resolve(prd.rawChunks ? prd.rawChunks.join("") : "");
              }
              break;

            case "key_valid":
              // Flutter validates key locally and responds here
              const kv = conn.pendingRequests.get(msg.requestId);
              if (kv) {
                clearTimeout(kv.timeout);
                conn.pendingRequests.delete(msg.requestId);
                kv.resolve(msg.valid === true);
              }
              break;

            case "pong":
              this.updateHeartbeat(conn.nodeId);
              break;

            case "status_update":
              conn.modelName = msg.modelName || conn.modelName;
              this.updateNodeInfo(conn.nodeId, conn.modelName);
              break;
          }
        } catch (e) {
          console.error("WebSocket msg parse error:", e);
        }
      });

      socket.on("close", () => {
        if (conn.nodeId) {
          this.connections.delete(conn.nodeId);
          this.markNodeOffline(conn.nodeId);
          console.log(`Node disconnected: ${conn.nodeName} (${conn.nodeId})`);
        }
      });

      socket.on("error", (err) => {
        console.error("WebSocket error:", err.message);
      });
    });
  }

  /** 验证 API Key —— 发给 Flutter 本地验证，云端不存任何 Key */
  async validateKey(apiKey: string, nodeId: string): Promise<boolean> {
    const conn = this.connections.get(nodeId);
    if (!conn) return false;

    return new Promise((resolve) => {
      const requestId = uuidv4();
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        resolve(false);
      }, 10000); // 10s 超时

      conn.pendingRequests.set(requestId, { resolve, reject: () => resolve(false), timeout });
      conn.ws.send(JSON.stringify({ type: "validate_key", requestId, key: apiKey }));
    });
  }

  /** 原始 HTTP 镜像转发 */
  relayHttp(
    nodeId: string,
    req: { path: string; body: string },
    onChunk?: (chunk: string) => void,
  ): Promise<any> {
    const conn = this.connections.get(nodeId);
    if (!conn) return Promise.reject(new Error("节点未连接"));

    return new Promise((resolve, reject) => {
      const requestId = uuidv4();
      const chunks: string[] = [];
      const timeout = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        reject(new Error("请求超时"));
      }, this.requestTimeout);

      conn.pendingRequests.set(requestId, {
        resolve: (data: any) => {
          clearTimeout(timeout);
          if (typeof data === "object" && data !== null) resolve(data);
          else resolve(chunks.join(""));
        },
        reject: (err: any) => { clearTimeout(timeout); reject(err); },
        timeout,
        rawChunks: chunks,
        onRawChunk: onChunk,
      });

      conn.ws.send(JSON.stringify({
        type: "http_relay",
        requestId,
        path: req.path,
        body: req.body,
      }));
    });
  }

  getOnlineNodes(): any[] {
    const result: any[] = [];
    for (const [id, conn] of this.connections) {
      result.push({ id, name: conn.nodeName, modelName: conn.modelName, isOnline: true });
    }
    return result;
  }

  getAvailableNode(): TunnelConnection | null {
    for (const conn of this.connections.values()) {
      if (conn.authenticated) return conn;
    }
    return null;
  }

  private registerNode(conn: TunnelConnection): void {
    const now = new Date().toISOString();
    const existing = db.select().from(nodes).where(eq(nodes.id, conn.nodeId)).all();
    if (existing.length > 0) {
      db.update(nodes).set({ isOnline: true, lastHeartbeat: now, modelName: conn.modelName, modelConfig: conn.modelConfig })
        .where(eq(nodes.id, conn.nodeId)).run();
    } else {
      db.insert(nodes).values({
        id: conn.nodeId, name: conn.nodeName, connectedAt: now, lastHeartbeat: now,
        isOnline: true, modelName: conn.modelName, modelConfig: conn.modelConfig,
      }).run();
    }
  }

  private updateHeartbeat(nodeId: string): void {
    db.update(nodes).set({ lastHeartbeat: new Date().toISOString(), isOnline: true })
      .where(eq(nodes.id, nodeId)).run();
  }

  private updateNodeInfo(nodeId: string, modelName: string): void {
    db.update(nodes).set({ modelName, lastHeartbeat: new Date().toISOString() })
      .where(eq(nodes.id, nodeId)).run();
  }

  private markNodeOffline(nodeId: string): void {
    db.update(nodes).set({ isOnline: false, lastHeartbeat: new Date().toISOString() })
      .where(eq(nodes.id, nodeId)).run();
  }
}

export function startHeartbeat(tunnel: WebSocketTunnel): void {
  setInterval(() => {
    for (const conn of (tunnel as any).connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: "ping" }));
      }
    }
  }, 30000);
}

export const wsTunnel = new WebSocketTunnel();
