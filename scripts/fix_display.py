with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    c = f.read()

# Fix the key display line
old_line = "Text('月:  tokens /  累计'"
new_line = "Text('月: ${k[\"monthlyTokens\"]} tokens / ${k[\"totalTokens\"]} 累计'"
c = c.replace(old_line, new_line)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(c)

print("fixed")
