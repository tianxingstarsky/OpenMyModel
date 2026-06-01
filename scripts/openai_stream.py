with open(r"F:\llama_cpp\output_my_model\backend\src\routes\openai.ts", "r", encoding="utf-8") as f:
    c = f.read()

# Replace streaming section: write chunks immediately as they arrive via onChunk
old_stream = """      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        const result: any = await wsTunnel.forwardToNode(node.nodeId, body);
        if (result?.chunks) for (const c of result.chunks) reply.raw.write("data: " + JSON.stringify(c) + "\n\n");
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }"""

new_stream = """      if (stream) {
        reply.hijack();
        reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        // Real streaming: write each chunk to client as it arrives from WS
        await wsTunnel.forwardToNode(node.nodeId, body, (chunk: any) => {
          reply.raw.write("data: " + JSON.stringify(chunk) + "\n\n");
        });
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
      }"""

c = c.replace(old_stream, new_stream)

with open(r"F:\llama_cpp\output_my_model\backend\src\routes\openai.ts", "w", encoding="utf-8") as f:
    f.write(c)

print("openai.ts: real streaming writes")
