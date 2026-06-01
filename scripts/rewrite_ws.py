import re

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "r", encoding="utf-8") as f:
    c = f.read()

# 1. Remove old sync_apiKeys helpers (they're on the class now)
# Find and replace entire file structure - easier to replace specific methods

# 2. Add relayHttp method to the class before forwardToNode
old_forward = "  /** 转发聊天请求到本地节点，等待响应 */"
new_method = """  /** 原始 HTTP 镜像转发 —— 将 HTTP 请求原样转发到本地节点，原样返回 */
  relayHttp(
    nodeId: string,
    req: { method: string; path: string; headers: Record<string,string>; body: string },
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
          if (typeof data === "object" && data !== null) {
            resolve(data);
          } else {
            resolve(chunks.join(""));
          }
        },
        reject: (err: any) => { clearTimeout(timeout); reject(err); },
        timeout,
        rawChunks: chunks,
        onRawChunk: onChunk,
      });

      conn.ws.send(JSON.stringify({
        type: "http_relay",
        requestId,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: req.body,
      }));
    });
  }

  """ + old_forward
c = c.replace(old_forward, new_method)

# 3. Update pendingRequests interface for raw relay
c = c.replace(
    "collectedChunks?: any[];\n    onChunk?: (chunk: any) => void;",
    "collectedChunks?: any[];\n    onChunk?: (chunk: any) => void;\n    rawChunks?: string[];\n    onRawChunk?: (chunk: string) => void;"
)

# 4. Update websocket message handlers at the top of the switch
# Find "已认证的消息处理" section
old_auth = """          // 已认证的消息处理
          switch (msg.type) {"""
new_auth = """          // 已认证的消息处理
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
"""
c = c.replace(old_auth, new_auth)

# 5. Update sync_keys to also update allowed keys
old_sync = """case "sync_keys":
              if (msg.keys && Array.isArray(msg.keys)) {
                syncApiKeys(msg.keys);
                socket.send(JSON.stringify({ type: "keys_synced", keys: getSyncedKeys() }));
              }
              break;"""
new_sync = """case "sync_keys":
              if (msg.keys && Array.isArray(msg.keys)) {
                syncApiKeys(msg.keys);
                // 更新内存中的允许 key 列表
                const activeKeys = msg.keys.filter((k: any) => k.isActive !== false).map((k: any) => k.key);
                if ((global as any).__setAllowedKeys) (global as any).__setAllowedKeys(activeKeys);
                socket.send(JSON.stringify({ type: "keys_synced", keys: getSyncedKeys() }));
              }
              break;"""
c = c.replace(old_sync, new_sync)

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "w", encoding="utf-8") as f:
    f.write(c)
print("websocket.ts rewritten with relayHttp")
