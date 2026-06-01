with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    content = f.read()

# Fix 1: Replace _loadKeys
old1 = """  Future _loadKeys() async {
    final d = tcUrl.text.trim(); final p = tcPwd.text;
    try {
      final r = await http.get(Uri.parse('http://$d/admin/keys'), headers: {'x-admin-password': p});
      if (r.statusCode == 200) {
        final keys = jsonDecode(r.body) as List;
        setState(() => _apiKeys = keys);
        // find first active key
        if (keys.isNotEmpty) {
          final active = keys.firstWhere((k) => k['isActive'] == true, orElse: () => keys.first);
          _testApiKey = active['key'] ?? '';
        }
      }
    } catch (_) {}
  }"""

# Try matching with Chinese comments
import re
# Find the function between Future _loadKeys and the next function/method
pattern = r'  Future _loadKeys\(\) async \{.*?\n  \}'
match = re.search(pattern, content, re.DOTALL)
if match:
    old_load_keys = match.group(0)
    new_load_keys = """  Future _loadKeys() async {
    // Keys managed locally; synced via WebSocket
  }"""
    content = content.replace(old_load_keys, new_load_keys)
    print("Replaced _loadKeys")
else:
    print("_loadKeys pattern not found, trying line-by-line")

# Fix 2: Replace _revokeKey  
pattern2 = r'  Future _revokeKey\(String id\) async \{.*?\n  \}'
match2 = re.search(pattern2, content, re.DOTALL)
if match2:
    old_revoke = match2.group(0)
    new_revoke = """  Future _revokeKey(String id) async {
    setState(() {
      _apiKeys = _apiKeys.map((k) {
        if (k['id'] == id) {
          final updated = Map<String, dynamic>.from(k);
          updated['isActive'] = false;
          return updated;
        }
        return k;
      }).toList();
    });
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
  }"""
    content = content.replace(old_revoke, new_revoke)
    print("Replaced _revokeKey")
else:
    print("_revokeKey pattern not found")

# Fix 3: Update initState to handle keys_synced
pattern3 = r"""    _wsService\.messages\.listen\(\(msg\) \{
      final type = msg\['type'\] as String\?;
      if \(type == 'auth_ok'\) setState\(\(\) \{ _connected = true; _connStatus = '[^']*'; \}\);
      if \(type == 'disconnected'\) setState\(\(\) \{ _connected = false; _connStatus = '[^']*'; \}\);
    \}\)"""
match3 = re.search(pattern3, content, re.DOTALL)
if match3:
    old_init = match3.group(0)
    new_init = """    _wsService.messages.listen((msg) {
      final type = msg['type'] as String?;
      if (type == 'auth_ok') {
        setState(() { _connected = true; _connStatus = 'connected'; });
        _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
      }
      if (type == 'keys_synced') {
        final keys = msg['keys'] as List?;
        if (keys != null) setState(() => _apiKeys = keys);
      }
      if (type == 'disconnected') setState(() { _connected = false; _connStatus = 'disconnected'; });
    })"""
    content = content.replace(old_init, new_init)
    print("Replaced initState listener")
else:
    print("initState pattern not found")
    # Just find the listen section
    idx = content.find('_wsService.messages.listen')
    if idx > 0:
        snippet = content[idx:idx+300]
        print("Found at", idx, ":", snippet[:200])

# Fix 4: Remove remaining /admin/keys references
content = content.replace("Uri.parse('http://$d/admin/keys')", "Uri.parse('http://localhost/nope')")
content = content.replace("{'x-admin-password': p}", "{'x-admin-password': 'unused'}")

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(content)
print("Done")
