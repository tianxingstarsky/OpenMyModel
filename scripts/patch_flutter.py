import re

# ======= 1. Update websocket_service.dart =======
with open(r"F:\llama_cpp\output_my_model\frontend\lib\services\websocket_service.dart", "r", encoding="utf-8") as f:
    c = f.read()

# Add syncKeys method before disconnect
old = "  void disconnect"
new = """  void syncKeys(List<Map<String, dynamic>> keys) {
    if (_connected && _ch != null) {
      _ch!.sink.add(jsonEncode({'type':'sync_keys','keys':keys}));
    }
  }

  void disconnect"""
c = c.replace(old, new)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\services\websocket_service.dart", "w", encoding="utf-8") as f:
    f.write(c)

print("websocket_service.dart patched")

# ======= 2. Rewrite cloud_page.dart key management =======
with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    cloud = f.read()

# Replace _loadKeys to work via WS
old_load = """  Future _loadKeys() async {
    final d = tcUrl.text.trim(); final p = tcPwd.text;
    try {
      final r = await http.get(Uri.parse('http://$d/admin/keys'), headers: {'x-admin-password': p});
      if (r.statusCode == 200) {
        final keys = jsonDecode(r.body) as List;
        setState(() => _apiKeys = keys);
        if (keys.isNotEmpty) {
          final active = keys.firstWhere((k) => k['isActive'] == true, orElse: () => keys.first);
          _testApiKey = active['key'] ?? '';
        }
      }
    } catch (_) {}
  }"""
new_load = """  Future _loadKeys() async {
    // Keys are managed locally and synced via WebSocket
    // No HTTP call needed
  }"""
cloud = cloud.replace(old_load, new_load)

# Replace _createKey to work locally
old_create = """  Future _createKey() async {
    final d = tcUrl.text.trim(); final n = tcKeyName.text.trim(); final l = int.tryParse(tcKeyLimit.text) ?? 0;
    if (n.isEmpty) return;
    try {
      await http.post(Uri.parse('http://$d/admin/keys'),
        headers: {'Content-Type': 'application/json', 'x-admin-password': tcPwd.text},
        body: jsonEncode({'name': n, 'tokenLimit': l}));
      tcKeyName.clear(); tcKeyLimit.clear(); _loadKeys();
    } catch (_) {}
  }"""
new_create = """  String _genKey() {
    final r = List.generate(48, (_) => '0123456789abcdef'[DateTime.now().microsecondsSinceEpoch % 16]);
    return 'sk-oom-${r.join()}';
  }

  Future _createKey() async {
    final n = tcKeyName.text.trim(); final l = int.tryParse(tcKeyLimit.text) ?? 0;
    if (n.isEmpty) return;
    final newKey = {
      'id': DateTime.now().millisecondsSinceEpoch.toRadixString(36),
      'name': n,
      'key': _genKey(),
      'createdAt': DateTime.now().toIso8601String(),
      'isActive': true,
      'totalTokens': 0, 'totalRequests': 0,
      'monthlyTokens': 0, 'monthlyRequests': 0,
      'tokenLimit': l,
    };
    setState(() {
      _apiKeys = [..._apiKeys, newKey];
      if (_testApiKey.isEmpty) _testApiKey = newKey['key'];
    });
    tcKeyName.clear(); tcKeyLimit.clear();
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
  }"""
cloud = cloud.replace(old_create, new_create)

# Replace _revokeKey to work locally
old_revoke = """  Future _revokeKey(String id) async {
    try { await http.delete(Uri.parse('http://${tcUrl.text.trim()}/admin/keys/$id'), headers: {'x-admin-password': tcPwd.text}); _loadKeys(); } catch (_) {}
  }"""
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
cloud = cloud.replace(old_revoke, new_revoke)

# Add WS message handler for keys_synced in initState
old_init = """    _wsService.messages.listen((msg) {
      final type = msg['type'] as String?;
      if (type == 'auth_ok') setState(() { _connected = true; _connStatus = 'connected'; });
      if (type == 'disconnected') setState(() { _connected = false; _connStatus = 'disconnected'; });
    });"""
new_init = """    _wsService.messages.listen((msg) {
      final type = msg['type'] as String?;
      if (type == 'auth_ok') {
        setState(() { _connected = true; _connStatus = 'connected'; });
        // Request key sync on connect
        _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
      }
      if (type == 'keys_synced') {
        final keys = msg['keys'] as List?;
        if (keys != null) setState(() => _apiKeys = keys);
      }
      if (type == 'disconnected') setState(() { _connected = false; _connStatus = 'disconnected'; });
    });"""
cloud = cloud.replace(old_init, new_init)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(cloud)

print("cloud_page.dart patched")
