import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../services/cloud_url.dart';
import '../services/python_bridge.dart';
import '../services/websocket_service.dart';

class CloudPage extends StatefulWidget {
  final String llamaUrl;
  final String llamaApiKey;
  final String modelName;
  final bool serverRunning;
  final bool serverReady;
  const CloudPage({
    super.key,
    this.llamaUrl = 'http://127.0.0.1:8080',
    this.llamaApiKey = '',
    this.modelName = '',
    this.serverRunning = false,
    this.serverReady = false,
  });
  @override
  State<CloudPage> createState() => CloudPageState();
}

class CloudPageState extends State<CloudPage> {
  final WebSocketService _service = WebSocketService();
  final _url = TextEditingController();
  final _password = TextEditingController();
  final _keyName = TextEditingController();
  final _visibleKeys = <String>{};
  final _clients = <http.Client>{};
  List<Map<String, dynamic>> _keys = [];
  List<Map<String, dynamic>> _nodes = [];
  StreamSubscription<Map<String, dynamic>>? _subscription;
  Timer? _poll;
  bool _connected = false,
      _connecting = false,
      _loaded = false,
      _testing = false,
      _polling = false,
      _closing = false;
  bool _autoConnect = false;
  String _status = '未连接';
  String _testResult = '';
  String? _connectedUrl, _connectedPassword;

  @override
  void initState() {
    super.initState();
    _subscription = _service.messages.listen((message) {
      if (!mounted || _closing) return;
      if (message['type'] == 'connected') {
        setState(() {
          _connected = true;
          _status = '已连接，节点在线';
        });
      } else if (message['type'] == 'disconnected' ||
          message['type'] == 'error') {
        setState(() {
          _connected = false;
          _status = message['message']?.toString() ?? '已断开';
          _nodes = [];
        });
        _poll?.cancel();
      }
    });
    unawaited(_load());
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted || _closing) return;
    _url.text = prefs.getString('cloud_url') ?? '';
    _password.text = prefs.getString('cloud_password') ?? '';
    _autoConnect = prefs.getBool('cloud_auto_connect') ?? false;
    final raw = prefs.getString('api_keys');
    var corrupt = false;
    if (raw != null && raw.isNotEmpty) {
      try {
        final data = jsonDecode(raw);
        if (data is! List) throw const FormatException('密钥列表格式错误');
        _keys = data
            .whereType<Map>()
            .where(
              (key) =>
                  key['id'] is String &&
                  key['key'] is String &&
                  (key['key'] as String).isNotEmpty,
            )
            .map((key) => Map<String, dynamic>.from(key))
            .toList();
        corrupt = _keys.length != data.length;
      } catch (_) {
        corrupt = true;
      }
    }
    _service.setLocalKeys(_keys);
    setState(() {
      _loaded = true;
      if (corrupt) _status = '部分本地密钥数据无法读取，原始数据尚未覆盖';
    });
    if (_autoConnect &&
        widget.serverReady &&
        _url.text.isNotEmpty &&
        _password.text.isNotEmpty)
      unawaited(_connect());
  }

  @override
  void didUpdateWidget(covariant CloudPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.llamaUrl != oldWidget.llamaUrl ||
        widget.llamaApiKey != oldWidget.llamaApiKey)
      _service.setLlamaUrl(widget.llamaUrl, apiKey: widget.llamaApiKey);
    if (widget.modelName != oldWidget.modelName ||
        widget.serverReady != oldWidget.serverReady) {
      _service.setModelName(widget.modelName);
      _service.sendStatusUpdate(
        widget.modelName,
        serverRunning: widget.serverReady,
      );
    }
    if (_loaded &&
        _autoConnect &&
        widget.serverReady &&
        !oldWidget.serverReady &&
        !_connected &&
        !_connecting)
      unawaited(_connect());
  }

  Future<void> _connect() async {
    if (_closing || !_loaded || _connecting || _connected) return;
    if (!widget.serverReady) {
      _message('请先在首页启动模型并等待加载完成');
      return;
    }
    try {
      final url = normalizeCloudUri(_url.text).toString();
      if (_password.text.isEmpty) throw const FormatException('请输入管理员密码');
      final password = _password.text;
      setState(() {
        _connecting = true;
        _status = '正在连接…';
      });
      _service.setLlamaUrl(widget.llamaUrl, apiKey: widget.llamaApiKey);
      _service.setModelName(widget.modelName);
      _service.setLocalKeys(_keys);
      final connected = await _service.connect(
        url,
        password,
        nodeName: 'OpenMyModel-本地节点',
        serverRunning: widget.serverReady,
      );
      if (!mounted || _closing) return;
      setState(() {
        _connected = connected;
        _status = connected ? '已连接，节点在线' : (_service.lastError ?? '连接失败');
      });
      if (connected) {
        _connectedUrl = url;
        _connectedPassword = password;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('cloud_url', url);
        await prefs.setString('cloud_password', password);
        if (!mounted || _closing) return;
        _poll?.cancel();
        _poll = Timer.periodic(
          const Duration(seconds: 5),
          (_) => _fetchNodes(),
        );
        unawaited(_fetchNodes());
      }
    } catch (error) {
      if (mounted && !_closing) setState(() => _status = error.toString());
    } finally {
      if (mounted && !_closing) setState(() => _connecting = false);
    }
  }

  void disconnectForShutdown() {
    _closing = true;
    _poll?.cancel();
    _service.disconnect();
    for (final client in _clients) {
      client.close();
    }
    _clients.clear();
  }

  void resumeAfterCancelledShutdown() {
    if (!mounted) return;
    setState(() {
      _closing = false;
      _connected = false;
      _connecting = false;
      _testing = false;
      _status = '关闭未完成，云端已安全断开';
      _nodes = [];
    });
  }

  void _disconnect() {
    _autoConnect = false;
    _poll?.cancel();
    _service.disconnect();
    for (final client in _clients) {
      client.close();
    }
    if (mounted)
      setState(() {
        _connected = false;
        _connecting = false;
        _status = '已断开';
        _nodes = [];
      });
    unawaited(
      SharedPreferences.getInstance().then(
        (prefs) => prefs.setBool('cloud_auto_connect', false),
      ),
    );
  }

  Future<void> _fetchNodes() async {
    if (!_connected || _polling || _connectedUrl == null || _closing) return;
    _polling = true;
    final client = http.Client();
    _clients.add(client);
    try {
      final response = await client
          .get(
            cloudEndpoint(_connectedUrl!, '/admin/nodes'),
            headers: {'x-admin-password': _connectedPassword!},
          )
          .timeout(const Duration(seconds: 5));
      if (response.statusCode != 200)
        throw StateError('节点状态 HTTP ${response.statusCode}');
      final data = jsonDecode(utf8.decode(response.bodyBytes));
      if (data is! List) throw const FormatException('节点列表格式错误');
      if (mounted && !_closing && _connected)
        setState(
          () => _nodes = data
              .whereType<Map>()
              .map((node) => Map<String, dynamic>.from(node))
              .toList(),
        );
    } catch (error) {
      if (mounted && !_closing && _connected)
        setState(() => _status = '隧道已连接，节点状态获取失败: $error');
    } finally {
      client.close();
      _clients.remove(client);
      _polling = false;
    }
  }

  Future<void> _saveKeys() async {
    _service.setLocalKeys(_keys);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('api_keys', jsonEncode(_keys));
  }

  Future<void> _createKey() async {
    final name = _keyName.text.trim();
    if (!_loaded || name.isEmpty) {
      _message('请输入密钥名称');
      return;
    }
    final random = Random.secure();
    final value = List.generate(
      32,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    setState(() {
      _keys.add({
        'id': value.substring(0, 16),
        'name': name,
        'key': 'sk-oom-$value',
        'createdAt': DateTime.now().toIso8601String(),
        'isActive': true,
      });
      _keyName.clear();
    });
    try {
      await _saveKeys();
      _message('密钥已生成并同步到本地桥接', success: true);
    } catch (error) {
      _message('保存失败: $error');
    }
  }

  Future<void> _deleteKey(Map<String, dynamic> key) async {
    final confirmed = await ft.showDialog<bool>(
      context: context,
      builder: (context) => ft.ContentDialog(
        title: const Text('删除 API Key'),
        content: Text('删除“${key['name']}”后不能恢复。已开始的请求不会被追溯取消。'),
        actions: [
          ft.Button(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          ft.FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    setState(() {
      _keys.remove(key);
      _visibleKeys.remove(key['id']);
    });
    try {
      await _saveKeys();
    } catch (error) {
      _message('保存失败: $error');
    }
  }

  Future<void> _toggleKey(Map<String, dynamic> key, bool active) async {
    setState(() => key['isActive'] = active);
    try {
      await _saveKeys();
    } catch (error) {
      _message('保存失败: $error');
    }
  }

  Future<void> _test() async {
    if (_testing || !_connected || _connectedUrl == null) return;
    final keys = _keys.where((key) => key['isActive'] == true).toList();
    if (keys.isEmpty) {
      _message('请先生成并启用一个 API Key');
      return;
    }
    setState(() {
      _testing = true;
      _testResult = '正在发送短文本测试…';
    });
    final client = http.Client();
    _clients.add(client);
    final deadline = Timer(const Duration(seconds: 30), client.close);
    try {
      final request =
          http.Request(
              'POST',
              cloudEndpoint(_connectedUrl!, '/v1/chat/completions'),
            )
            ..headers.addAll({
              'Content-Type': 'application/json',
              'Authorization': "Bearer ${keys.first['key']}",
            })
            ..body = jsonEncode({
              'model': widget.modelName.isEmpty
                  ? 'local-model'
                  : widget.modelName,
              'messages': [
                {'role': 'user', 'content': '请只回复：连接成功'},
              ],
              'max_tokens': 32,
              'stream': true,
            });
      final response = await client
          .send(request)
          .timeout(const Duration(seconds: 30));
      if (response.statusCode != 200) {
        final text = await response.stream.bytesToString();
        throw BridgeException(
          text.length > 300 ? text.substring(0, 300) : text,
          response.statusCode,
        );
      }
      var output = '';
      await for (final event in decodeSse(response.stream)) {
        final data = jsonDecode(event);
        if (data['error'] != null)
          throw BridgeException(data['error'].toString());
        final choices = data['choices'];
        if (choices is List && choices.isNotEmpty) {
          final delta = choices.first['delta'];
          if (delta is Map)
            output += (delta['content'] ?? delta['reasoning_content'] ?? '')
                .toString();
        }
      }
      if (mounted && !_closing)
        setState(
          () => _testResult = output.isEmpty ? '连接成功，已收到完整响应' : '连接成功：$output',
        );
    } catch (error) {
      if (mounted && !_closing) setState(() => _testResult = '测试失败或超时：$error');
    } finally {
      deadline.cancel();
      client.close();
      _clients.remove(client);
      if (mounted && !_closing) setState(() => _testing = false);
    }
  }

  void _message(String text, {bool success = false}) {
    if (!mounted || _closing) return;
    ft.displayInfoBar(
      context,
      builder: (_, close) => ft.InfoBar(
        title: Text(text),
        onClose: close,
        severity: success
            ? ft.InfoBarSeverity.success
            : ft.InfoBarSeverity.warning,
      ),
    );
  }

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
    padding: const EdgeInsets.all(24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          '云端连接',
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        const Text(
          '通过你自己的云服务器共享本地模型。公网地址请使用 HTTPS。',
          style: TextStyle(color: Colors.grey),
        ),
        const SizedBox(height: 16),
        ft.InfoBar(
          title: Text(
            widget.serverReady
                ? '本地模型已就绪'
                : widget.serverRunning
                ? '本地模型加载中'
                : '本地模型未启动',
          ),
          content: Text(
            widget.modelName.isEmpty ? '在首页选择模型并启动' : widget.modelName,
          ),
          severity: widget.serverReady
              ? ft.InfoBarSeverity.success
              : ft.InfoBarSeverity.info,
        ),
        const SizedBox(height: 16),
        const Text('服务器地址'),
        const SizedBox(height: 6),
        ft.TextBox(
          controller: _url,
          enabled: !_connected && !_connecting,
          placeholder: 'https://api.example.com 或 127.0.0.1:3000',
        ),
        const SizedBox(height: 12),
        const Text('管理员密码'),
        const SizedBox(height: 6),
        ft.TextBox(
          controller: _password,
          obscureText: true,
          enabled: !_connected && !_connecting,
        ),
        const SizedBox(height: 8),
        ft.Checkbox(
          checked: _autoConnect,
          content: const Text('模型就绪后自动连接（默认关闭）'),
          onChanged: (value) async {
            setState(() => _autoConnect = value ?? false);
            final prefs = await SharedPreferences.getInstance();
            await prefs.setBool('cloud_auto_connect', _autoConnect);
          },
        ),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            ft.FilledButton(
              onPressed: _connected || _connecting || !_loaded
                  ? null
                  : _connect,
              child: Text(
                _connecting
                    ? '连接中…'
                    : _connected
                    ? '已连接'
                    : '连接',
              ),
            ),
            ft.Button(
              onPressed: _connected || _connecting ? _disconnect : null,
              child: const Text('断开'),
            ),
            ft.Button(
              onPressed: _connected && !_testing ? _test : null,
              child: Text(_testing ? '测试中…' : '测试连接'),
            ),
            Text(
              _status,
              style: TextStyle(color: _connected ? Colors.green : Colors.grey),
            ),
          ],
        ),
        if (_connectedUrl != null && _connected)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Row(
              children: [
                Expanded(
                  child: SelectableText(
                    'API 地址：${cloudEndpoint(_connectedUrl!, '/v1')}',
                  ),
                ),
                ft.Button(
                  onPressed: () async {
                    await Clipboard.setData(
                      ClipboardData(
                        text: cloudEndpoint(_connectedUrl!, '/v1').toString(),
                      ),
                    );
                    _message('API 地址已复制', success: true);
                  },
                  child: const Text('复制地址'),
                ),
              ],
            ),
          ),
        if (_testResult.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: SelectableText(_testResult),
          ),
        if (_nodes.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: ft.Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('在线节点 ${_nodes.length}'),
                  for (final node in _nodes)
                    Text(
                      '${node['name']} · ${node['modelName']} · ${node['serverRunning'] == false ? '未就绪' : '可用'}',
                    ),
                ],
              ),
            ),
          ),
        const SizedBox(height: 24),
        const Text(
          'API Key 管理',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        const Text(
          '密钥仅在本机持久化。当前不提供 Token 配额、计费或用量统计。',
          style: TextStyle(color: Colors.grey),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: ft.TextBox(controller: _keyName, placeholder: '密钥名称'),
            ),
            const SizedBox(width: 8),
            ft.FilledButton(
              onPressed: _loaded ? _createKey : null,
              child: const Text('生成密钥'),
            ),
          ],
        ),
        const SizedBox(height: 12),
        if (_keys.isEmpty) const Text('暂无密钥。创建后可复制到 OpenAI 兼容客户端。'),
        for (final key in _keys)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: ft.Card(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          key['name']?.toString() ?? '未命名密钥',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ),
                      ft.ToggleSwitch(
                        checked: key['isActive'] == true,
                        content: Text(key['isActive'] == true ? '启用' : '停用'),
                        onChanged: (active) => _toggleKey(key, active),
                      ),
                      ft.HyperlinkButton(
                        onPressed: () => _deleteKey(key),
                        child: const Text('删除'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: SelectableText(
                          _visibleKeys.contains(key['id'])
                              ? key['key'].toString()
                              : 'sk-oom-••••••••••••••••••••',
                          style: const TextStyle(
                            fontFamily: 'Consolas',
                            fontSize: 12,
                          ),
                        ),
                      ),
                      ft.IconButton(
                        icon: Icon(
                          _visibleKeys.contains(key['id'])
                              ? Icons.visibility_off
                              : Icons.visibility,
                        ),
                        onPressed: () => setState(() {
                          if (!_visibleKeys.add(key['id']))
                            _visibleKeys.remove(key['id']);
                        }),
                      ),
                      ft.IconButton(
                        icon: const Icon(Icons.copy),
                        onPressed: () async {
                          await Clipboard.setData(
                            ClipboardData(text: key['key'].toString()),
                          );
                          _message('密钥已复制', success: true);
                        },
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
      ],
    ),
  );

  @override
  void dispose() {
    disconnectForShutdown();
    unawaited(_subscription?.cancel());
    _service.dispose();
    _url.dispose();
    _password.dispose();
    _keyName.dispose();
    super.dispose();
  }
}
