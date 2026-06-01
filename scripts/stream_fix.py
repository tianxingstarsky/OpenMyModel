with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "r", encoding="utf-8") as f:
    c = f.read()

# 1. Update interface to include collectedChunks
c = c.replace(
    """pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
  }>;""",
    """pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timeout: NodeJS.Timeout;
    collectedChunks?: any[];
  }>;"""
)

# 2. Init collectedChunks in forwardToNode
c = c.replace(
    "conn.pendingRequests.set(requestId, { resolve, reject, timeout });",
    "conn.pendingRequests.set(requestId, { resolve, reject, timeout, collectedChunks: [] });"
)

# 3. Add chat_chunk handler and update chat_response
old_chat = "case \"chat_response\":"
new_block = """case "chat_chunk":
              const pc = conn.pendingRequests.get(msg.requestId);
              if (pc && msg.data?.chunks) {
                clearTimeout(pc.timeout);
                pc.collectedChunks!.push(...msg.data.chunks);
                pc.timeout = setTimeout(() => {
                  conn.pendingRequests.delete(msg.requestId);
                  pc.resolve({ chunks: pc.collectedChunks || [] });
                }, this.requestTimeout);
              }
              break;

            case "chat_response":"""
c = c.replace(old_chat, new_block)

# 4. Update chat_response to handle streaming completion
old_resolve = """const pending = conn.pendingRequests.get(msg.requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                conn.pendingRequests.delete(msg.requestId);
                pending.resolve(msg.data);
              }"""
new_resolve = """const pending = conn.pendingRequests.get(msg.requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                conn.pendingRequests.delete(msg.requestId);
                if (msg.data?.chunks && msg.data.chunks.length === 0 && pending.collectedChunks) {
                  pending.resolve({ chunks: pending.collectedChunks });
                } else {
                  pending.resolve(msg.data);
                }
              }"""
c = c.replace(old_resolve, new_resolve)

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "w", encoding="utf-8") as f:
    f.write(c)

print("websocket.ts: progressive streaming support added")
