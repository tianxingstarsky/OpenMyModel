with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    c = f.read()

# Fix: Authorization header missing _testApiKey
c = c.replace("'Authorization': 'Bearer '", "'Authorization': 'Bearer $_testApiKey'")

# Fix: revoke URL missing $d
c = c.replace(
    "Uri.parse('http:///admin/keys/",
    "Uri.parse('http://$d/admin/keys/"
)

# Fix: update setState for testApiKey loading in _loadKeys
# The _loadKeys should also set _testApiKey
old_load = """if (keys.isNotEmpty) {
          final active = keys.firstWhere((k) => k['isActive'] == true, orElse: () => keys.first);
          _testApiKey = active['key'] ?? '';
        }"""
new_load = """if (keys.isNotEmpty) {
          final active = keys.firstWhere((k) => k['isActive'] == true, orElse: () => keys.first);
          _testApiKey = active['key'] ?? '';
        }"""
# This should already be there

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(c)

print("fixed")
