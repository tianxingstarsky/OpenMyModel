import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:http/http.dart' as http;
import '../services/websocket_service.dart';

/// OutMyModel to Internet - 云端连接 + 测试按钮

class CloudPage extends StatefulWidget {
  const CloudPage({super.key});
  @override
  State<CloudPage> createState() => _CloudPageState();
}

class _CloudPageState extends State<CloudPage> {
  final WebSocketService _wsService = WebSocketService();
  final tcUrl = TextEditingController(text: "aiapi.topofmoon.com:3000");
  final tcPwd = TextEditingController();
  final tcKeyName = TextEditingController();
  final tcKeyLimit = TextEditingController();

  bool _connected = false;
  String _connStatus = "未连接";
  List<dynamic> _apiKeys = [];
  String _testResult = "";
  bool _testing = false;

  @override
  void initState() {
    super.initState();
    _wsService.messages.listen((msg) {
      if (msg["type"] == "auth_ok") setState(() { _connected = true; _connStatus = "已连接"; });
    });
  }

  Future _connect() async {
    setState(() => _connStatus = "连接中...");
    final ok = await _wsService.connect(tcUrl.text.trim(), tcPwd.text);
    setState(() { _connected = ok; _connStatus = ok ? "已连接" : "连接失败"; });
  }
  void _disconnect() { _wsService.disconnect(); setState(() { _connected = false; _connStatus = "已断开"; }); }

  Future _loadKeys() async {
    final d = tcUrl.text.trim(); final p = tcPwd.text;
    try {
      final r = await http.get(Uri.parse("http://$d/admin/keys"), headers: {"x-admin-password": p});
      if (r.statusCode == 200) setState(() => _apiKeys = jsonDecode(r.body));
    } catch (_) {}
  }

  Future _createKey() async {
    final d = tcUrl.text.trim(); final n = tcKeyName.text.trim(); final l = int.tryParse(tcKeyLimit.text) ?? 0;
    if (n.isEmpty) return;
    try {
      await http.post(Uri.parse("http://$d/admin/keys"), headers: {"Content-Type": "application/json", "x-admin-password": tcPwd.text}, body: jsonEncode({"name": n, "tokenLimit": l}));
      tcKeyName.clear(); tcKeyLimit.clear(); _loadKeys();
    } catch (_) {}
  }

  Future _revokeKey(String id) async {
    try { await http.delete(Uri.parse("http://${tcUrl.text.trim()}/admin/keys/$id"), headers: {"x-admin-password": tcPwd.text}); _loadKeys(); } catch (_) {}
  }

  // ==================== 测试按钮 ====================
  Future _testConnection() async {
    setState(() { _testing = true; _testResult = "发送测试请求..."; });

    try {
      final d = tcUrl.text.trim();
      // 构建多模态测试请求（文字+图片）
      final body = {
        "model": "local-model",
        "messages": [
          {
            "role": "user",
            "content": [
              {"type": "text", "text": "请描述这张图片的内容"},
              {"type": "image_url", "image_url": {"url": "https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/256px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg"}},
            ],
          },
        ],
        "max_tokens": 200,
        "stream": true,
      };

      final client = http.Client();
      final request = http.Request("POST", Uri.parse("http://$d/v1/chat/completions"));
      request.headers["Content-Type"] = "application/json";
      request.headers["Authorization"] = "Bearer test-key";
      request.body = jsonEncode(body);

      final response = await client.send(request);
      final buffer = StringBuffer();
      await for (final chunk in response.stream.transform(utf8.decoder)) {
        for (final line in chunk.split("\n")) {
          if (line.startsWith("data: ") && line != "data: [DONE]") {
            try {
              final data = jsonDecode(line.substring(6));
              final choices = data["choices"] as List?;
              if (choices != null && choices.isNotEmpty) {
                final delta = choices[0]["delta"];
                if (delta != null && delta["content"] != null) {
                  buffer.write(delta["content"]);
                  setState(() => _testResult = buffer.toString());
                }
              }
            } catch (_) {}
          }
        }
      }
      client.close();
      if (buffer.isEmpty) setState(() => _testResult = "(无响应内容，可能是模型思考中)");
    } catch (e) {
      setState(() => _testResult = "测试失败: $e");
    }
    setState(() => _testing = false);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(padding: const EdgeInsets.all(24), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text("OutMyModel / Internet", style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
      Text("本地算力共享到云端", style: TextStyle(fontSize: 13, color: Colors.grey[500])),
      const SizedBox(height: 20),

      // 连接配置
      _sec("服务器地址"), Row(children: [Expanded(child: ft.TextBox(controller: tcUrl, placeholder: "aiapi.topofmoon.com:3000"))]),
      SizedBox(height: 8),
      _sec("管理员密码"), Row(children: [Expanded(child: ft.TextBox(controller: tcPwd, placeholder: "密码", obscureText: true))]),
      SizedBox(height: 12),
      Row(children: [
        ft.FilledButton(onPressed: _connected ? null : _connect, child: Text(_connected ? "已连接" : "连接")),
        SizedBox(width: 8),
        ft.Button(onPressed: _connected ? _disconnect : null, child: Text("断开")),
        SizedBox(width: 8),
        ft.Button(onPressed: _testing ? null : _testConnection, child: Text(_testing ? "测试中..." : "测试连接")),
        SizedBox(width: 12),
        Text(_connStatus, style: TextStyle(fontSize: 12, color: _connected ? Colors.green : Colors.grey)),
      ]),
      SizedBox(height: 16),

      // 测试结果
      if (_testResult.isNotEmpty)
        ft.Card(padding: const EdgeInsets.all(12), margin: const EdgeInsets.only(bottom: 16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text("测试结果", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          SizedBox(height: 8),
          Text(_testResult, style: const TextStyle(fontSize: 12)),
        ])),

      // API Key 管理
      _sec("API Key 管理"), SizedBox(height: 8),
      Row(children: [
        Expanded(child: ft.TextBox(controller: tcKeyName, placeholder: "密钥名称")),
        SizedBox(width: 8),
        SizedBox(width: 100, child: ft.TextBox(controller: tcKeyLimit, placeholder: "Token限制")),
        SizedBox(width: 8),
        ft.FilledButton(onPressed: _createKey, child: Text("生成")),
      ]),
      SizedBox(height: 8),
      ft.Button(onPressed: _loadKeys, child: Text("刷新列表")),
      SizedBox(height: 12),

      if (_apiKeys.isNotEmpty) ..._apiKeys.map((k) => ft.Card(padding: EdgeInsets.all(10), margin: EdgeInsets.only(bottom: 6), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text(k["name"] ?? "", style: TextStyle(fontWeight: FontWeight.w600)),
          SizedBox(width: 8),
          Container(padding: EdgeInsets.symmetric(horizontal: 6, vertical: 2), decoration: BoxDecoration(color: (k["isActive"] == true ? Colors.green : Colors.red).withAlpha(30), borderRadius: BorderRadius.circular(4)), child: Text(k["isActive"] == true ? "有效" : "吊销", style: TextStyle(fontSize: 11, color: k["isActive"] == true ? Colors.green : Colors.red))),
          Spacer(),
          ft.HyperlinkButton(onPressed: () => _revokeKey(k["id"]), child: Text("吊销", style: TextStyle(color: Colors.red))),
        ]),
        Text(k["key"] ?? "", style: TextStyle(fontSize: 10, color: Colors.grey[400], fontFamily: "monospace")),
        Text("月: ${k["monthlyTokens"]} tokens / ${k["totalTokens"]} 累计", style: TextStyle(fontSize: 11, color: Colors.grey[500])),
      ]))),
    ]));
  }

  Widget _sec(String t) => Padding(padding: EdgeInsets.only(bottom: 4), child: Text(t, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)));

  @override
  void dispose() { tcUrl.dispose(); tcPwd.dispose(); tcKeyName.dispose(); tcKeyLimit.dispose(); super.dispose(); }
}