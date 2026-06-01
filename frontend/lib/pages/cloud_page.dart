import 'dart:convert';
import 'dart:math';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../services/websocket_service.dart';

/// OutMyModel to Internet - cloud connection + API Key management

class CloudPage extends StatefulWidget {
  final String llamaUrl;
  final String modelName;
  final bool serverRunning;
  const CloudPage({super.key, this.llamaUrl = "http://127.0.0.1:8080", this.modelName = "", this.serverRunning = false});
  @override
  State<CloudPage> createState() => _CloudPageState();
}

class _CloudPageState extends State<CloudPage> {
  final WebSocketService _wsService = WebSocketService();
  final tcUrl = TextEditingController();
  final tcPwd = TextEditingController();
  final tcKeyName = TextEditingController();
  final tcKeyLimit = TextEditingController();

  final List<String> _visibleKeys = [];
  bool _connected = false;
  String _connStatus = "未连接";
  List<dynamic> _apiKeys = [];
  String _testResult = "";
  bool _testing = false;
  String _testApiKey = "";
  List<dynamic> _backendNodes = [];
  Timer? _nodesPollTimer;
  Timer? _autoConnectTimer;

  @override
  void initState() {
    super.initState();
    _loadPrefs();
    _loadKeysLocal();
    _wsService.setLlamaUrl(widget.llamaUrl);
    _wsService.setModelName(widget.modelName);
    _wsService.messages.listen((msg) {
      final type = msg["type"] as String?;
      if (type == "auth_ok") {
        setState(() { _connected = true; _connStatus = "已连接 - 节点已注册"; });
        _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
        _startNodesPolling();
      }
      if (type == "keys_synced") {
        final keys = msg["keys"] as List?;
        if (keys != null) setState(() => _apiKeys = keys);
      }
      if (type == "disconnected") {
        setState(() { _connected = false; _connStatus = "已断开"; });
        _nodesPollTimer?.cancel();
      }
    });
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final url = prefs.getString("cloud_url");
    final pwd = prefs.getString("cloud_password");
    if (mounted && url != null) {
      tcUrl.text = url;
      if (pwd != null) tcPwd.text = pwd;
      // Auto-connect after a short delay (wait for bridge + server)
      _autoConnectTimer = Timer(const Duration(seconds: 2), () {
        if (widget.serverRunning) _connect();
      });
    }
  }

  Future<void> _savePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString("cloud_url", tcUrl.text.trim());
    await prefs.setString("cloud_password", tcPwd.text);
  }

  /// Poll backend for real node status
  void _startNodesPolling() {
    _nodesPollTimer?.cancel();
    _nodesPollTimer = Timer.periodic(const Duration(seconds: 5), (_) => _fetchNodes());
    _fetchNodes();
  }

  Future<void> _fetchNodes() async {
    try {
      final d = tcUrl.text.trim();
      final resp = await http.get(
        Uri.parse("http://$d/admin/nodes"),
        headers: {"x-admin-password": tcPwd.text},
      ).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) {
        final nodes = jsonDecode(resp.body) as List;
        if (mounted) setState(() => _backendNodes = nodes);
      }
    } catch (_) {}
  }

  @override
  void didUpdateWidget(CloudPage old) {
    super.didUpdateWidget(old);
    _wsService.setLlamaUrl(widget.llamaUrl);
    _wsService.setModelName(widget.modelName);
    if (_connected) _wsService.sendStatusUpdate(widget.modelName);
    // Auto-connect when server comes online
    if (!_connected && widget.serverRunning && !old.serverRunning && tcUrl.text.isNotEmpty) {
      _connect();
    }
  }

  Future _connect() async {
    if (!widget.serverRunning) {
      setState(() => _connStatus = "请先启动 llama-server");
      return;
    }
    if (tcUrl.text.trim().isEmpty || tcPwd.text.isEmpty) {
      setState(() => _connStatus = "请输入服务器地址和密码");
      return;
    }
    setState(() => _connStatus = "连接中...");
    _savePrefs();
    final ok = await _wsService.connect(tcUrl.text.trim(), tcPwd.text, nodeName: "OutMyModel-本地节点");
    setState(() { _connected = ok; _connStatus = ok ? "已连接" : "连接失败"; });
    if (ok) _loadKeys();
  }

  void _disconnect() { _wsService.disconnect(); _nodesPollTimer?.cancel(); setState(() { _connected = false; _connStatus = "已断开"; }); }

  Future _loadKeys() async {}

  String _genKey() {
    final random = Random.secure();
    final chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    final id = List.generate(32, (i) => chars[random.nextInt(chars.length)]).join();
    return "sk-oom-$id";
  }

  Future _createKey() async {
    final n = tcKeyName.text.trim(); final l = int.tryParse(tcKeyLimit.text) ?? 0;
    if (n.isEmpty) return;
    final newKey = {
      "id": DateTime.now().millisecondsSinceEpoch.toRadixString(36),
      "name": n,
      "key": _genKey(),
      "createdAt": DateTime.now().toIso8601String(),
      "isActive": true,
      "totalTokens": 0, "totalRequests": 0,
      "monthlyTokens": 0, "monthlyRequests": 0,
      "tokenLimit": l,
    };
    setState(() {
      _apiKeys = [..._apiKeys, newKey];
      if (_testApiKey.isEmpty) _testApiKey = newKey["key"] as String;
    });
    tcKeyName.clear(); tcKeyLimit.clear();
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
    _saveKeysLocal();
    if (mounted) ft.displayInfoBar(context, builder: (c, cl) => ft.InfoBar(title: Text("Key generated: $n"), severity: ft.InfoBarSeverity.success));
  }

  Future _revokeKey(String id) async {
    setState(() {
      _apiKeys = _apiKeys.map((k) {
        if (k["id"] == id) {
          final updated = Map<String, dynamic>.from(k);
          updated["isActive"] = false;
          return updated;
        }
        return k;
      }).toList();
    });
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
    _saveKeysLocal();
  }

  Future _testConnection() async {
    if (!_connected) { setState(() => _testResult = "请先连接云端"); return; }
    if (_testApiKey.isEmpty) { setState(() => _testResult = "请先生成 API Key"); return; }
    setState(() { _testing = true; _testResult = "发送多模态测试..."; });
    try {
      final d = tcUrl.text.trim();
      final body = {
        "model": widget.modelName.isNotEmpty ? widget.modelName : "local-model",
        "messages": [
          {
            "role": "user",
            "content": [
              {"type": "text", "text": "请用一句话描述这张图片"},
              {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison.jpg/640px-Gfp-wisconsin-madison.jpg"}},
            ],
          },
        ],
        "stream": true,
      };
      final resp = await http.post(
        Uri.parse("http://$d/v1/chat/completions"),
        headers: {"Content-Type": "application/json", "Authorization": "Bearer $_testApiKey"},
        body: jsonEncode(body),
      ).timeout(const Duration(seconds: 30));
      if (resp.statusCode == 200 && resp.headers["content-type"]?.contains("text/event-stream") == true) {
        final buf = await resp.bodyBytes;
        final text = utf8.decode(buf);
        final lines = text.split("\n");
        var content = "";
        for (final line in lines) {
          if (line.startsWith("data:") && !line.contains("[DONE]")) {
            try {
              final c = jsonDecode(line.substring(5).trim());
              final d = c["choices"]?[0]?["delta"]?["content"];
              if (d != null) content += d;
            } catch (_) {}
          }
        }
        setState(() => _testResult = content.isNotEmpty ? "success: $content" : "success: (流式响应已接收)");
      } else {
        setState(() => _testResult = "HTTP ${resp.statusCode}: ${utf8.decode(resp.bodyBytes).substring(0, 200)}");
      }
    } catch (e) {
      setState(() => _testResult = "error: $e");
    }
    setState(() => _testing = false);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(padding: const EdgeInsets.all(24), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text("OutMyModel / Internet", style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
      Text("本地算力共享到云端", style: TextStyle(fontSize: 13, color: Colors.grey[500])),
      const SizedBox(height: 16),

      // llama-server status
      _statusBar(),
      const SizedBox(height: 16),

      // Backend node status
      _backendStatusBar(),
      const SizedBox(height: 16),

      // Connection
      _sec("服务器地址"),
      ft.TextBox(controller: tcUrl, placeholder: "your-server.com:3000"),
      const SizedBox(height: 8),
      _sec("管理员密码"),
      ft.TextBox(controller: tcPwd, placeholder: "密码", obscureText: true),
      const SizedBox(height: 12),
      Row(children: [
        ft.FilledButton(onPressed: _connected ? null : _connect, child: Text(_connected ? "已连接" : "连接")),
        const SizedBox(width: 8),
        ft.Button(onPressed: _connected ? _disconnect : null, child: const Text("断开")),
        const SizedBox(width: 8),
        ft.FilledButton(
          onPressed: (_testing || !_connected) ? null : _testConnection,
          child: Text(_testing ? "测试中..." : "测试连接"),
          style: ft.ButtonStyle(backgroundColor: WidgetStateProperty.all(Colors.blue)),
        ),
        const SizedBox(width: 12),
        Text(_connStatus, style: TextStyle(fontSize: 12, color: _connected ? Colors.green : Colors.grey)),
      ]),
      const SizedBox(height: 16),

      // Test result
      if (_testResult.isNotEmpty)
        ft.Card(padding: const EdgeInsets.all(12), margin: const EdgeInsets.only(bottom: 16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text("测试结果", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 8),
          Text(_testResult, style: const TextStyle(fontSize: 12)),
        ])),

      // API Key management
      _sec("API Key 管理"), const SizedBox(height: 8),
      Row(children: [
        Expanded(child: ft.TextBox(controller: tcKeyName, placeholder: "密钥名称")),
        const SizedBox(width: 8),
        SizedBox(width: 100, child: ft.TextBox(controller: tcKeyLimit, placeholder: "Token限制")),
        const SizedBox(width: 8),
        ft.FilledButton(onPressed: _createKey, child: const Text("生成")),
      ]),
      const SizedBox(height: 8),
      ft.Button(onPressed: _loadKeys, child: const Text("刷新列表")),
      const SizedBox(height: 12),

      if (_apiKeys.isNotEmpty)
        ...(_apiKeys.map((k) => ft.Card(
          padding: const EdgeInsets.all(10),
          margin: const EdgeInsets.only(bottom: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text(k["name"] ?? "", style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: (k["isActive"] == true ? Colors.green : Colors.red).withAlpha(30),
                  borderRadius: BorderRadius.circular(4)),
                child: Text(k["isActive"] == true ? "有效" : "吊销",
                  style: TextStyle(fontSize: 11, color: k["isActive"] == true ? Colors.green : Colors.red)),
              ),
              const Spacer(),
              ft.HyperlinkButton(
                onPressed: () => _revokeKey(k["id"]),
                child: const Text("吊销", style: TextStyle(color: Colors.red))),
            ]),
            Row(children: [
              Expanded(child: Text(
                _visibleKeys.contains(k["id"]) ? (k["key"] ?? "") : "sk-oom-" + "•" * 18,
                style: TextStyle(fontSize: 10, color: Colors.grey[400], fontFamily: "monospace"),
              )),
              GestureDetector(
                onTap: () {
                  setState(() {
                    if (_visibleKeys.contains(k["id"])) {
                      _visibleKeys.remove(k["id"]);
                    } else {
                      _visibleKeys.add(k["id"] as String);
                    }
                  });
                },
                child: Icon(
                  _visibleKeys.contains(k["id"]) ? Icons.visibility_off : Icons.visibility,
                  size: 14, color: Colors.grey,
                ),
              ),
              const SizedBox(width: 6),
              GestureDetector(
                onTap: () {
                  Clipboard.setData(ClipboardData(text: k["key"] ?? ""));
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text("API Key copied"), duration: const Duration(seconds: 1)),
                  );
                },
                child: const Icon(Icons.copy, size: 14, color: Colors.grey),
              ),
            ]),
            Text("月: ${k["monthlyTokens"]} tokens / ${k["totalTokens"]} 累计",
              style: TextStyle(fontSize: 11, color: Colors.grey[500])),
          ]))).toList()),
    ]));
  }

  Widget _statusBar() {
    return ft.Card(
      padding: const EdgeInsets.all(12),
      child: Row(children: [
        Container(width: 8, height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: widget.serverRunning ? Colors.green : Colors.red)),
        const SizedBox(width: 8),
        Text(widget.serverRunning ? "llama-server 运行中" : "llama-server 未启动",
          style: TextStyle(fontSize: 13, color: widget.serverRunning ? Colors.green : Colors.red)),
        const SizedBox(width: 16),
        if (widget.modelName.isNotEmpty)
          Text("模型: ${widget.modelName}", style: TextStyle(fontSize: 12, color: Colors.grey[600])),
      ]),
    );
  }

  Widget _backendStatusBar() {
    return ft.Card(
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(width: 8, height: 8,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: _connected ? Colors.green : Colors.orange)),
          const SizedBox(width: 8),
          Text(_connected ? "云端后端已连接" : "云端后端未连接",
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _connected ? Colors.green : Colors.orange)),
          const Spacer(),
          if (_connected)
            GestureDetector(
              onTap: _fetchNodes,
              child: const Icon(Icons.refresh, size: 16, color: Colors.grey),
            ),
        ]),
        if (_backendNodes.isNotEmpty) ...[
          const SizedBox(height: 8),
          const Divider(),
          const SizedBox(height: 4),
          Text("后端节点: ${_backendNodes.length} 个在线", style: TextStyle(fontSize: 12, color: Colors.grey[600])),
          ...(_backendNodes.map((n) => Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Row(children: [
              Container(width: 6, height: 6,
                decoration: BoxDecoration(shape: BoxShape.circle, color: (n["isOnline"] == true) ? Colors.green : Colors.grey)),
              const SizedBox(width: 6),
              Text(n["name"] ?? "??", style: const TextStyle(fontSize: 12)),
              const SizedBox(width: 8),
              Text(n["modelName"] ?? "", style: TextStyle(fontSize: 11, color: Colors.grey[500])),
            ]),
          ))),
        ],
      ]),
    );
  }

  Widget _sec(String t) => Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(t, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)));

  Future<void> _saveKeysLocal() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString("api_keys", jsonEncode(_apiKeys));
  }

  Future<void> _loadKeysLocal() async {
    final prefs = await SharedPreferences.getInstance();
    final keysStr = prefs.getString("api_keys");
    if (keysStr != null && keysStr.isNotEmpty) {
      try {
        final keys = jsonDecode(keysStr) as List;
        if (mounted) setState(() => _apiKeys = keys);
      } catch (_) {}
    }
    if (_apiKeys.isNotEmpty && _testApiKey.isEmpty) {
      _testApiKey = (_apiKeys.first as Map)["key"] ?? "";
    }
  }

  @override
  void dispose() {
    tcUrl.dispose(); tcPwd.dispose(); tcKeyName.dispose(); tcKeyLimit.dispose();
    _wsService.dispose();
    _nodesPollTimer?.cancel();
    _autoConnectTimer?.cancel();
    super.dispose();
  }
}
