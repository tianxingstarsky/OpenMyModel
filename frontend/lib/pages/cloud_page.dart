import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import '../services/cloud_url.dart';
import '../services/inference_service.dart';
import '../services/sse.dart';
import '../services/websocket_service.dart';

class CloudPage extends StatefulWidget {
  final String llamaUrl;
  final String llamaApiKey;
  final String modelName;
  final bool serverRunning;
  final bool serverReady;

  /// 运行中引擎的并发槽位（-np）；null = 未运行/未上报。
  final int? slots;
  const CloudPage({
    super.key,
    this.llamaUrl = 'http://127.0.0.1:8080',
    this.llamaApiKey = '',
    this.modelName = '',
    this.serverRunning = false,
    this.serverReady = false,
    this.slots,
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
  Timer? _reconnectTimer;
  Timer? _serverConfigTimer;
  int _reconnectAttempts = 0;
  bool _expectingDisconnect = false;
  bool _userDisconnected = false;
  bool _connected = false,
      _connecting = false,
      _loaded = false,
      _testing = false,
      _polling = false,
      _closing = false;
  bool _autoConnect = false;
  String _serverMode = '';
  String _serverConfigError = '';
  String _status = '未连接';
  String _testResult = '';
  String? _connectedUrl, _connectedPassword;

  static const _maxReconnectAttempts = 5;

  @override
  void initState() {
    super.initState();
    _url.addListener(_queueServerConfigRefresh);
    _subscription = _service.messages.listen((message) {
      if (!mounted || _closing) return;
      if (message['type'] == 'connected') {
        _reconnectTimer?.cancel();
        _reconnectAttempts = 0;
        _expectingDisconnect = false;
        setState(() {
          _connected = true;
          _status = _serverMode == 'relay' ? '已连接到你的代转发节点' : '已连接，节点在线';
        });
      } else if (message['type'] == 'disconnected' ||
          message['type'] == 'error') {
        final wasConnected = _connected;
        _poll?.cancel();
        setState(() {
          _connected = false;
          _nodes = [];
          if (message['type'] == 'error') {
            _status = message['message']?.toString() ?? '连接出错';
          } else if (_status.startsWith('连接中断')) {
            // 保持退避提示，避免被空消息覆盖。
          }
        });
        if (message['type'] == 'disconnected' &&
            wasConnected &&
            !_expectingDisconnect &&
            !_userDisconnected) {
          _scheduleReconnect();
        }
      }
    });
    unawaited(_load());
  }

  /// 有界指数退避：2s、4s、8s、16s、32s；用户主动断开后不再自动重连。
  void _scheduleReconnect() {
    if (_closing || _userDisconnected || _connecting || _connected) return;
    if (_reconnectAttempts >= _maxReconnectAttempts) {
      setState(() {
        _status = '自动重连 $_maxReconnectAttempts 次失败，请检查网络后手动重连';
      });
      return;
    }
    final delay = Duration(seconds: 2 << _reconnectAttempts);
    _reconnectAttempts++;
    setState(() {
      _status =
          '连接中断，${delay.inSeconds} 秒后自动重连（第 $_reconnectAttempts/$_maxReconnectAttempts 次）';
    });
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      if (!_closing && !_userDisconnected && !_connected) {
        unawaited(_connect());
      }
    });
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted || _closing) return;
    _url.text = prefs.getString('cloud_url') ?? '';
    _autoConnect = prefs.getBool('cloud_auto_connect') ?? false;
    await _refreshServerConfig(_url.text, useStoredCredential: true);
    if (_serverMode == 'relay' || _serverMode == 'provider') {
      _password.text = prefs.getString('cloud_relay_node_token') ?? '';
    } else {
      _password.text = prefs.getString('cloud_password') ?? '';
    }
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
        widget.serverReady != oldWidget.serverReady ||
        widget.slots != oldWidget.slots) {
      _service.setModelName(widget.modelName);
      _service.sendStatusUpdate(
        widget.modelName,
        serverRunning: widget.serverReady,
        slots: widget.slots,
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

  void _queueServerConfigRefresh() {
    _serverConfigTimer?.cancel();
    _serverConfigTimer = Timer(const Duration(milliseconds: 500), () {
      unawaited(_refreshServerConfig(_url.text));
    });
  }

  Future<void> _refreshServerConfig(
    String input, {
    bool useStoredCredential = false,
  }) async {
    if (input.trim().isEmpty) {
      if (mounted && !_closing) {
        setState(() {
          _serverMode = '';
          _serverConfigError = '';
        });
      }
      return;
    }
    final String url;
    try {
      url = normalizeCloudUri(input).toString();
    } catch (_) {
      return;
    }
    final client = http.Client();
    _clients.add(client);
    try {
      final response = await client
          .get(cloudEndpoint(url, '/api/public/config'))
          .timeout(const Duration(seconds: 6));
      if (response.statusCode != 200) {
        throw StateError('服务器模式查询 HTTP ${response.statusCode}');
      }
      final decoded = jsonDecode(utf8.decode(response.bodyBytes));
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('服务器返回的模式配置无效');
      }
      final mode = decoded['mode']?.toString() ?? '';
      if (!['personal', 'provider', 'relay'].contains(mode)) {
        throw const FormatException('服务器运营模式无法识别');
      }
      if (_url.text.trim().isNotEmpty &&
          normalizeCloudUri(_url.text).toString() != url) {
        return;
      }
      final previousMode = _serverMode;
      if (mounted && !_closing) {
        setState(() {
          _serverMode = mode;
          _serverConfigError = '';
          if (previousMode.isNotEmpty &&
              previousMode != mode &&
              !useStoredCredential) {
            _password.clear();
            _status = '服务器运营模式已切换，请重新输入对应凭据';
          }
        });
      }
      if (useStoredCredential && mounted && !_closing) {
        final prefs = await SharedPreferences.getInstance();
        _password.text = mode == 'relay' || mode == 'provider'
            ? prefs.getString('cloud_relay_node_token') ?? ''
            : prefs.getString('cloud_password') ?? '';
      }
    } catch (error) {
      if (mounted && !_closing) {
        setState(() {
          _serverMode = '';
          _serverConfigError = error.toString();
        });
      }
    } finally {
      client.close();
      _clients.remove(client);
    }
  }

  Future<void> _connect() async {
    if (_closing || !_loaded || _connecting || _connected) return;
    if (!widget.serverReady) {
      _message('请先在首页启动模型并等待加载完成');
      return;
    }
    try {
      final url = normalizeCloudUri(_url.text).toString();
      await _refreshServerConfig(url);
      if (_serverMode.isEmpty) {
        throw FormatException(
          _serverConfigError.isEmpty
              ? '无法识别服务器运营模式，请检查地址和网络'
              : '无法获取服务器模式：$_serverConfigError',
        );
      }
      if (_password.text.isEmpty) {
        throw FormatException(
          _serverMode == 'relay' || _serverMode == 'provider'
              ? '请粘贴网页控制台发放的节点登录 Token' : '请输入管理员密码',
        );
      }
      final password = _password.text;
      if ((_serverMode == 'relay' || _serverMode == 'provider') &&
          (!password.startsWith('omm-relay-node-') ||
              password.length < 40 ||
              password.length > 256)) {
        throw const FormatException('请粘贴网页控制台发放的有效节点登录 Token');
      }
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
        slots: widget.slots,
      );
      if (!mounted || _closing) return;
      setState(() {
        _connected = connected;
        _status = connected
            ? _serverMode == 'relay'
                  ? '已连接到你的代转发节点'
                  : '已连接，节点在线'
            : (_service.lastError ?? '连接失败');
      });
      if (connected) {
        _reconnectAttempts = 0;
        _userDisconnected = false;
        _expectingDisconnect = false;
        _connectedUrl = url;
        _connectedPassword = password;
        final prefs = await SharedPreferences.getInstance();
        await prefs.setString('cloud_url', url);
        if (_serverMode == 'relay' || _serverMode == 'provider') {
          await prefs.setString('cloud_relay_node_token', password);
        } else {
          await prefs.setString('cloud_password', password);
        }
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
    _expectingDisconnect = true;
    _reconnectTimer?.cancel();
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
    _userDisconnected = true;
    _expectingDisconnect = true;
    _autoConnect = false;
    _reconnectTimer?.cancel();
    _reconnectAttempts = 0;
    _poll?.cancel();
    _service.disconnect();
    for (final client in _clients) {
      client.close();
    }
    scheduleMicrotask(() => _expectingDisconnect = false);
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
    if (_serverMode == 'relay' || _serverMode == 'provider') {
      if (mounted && !_closing && _connected) {
        setState(
          () => _nodes = [
            {
              'name': '此设备',
              'modelName': widget.modelName,
              'serverRunning': widget.serverReady,
              'isOnline': true,
              'slots': widget.slots,
            },
          ],
        );
      }
      _polling = false;
      return;
    }
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
        throw EngineException(
          text.length > 300 ? text.substring(0, 300) : text,
          response.statusCode,
        );
      }
      var output = '';
      await for (final event in decodeSse(response.stream)) {
        final data = jsonDecode(event);
        if (data['error'] != null)
          throw EngineException(data['error'].toString());
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
        if (_serverMode.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 7),
            child: Text(
              '已识别网关模式：${_serverMode == 'relay' ? '代转发 · 节点登录 Token' : _serverMode == 'provider' ? '服务商 · 节点登录 Token' : '个人 · 管理员密码'}',
              style: const TextStyle(color: Color(0xFF087F6E), fontSize: 12),
            ),
          ),
        const SizedBox(height: 12),
        Text(
          _serverMode == 'relay' || _serverMode == 'provider'
              ? '节点登录 Token' : '管理员密码',
        ),
        const SizedBox(height: 6),
        ft.TextBox(
          controller: _password,
          obscureText: true,
          enabled: !_connected && !_connecting,
          placeholder: _serverMode == 'relay' || _serverMode == 'provider'
              ? '从网页控制台的节点卡片复制一次性 Token'
              : '服务器管理员密码',
        ),
        if (_serverMode == 'relay' || _serverMode == 'provider')
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              '先在服务器 /console 登录并创建节点。Token 只显示一次，用于此设备连接；API 调用密钥在网页另行管理。',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
          )
        else if (_serverMode.isEmpty && _serverConfigError.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              '无法读取服务器模式：$_serverConfigError',
              style: const TextStyle(color: Colors.deepOrange),
            ),
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
              onPressed: _serverMode == 'personal' && _connected && !_testing ? _test : null,
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
        if (_serverMode == 'personal') ...[
        const SizedBox(height: 24),
        const Text(
          'API Key 管理',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        Text(
          _serverMode == 'relay'
              ? '这里管理本机应用使用的密钥。代转发网关的统一调用 API Key、用量和请求统计请在网页用户控制台管理。'
              : '密钥仅在本机持久化。当前不提供 Token 配额、计费或用量统计。',
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
      ],
    ),
  );

  @override
  void dispose() {
    disconnectForShutdown();
    _reconnectTimer?.cancel();
    _serverConfigTimer?.cancel();
    _url.removeListener(_queueServerConfigRefresh);
    unawaited(_subscription?.cancel());
    _service.dispose();
    _url.dispose();
    _password.dispose();
    _keyName.dispose();
    super.dispose();
  }
}
