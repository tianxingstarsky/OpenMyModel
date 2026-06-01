with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    c = f.read()
c = c.replace("_testApiKey = newKey['key']", "_testApiKey = newKey['key'] as String")
with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(c)
print("fixed")
