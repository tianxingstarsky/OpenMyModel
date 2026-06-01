import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:http/http.dart' as http;
import '../services/websocket_service.dart';

/// OutMyModel to Internet - 云端连接 + 测试按钮 + API Key 管理

class CloudPage extends StatefulWidget {
  final String llamaUrl;
  final String modelName;
  final bool serverRunning;
  const CloudPage({super.key, this.llamaUrl = 'http://127.0.0.1:8080', this.modelName = '', this.serverRunning = false});
  @override
  State<CloudPage> createState() => _CloudPageState();
}

class _CloudPageState extends State<CloudPage> {
  final WebSocketService _wsService = WebSocketService();
  final tcUrl = TextEditingController(text: 'aiapi.topofmoon.com:3000');
  final tcPwd = TextEditingController();
  final tcKeyName = TextEditingController();
  final tcKeyLimit = TextEditingController();

  bool _connected = false;
  String _connStatus = '未连接';
  List<dynamic> _apiKeys = [];
  String _testResult = '';
  bool _testing = false;
  String _testApiKey = '';

  @override
  void initState() {
    super.initState();
    _wsService.setLlamaUrl(widget.llamaUrl);
    _wsService.setModelName(widget.modelName);
    _wsService.messages.listen((msg) {
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
    });
  }

  @override
  void didUpdateWidget(CloudPage old) {
    super.didUpdateWidget(old);
    _wsService.setLlamaUrl(widget.llamaUrl);
    _wsService.setModelName(widget.modelName);
    if (_connected) _wsService.sendStatusUpdate(widget.modelName);
  }

  Future _connect() async {
    if (!widget.serverRunning) {
      setState(() => _connStatus = '请先启动 llama-server');
      return;
    }
    setState(() => _connStatus = '连接中...');
    final ok = await _wsService.connect(tcUrl.text.trim(), tcPwd.text, nodeName: 'OutMyModel-本地节点');
    setState(() { _connected = ok; _connStatus = ok ? '已连接' : '连接失败'; });
    if (ok) _loadKeys();
  }

  void _disconnect() { _wsService.disconnect(); setState(() { _connected = false; _connStatus = '已断开'; }); }

  Future _loadKeys() async {
    // Keys managed locally; synced via WebSocket
  }

  String _genKey() {
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
      if (_testApiKey.isEmpty) _testApiKey = newKey['key'] as String;
    });
    tcKeyName.clear(); tcKeyLimit.clear();
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
  }

  Future _revokeKey(String id) async {
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
  }

  // ==================== 测试按钮 (多模态) ====================
  Future _testConnection() async {
    if (!_connected) { setState(() => _testResult = '请先连接云端'); return; }
    if (_testApiKey.isEmpty) { setState(() => _testResult = '请先生成 API Key'); return; }

    setState(() { _testing = true; _testResult = '发送多模态测试...'; });

    try {
      final d = tcUrl.text.trim();
      // OpenAI 标准多模态测试 (文字 + 图片)
      final body = {
        'model': widget.modelName.isNotEmpty ? widget.modelName : 'local-model',
        'messages': [
          {
            'role': 'user',
            'content': [
              {'type': 'text', 'text': '请用一句话描述这张图片'},
              {'type': 'image_url', 'image_url': {'url': 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/dd/Gfp-wisconsin-madison-the-nature-boardwalk.jpg/256px-Gfp-wisconsin-madison-the-nature-boardwalk.jpg'}},
            ],
          },
        ],
        'max_tokens': 200,
        'stream': true,
      };

      final client = http.Client();
      final request = http.Request('POST', Uri.parse('http://$d/v1/chat/completions'));
      request.headers['Content-Type'] = 'application/json';
      request.headers['Authorization'] = 'Bearer ';
      request.body = jsonEncode(body);

      final response = await client.send(request);
      final buffer = StringBuffer();
      final sseBuffer = StringBuffer();
      await for (final bytes in response.stream) {
        sseBuffer.write(utf8.decode(bytes));
        final text = sseBuffer.toString();
        sseBuffer.clear();
        for (final line in text.split('\n')) {
          if (line.startsWith('data: ') && line.trim() != 'data: [DONE]') {
            try {
              final chunk = jsonDecode(line.substring(6).trim());
              final choices = chunk['choices'] as List?;
              if (choices != null && choices.isNotEmpty) {
                final delta = choices[0]['delta'];
                if (delta != null && delta['content'] != null && delta['content'].toString().isNotEmpty) {
                  buffer.write(delta['content']);
                  setState(() => _testResult = buffer.toString());
                }
              }
            } catch (_) {}
          }
        }
      }
      client.close();
      if (buffer.isEmpty) setState(() => _testResult = '(模型思考中，无内容输出)');
    } catch (e) {
      setState(() => _testResult = '测试失败: ');
    }
    setState(() => _testing = false);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(padding: const EdgeInsets.all(24), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('OutMyModel / Internet', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
      Text('本地算力共享到云端', style: TextStyle(fontSize: 13, color: Colors.grey[500])),
      const SizedBox(height: 16),

      // llama-server 状态
      _statusBar(),
      const SizedBox(height: 16),

      // 连接配置
      _sec('服务器地址'),
      ft.TextBox(controller: tcUrl, placeholder: 'aiapi.topofmoon.com:3000'),
      const SizedBox(height: 8),
      _sec('管理员密码'),
      ft.TextBox(controller: tcPwd, placeholder: '密码', obscureText: true),
      const SizedBox(height: 12),
      Row(children: [
        ft.FilledButton(onPressed: _connected ? null : _connect, child: Text(_connected ? '已连接' : '连接')),
        const SizedBox(width: 8),
        ft.Button(onPressed: _connected ? _disconnect : null, child: const Text('断开')),
        const SizedBox(width: 8),
        ft.FilledButton(
          onPressed: (_testing || !_connected) ? null : _testConnection,
          child: Text(_testing ? '测试中...' : '测试连接'),
          style: ft.ButtonStyle(backgroundColor: WidgetStateProperty.all(Colors.blue)),
        ),
        const SizedBox(width: 12),
        Text(_connStatus, style: TextStyle(fontSize: 12, color: _connected ? Colors.green : Colors.grey)),
      ]),
      const SizedBox(height: 16),

      // 测试结果
      if (_testResult.isNotEmpty)
        ft.Card(padding: const EdgeInsets.all(12), margin: const EdgeInsets.only(bottom: 16), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('测试结果', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
          const SizedBox(height: 8),
          Text(_testResult, style: const TextStyle(fontSize: 12)),
        ])),

      // API Key 管理
      _sec('API Key 管理'), const SizedBox(height: 8),
      Row(children: [
        Expanded(child: ft.TextBox(controller: tcKeyName, placeholder: '密钥名称')),
        const SizedBox(width: 8),
        SizedBox(width: 100, child: ft.TextBox(controller: tcKeyLimit, placeholder: 'Token限制')),
        const SizedBox(width: 8),
        ft.FilledButton(onPressed: _createKey, child: const Text('生成')),
      ]),
      const SizedBox(height: 8),
      ft.Button(onPressed: _loadKeys, child: const Text('刷新列表')),
      const SizedBox(height: 12),

      if (_apiKeys.isNotEmpty)
        ...(_apiKeys.map((k) => ft.Card(
          padding: const EdgeInsets.all(10),
          margin: const EdgeInsets.only(bottom: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Text(k['name'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: (k['isActive'] == true ? Colors.green : Colors.red).withAlpha(30),
                  borderRadius: BorderRadius.circular(4)),
                child: Text(k['isActive'] == true ? '有效' : '吊销',
                  style: TextStyle(fontSize: 11, color: k['isActive'] == true ? Colors.green : Colors.red)),
              ),
              const Spacer(),
              ft.HyperlinkButton(
                onPressed: () => _revokeKey(k['id']),
                child: const Text('吊销', style: TextStyle(color: Colors.red))),
            ]),
            Text(k['key'] ?? '', style: TextStyle(fontSize: 10, color: Colors.grey[400], fontFamily: 'monospace')),
            Text('月:  tokens /  累计',
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
        Text(widget.serverRunning ? 'llama-server 运行中' : 'llama-server 未启动',
          style: TextStyle(fontSize: 13, color: widget.serverRunning ? Colors.green : Colors.red)),
        const SizedBox(width: 16),
        if (widget.modelName.isNotEmpty)
          Text('模型: ', style: TextStyle(fontSize: 12, color: Colors.grey[600])),
      ]),
    );
  }

  Widget _sec(String t) => Padding(padding: const EdgeInsets.only(bottom: 4), child: Text(t, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)));

  @override
  void dispose() {
    tcUrl.dispose(); tcPwd.dispose(); tcKeyName.dispose(); tcKeyLimit.dispose();
    _wsService.dispose();
    super.dispose();
  }
}
