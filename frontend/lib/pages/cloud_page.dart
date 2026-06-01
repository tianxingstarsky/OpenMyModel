import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:http/http.dart' as http;
import 'dart:convert';
import '../services/websocket_service.dart';

/// OutMyModel to Internet - 云端连接管理页

class CloudPage extends StatefulWidget {
  const CloudPage({super.key});

  @override
  State<CloudPage> createState() => _CloudPageState();
}

class _CloudPageState extends State<CloudPage> {
  final WebSocketService _wsService = WebSocketService();
  final TextEditingController _urlCtrl = TextEditingController(text: "aiapi.topofmoon.com:3000");
  final TextEditingController _passwordCtrl = TextEditingController();
  final TextEditingController _keyNameCtrl = TextEditingController();
  final TextEditingController _keyLimitCtrl = TextEditingController();

  bool _connected = false;
  String _connectionStatus = "未连接";
  List<dynamic> _apiKeys = [];
  bool _loadingKeys = false;

  @override
  void initState() {
    super.initState();
    _wsService.messages.listen((msg) {
      if (msg["type"] == "auth_ok") {
        setState(() {
          _connected = true;
          _connectionStatus = "已连接 - ${msg["message"]}";
        });
      }
    });
  }

  Future<void> _connect() async {
    setState(() => _connectionStatus = "正在连接...");
    final ok = await _wsService.connect(_urlCtrl.text.trim(), _passwordCtrl.text);
    setState(() {
      _connected = ok;
      _connectionStatus = ok ? "已连接" : "连接失败，请检查地址和密码";
    });
  }

  void _disconnect() {
    _wsService.disconnect();
    setState(() {
      _connected = false;
      _connectionStatus = "已断开";
    });
  }

  Future<void> _loadKeys() async {
    setState(() => _loadingKeys = true);
    try {
      final domain = _urlCtrl.text.trim();
      final password = _passwordCtrl.text;
      final resp = await http.get(
        Uri.parse("http://$domain/admin/keys"),
        headers: {"x-admin-password": password},
      );
      if (resp.statusCode == 200) {
        setState(() => _apiKeys = jsonDecode(resp.body));
      }
    } catch (_) {}
    setState(() => _loadingKeys = false);
  }

  Future<void> _createKey() async {
    final domain = _urlCtrl.text.trim();
    final name = _keyNameCtrl.text.trim();
    final limit = int.tryParse(_keyLimitCtrl.text) ?? 0;
    if (name.isEmpty) return;

    try {
      final resp = await http.post(
        Uri.parse("http://$domain/admin/keys"),
        headers: {
          "Content-Type": "application/json",
          "x-admin-password": _passwordCtrl.text,
        },
        body: jsonEncode({"name": name, "tokenLimit": limit}),
      );
      if (resp.statusCode == 200) {
        _keyNameCtrl.clear();
        _keyLimitCtrl.clear();
        _loadKeys();
      }
    } catch (_) {}
  }

  Future<void> _revokeKey(String id) async {
    final domain = _urlCtrl.text.trim();
    try {
      await http.delete(
        Uri.parse("http://$domain/admin/keys/$id"),
        headers: {"x-admin-password": _passwordCtrl.text},
      );
      _loadKeys();
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text("OutMyModel → Internet", style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        Text("将本地算力共享到云服务器", style: TextStyle(fontSize: 13, color: Colors.grey[500])),
        const SizedBox(height: 24),

        // 连接配置
        _buildSection("云端服务器配置"),
        Row(children: [
          Expanded(child: ft.TextBox(controller: _urlCtrl, placeholder: "aiapi.topofmoon.com:3000", prefix: const Text("地址:"))),
        ]),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: ft.TextBox(controller: _passwordCtrl, placeholder: "管理员密码", prefix: const Text("密码:"), obscureText: true)),
        ]),
        const SizedBox(height: 12),
        Row(children: [
          ft.FilledButton(
            onPressed: _connected ? null : _connect,
            child: Text(_connected ? "已连接" : "🔗 连接云端"),
          ),
          const SizedBox(width: 8),
          ft.Button(
            onPressed: _connected ? _disconnect : null,
            child: const Text("断开"),
          ),
          const SizedBox(width: 16),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: _connected ? Colors.green.withAlpha(30) : Colors.grey.withAlpha(30),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(_connectionStatus, style: TextStyle(fontSize: 12, color: _connected ? Colors.green : Colors.grey)),
          ),
        ]),
        const SizedBox(height: 32),

        // API Key 管理
        _buildSection("API Key 管理"),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: ft.TextBox(controller: _keyNameCtrl, placeholder: "密钥名称")),
          const SizedBox(width: 8),
          SizedBox(width: 120, child: ft.TextBox(controller: _keyLimitCtrl, placeholder: "Token 限制")),
          const SizedBox(width: 8),
          ft.FilledButton(onPressed: _createKey, child: const Text("生成 Key")),
        ]),
        const SizedBox(height: 8),
        ft.Button(onPressed: _loadKeys, child: Text(_loadingKeys ? "加载中..." : "刷新密钥列表")),
        const SizedBox(height: 12),

        if (_apiKeys.isNotEmpty)
          ...(_apiKeys.map((k) => ft.Card(
            padding: const EdgeInsets.all(12),
            margin: const EdgeInsets.only(bottom: 8),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text(k["name"] ?? "", style: const TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(width: 8),
                Container(padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(color: (k["isActive"] == true ? Colors.green : Colors.red).withAlpha(30), borderRadius: BorderRadius.circular(4)),
                  child: Text(k["isActive"] == true ? "有效" : "已吊销", style: TextStyle(fontSize: 11, color: k["isActive"] == true ? Colors.green : Colors.red))),
                const Spacer(),
                ft.HyperlinkButton(onPressed: () => _revokeKey(k["id"]), child: const Text("吊销", style: TextStyle(color: Colors.red))),
              ]),
              const SizedBox(height: 4),
              Text(k["key"] ?? "", style: TextStyle(fontSize: 11, color: Colors.grey[400], fontFamily: "monospace")),
              const SizedBox(height: 4),
              Text("月用量: ${k["monthlyTokens"]} tokens / ${k["monthlyRequests"]} 次  |  累计: ${k["totalTokens"]} tokens",
                style: TextStyle(fontSize: 11, color: Colors.grey[500])),
            ]),
          ))),
      ]),
    );
  }

  Widget _buildSection(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: const Color(0xFF00B7C3))),
    );
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    _passwordCtrl.dispose();
    _keyNameCtrl.dispose();
    _keyLimitCtrl.dispose();
    super.dispose();
  }
}