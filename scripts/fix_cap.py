with open(r"F:\llama_cpp\output_my_model\backend\src\routes\openai.ts", "r", encoding="utf-8") as f:
    c = f.read()

# Replace body processing to add max_tokens cap
old_body = """    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    const isStream = rawBody.includes('"stream":true');"""

new_body = """    let rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body || {});
    // 安全兜底: max_tokens 未设置或 -1 时设默认值，防止 Qwen 无限思考
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed.max_tokens == null || parsed.max_tokens < 0) {
        parsed.max_tokens = 4096;
        rawBody = JSON.stringify(parsed);
      }
    } catch (_) {}
    const isStream = rawBody.includes('"stream":true');"""

c = c.replace(old_body, new_body)

with open(r"F:\llama_cpp\output_my_model\backend\src\routes\openai.ts", "w", encoding="utf-8") as f:
    f.write(c)

print("cap added")
