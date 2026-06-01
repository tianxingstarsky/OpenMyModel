with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "r", encoding="utf-8") as f:
    c = f.read()

# 1. Add onChunk to pendingRequests interface
c = c.replace(
    "collectedChunks?: any[];",
    "collectedChunks?: any[];\n    onChunk?: (chunk: any) => void;"
)

# 2. Update forwardToNode to accept onChunk callback
old_fn = "forwardToNode(\n    nodeId: string,\n    requestData: any,\n  ): Promise<any> {"
new_fn = "forwardToNode(\n    nodeId: string,\n    requestData: any,\n    onChunk?: (chunk: any) => void,\n  ): Promise<any> {"
c = c.replace(old_fn, new_fn)

# 3. Pass onChunk when setting pending request
c = c.replace(
    "conn.pendingRequests.set(requestId, { resolve, reject, timeout, collectedChunks: [] });",
    "conn.pendingRequests.set(requestId, { resolve, reject, timeout, collectedChunks: [], onChunk });"
)

# 4. In chat_chunk handler, call onChunk for each chunk immediately
old_chunk_handler = """case "chat_chunk":
              const pc = conn.pendingRequests.get(msg.requestId);
              if (pc && msg.data?.chunks) {
                clearTimeout(pc.timeout);
                pc.collectedChunks!.push(...msg.data.chunks);
                pc.timeout = setTimeout(() => {
                  conn.pendingRequests.delete(msg.requestId);
                  pc.resolve({ chunks: pc.collectedChunks || [] });
                }, this.requestTimeout);
              }
              break;"""

new_chunk_handler = """case "chat_chunk":
              const pc = conn.pendingRequests.get(msg.requestId);
              if (pc && msg.data?.chunks) {
                clearTimeout(pc.timeout);
                // Write each chunk to callback immediately (real streaming!)
                if (pc.onChunk) {
                  for (const c of msg.data.chunks) pc.onChunk(c);
                }
                pc.collectedChunks!.push(...msg.data.chunks);
                pc.timeout = setTimeout(() => {
                  conn.pendingRequests.delete(msg.requestId);
                  pc.resolve({ chunks: pc.collectedChunks || [] });
                }, this.requestTimeout);
              }
              break;"""

c = c.replace(old_chunk_handler, new_chunk_handler)

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "w", encoding="utf-8") as f:
    f.write(c)

print("websocket.ts: real streaming callbacks added")
