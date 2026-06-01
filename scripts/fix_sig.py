with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "r", encoding="utf-8") as f:
    c = f.read()

# Fix method signature
c = c.replace(
    "method: string; path: string; headers: Record<string,string>; body: string",
    "path: string; body: string"
)

# Fix WS send message
c = c.replace(
    'type: "http_relay",\n        requestId,\n        method: req.method,\n        path: req.path,\n        headers: req.headers,\n        body: req.body,',
    'type: "http_relay",\n        requestId,\n        path: req.path,\n        body: req.body,'
)

with open(r"F:\llama_cpp\output_my_model\backend\src\services\websocket.ts", "w", encoding="utf-8") as f:
    f.write(c)
print("fixed")
