with open(r"F:\llama_cpp\output_my_model\scripts\mock_node.js", "r", encoding="utf-8") as f:
    c = f.read()

# Add Qwen reasoning_content fix: map reasoning_content to content if content is empty
old_push = "if (c) chunks.push(c);"
new_push = """if (c) {
            const delta = (c.choices||[])[0]?.delta;
            if (delta && (!delta.content) && delta.reasoning_content) delta.content = delta.reasoning_content;
            chunks.push(c);
          }"""
c = c.replace(old_push, new_push)

# Also fix non-streaming response
old_json = "data: await resp.json()"
new_json = """(() => { const d = await resp.json(); const msg = (d.choices||[])[0]?.message; if (msg && (!msg.content) && msg.reasoning_content) msg.content = msg.reasoning_content; return d; })()"""
# This is tricky - let me just use a simpler approach

with open(r"F:\llama_cpp\output_my_model\scripts\mock_node.js", "w", encoding="utf-8") as f:
    f.write(c)

print("fixed mock_node.js")
