import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'cloud_url.dart';

class WebSocketService {
  WebSocketService({Duration connectionTimeout = const Duration(seconds: 12)})
    : _connectionTimeout = connectionTimeout;

  final Duration _connectionTimeout;
  Process? _process;
  bool _connected = false;
  bool _disposed = false;
  int _generation = 0;
  String _nodeId = '';
  String _llamaUrl = 'http://127.0.0.1:8080';
  String _llamaApiKey = '';
  String _modelName = '';
  String _bridgePath = '';
  String? _lastError;
  String? _lastErrorCode;
  bool? _lastFailureRetryable;
  String? _activeConnectionKey;
  String? _nodeIdentity;
  List<Map<String, dynamic>> _localKeys = [];
  Map<String, dynamic>? _hardwareInfo;
  Future<bool>? _connecting;
  Completer<bool>? _connectionResult;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  final _messages = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get messages => _messages.stream;
  bool get isConnected => _connected;
  String get nodeId => _nodeId;
  String? get lastError => _lastError;
  String? get lastErrorCode => _lastErrorCode;
  bool? get lastFailureRetryable => _lastFailureRetryable;

  void _emit(Map<String, dynamic> message) {
    if (!_disposed && !_messages.isClosed) _messages.add(message);
  }

  void setBridgePath(String path) => _bridgePath = path;
  void setModelName(String name) => _modelName = name;
  void setHardwareInfo(Map<String, dynamic> hardware) {
    // Copy nested lists/maps so a caller cannot change a pending report.
    _hardwareInfo = Map<String, dynamic>.from(jsonDecode(jsonEncode(hardware)));
    _send({'cmd': 'hardware_update', 'hardware': _hardwareInfo});
  }

  void setLlamaUrl(String url, {String apiKey = ''}) {
    if (_llamaUrl == url && _llamaApiKey == apiKey) return;
    _llamaUrl = url;
    _llamaApiKey = apiKey;
    _send({'cmd': 'set_llama_url', 'llamaUrl': url, 'llamaApiKey': apiKey});
  }

  void setLocalKeys(List<Map<String, dynamic>> keys) {
    _localKeys = List<Map<String, dynamic>>.from(keys);
    _send({'cmd': 'set_keys', 'keys': _localKeys});
  }

  Iterable<Directory> _roots() sync* {
    final seen = <String>{};
    for (final start in [
      File(Platform.resolvedExecutable).parent,
      Directory.current,
    ]) {
      var directory = start.absolute;
      for (var i = 0; i < 8; i++) {
        if (seen.add(directory.path)) yield directory;
        if (directory.parent.path == directory.path) break;
        directory = directory.parent;
      }
    }
  }

  String _script() {
    if (_bridgePath.isNotEmpty && File(_bridgePath).existsSync())
      return File(_bridgePath).absolute.path;
    for (final root in _roots()) {
      final file = File('${root.path}/scripts/cloud_bridge.js');
      if (file.existsSync()) return file.path;
    }
    throw StateError('找不到 scripts/cloud_bridge.js，请检查安装目录');
  }

  String _node(String script) {
    final executable = Platform.isWindows ? 'node.exe' : 'node';
    for (final path in [
      '${File(script).parent.path}/$executable',
      '${File(script).parent.path}/node/$executable',
      '${File(Platform.resolvedExecutable).parent.path}/scripts/$executable',
    ]) {
      if (File(path).existsSync()) return File(path).absolute.path;
    }
    return 'node';
  }

  void _send(Map<String, dynamic> command) {
    final process = _process;
    if (process == null || _disposed) return;
    try {
      process.stdin.writeln(jsonEncode(command));
    } catch (error) {
      _fail(
        '桥接进程已断开: $error',
        code: 'bridge_input_closed',
        retryable: true,
        generation: _generation,
      );
    }
  }

  void _fail(
    String message, {
    required String code,
    required bool retryable,
    required int generation,
    String type = 'error',
  }) {
    if (_disposed || generation != _generation) return;
    _lastError = message;
    _lastErrorCode = code;
    _lastFailureRetryable = retryable;
    // A failed bridge must stop forwarding requests before another attempt starts.
    _cleanup();
    _emit({
      'type': type,
      'message': message,
      'code': code,
      'reason': code,
      'retryable': retryable,
    });
  }

  Future<bool> connect(
    String serverUrl,
    String password, {
    String? nodeId,
    String nodeName = 'local-node',
    bool serverRunning = true,
    int? slots,
  }) {
    if (_disposed) return Future.value(false);
    final String url;
    try {
      url = normalizeCloudUri(serverUrl).toString();
    } on FormatException catch (error) {
      _fail(
        error.message,
        code: 'invalid_server_url',
        retryable: false,
        generation: _generation,
      );
      return Future.value(false);
    }
    final key = jsonEncode([
      url,
      password,
      nodeId,
      nodeName,
      serverRunning,
      slots,
    ]);
    if (_activeConnectionKey == key) {
      if (_connecting != null) return _connecting!;
      if (_connected) return Future.value(true);
    }
    _cleanup();
    final identity = jsonEncode([url, password]);
    // Node IDs belong to a server and an account. Never reuse one after either changes.
    if (_nodeIdentity != identity) _nodeId = '';
    _nodeIdentity = identity;
    if (nodeId != null) _nodeId = nodeId.trim();
    _activeConnectionKey = key;
    final attempt = _connect(url, password, nodeName, serverRunning, slots);
    _connecting = attempt;
    unawaited(
      attempt.whenComplete(() {
        if (identical(_connecting, attempt)) _connecting = null;
      }),
    );
    return attempt;
  }

  Future<bool> _connect(
    String serverUrl,
    String password,
    String nodeName,
    bool serverRunning,
    int? slots,
  ) async {
    final generation = _generation;
    _lastError = null;
    _lastErrorCode = null;
    _lastFailureRetryable = null;
    final result = Completer<bool>();
    _connectionResult = result;
    try {
      final script = _script();
      final process = await Process.start(_node(script), [
        script,
      ], workingDirectory: File(script).parent.path);
      if (_disposed || generation != _generation) {
        process.kill();
        unawaited(process.stdout.drain<void>());
        unawaited(process.stderr.drain<void>());
        unawaited(process.stdin.close().catchError((Object _) {}));
        return false;
      }
      _process = process;
      unawaited(
        process.stdin.done.catchError((Object error) {
          _fail(
            '桥接输入已关闭',
            code: 'bridge_input_closed',
            retryable: true,
            generation: generation,
          );
        }),
      );
      _subscriptions.add(
        process.stdout
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .listen(
              (line) {
                if (_disposed || generation != _generation) return;
                try {
                  final message = Map<String, dynamic>.from(jsonDecode(line));
                  switch (message['type']) {
                    case 'connected':
                      _nodeId = message['nodeId']?.toString() ?? '';
                      _connected = true;
                      _lastError = null;
                      _lastErrorCode = null;
                      _lastFailureRetryable = null;
                      if (!result.isCompleted) result.complete(true);
                      break;
                    case 'error':
                    case 'disconnected':
                      _fail(
                        message['message']?.toString() ?? '云端连接已断开',
                        code:
                            message['code']?.toString() ??
                            message['reason']?.toString() ??
                            'connection_lost',
                        retryable: message['retryable'] is bool
                            ? message['retryable'] as bool
                            : true,
                        generation: generation,
                        type: message['type'] as String,
                      );
                      return;
                  }
                  _emit(message);
                } catch (_) {
                  /* Non-protocol output cannot mutate connection state. */
                }
              },
              onError: (Object error) {
                _fail(
                  '桥接输出错误: $error',
                  code: 'bridge_output_error',
                  retryable: true,
                  generation: generation,
                );
              },
              onDone: () => _fail(
                '桥接输出已关闭，请重新连接',
                code: 'bridge_output_closed',
                retryable: true,
                generation: generation,
                type: 'disconnected',
              ),
            ),
      );
      _subscriptions.add(process.stderr.listen((_) {}, onError: (Object _) {}));
      unawaited(
        process.exitCode.then((code) {
          _fail(
            '桥接进程退出 ($code)',
            code: 'bridge_exited',
            retryable: true,
            generation: generation,
            type: 'disconnected',
          );
        }),
      );
      _send({'cmd': 'set_keys', 'keys': _localKeys});
      _send({
        'cmd': 'connect',
        'url': serverUrl,
        'serverUrlIsCanonical': true,
        'password': password,
        'nodeId': _nodeId,
        'nodeName': nodeName,
        'llamaUrl': _llamaUrl,
        'llamaApiKey': _llamaApiKey,
        'modelName': _modelName,
        'serverRunning': serverRunning,
        if (_hardwareInfo != null) 'hardware': _hardwareInfo,
        if (slots != null) 'slots': slots,
      });
      final connected = await result.future.timeout(
        _connectionTimeout,
        onTimeout: () {
          _fail(
            '连接超时，请检查服务器地址和网络',
            code: 'connection_timeout',
            retryable: true,
            generation: generation,
          );
          return false;
        },
      );
      if (!connected && generation == _generation) _cleanup();
      return connected && generation == _generation && !_disposed;
    } catch (error) {
      _fail(
        error.toString(),
        code: error is ProcessException
            ? 'bridge_unavailable'
            : 'bridge_setup_failed',
        retryable: false,
        generation: generation,
      );
      return false;
    } finally {
      if (identical(_connectionResult, result)) _connectionResult = null;
    }
  }

  void sendStatusUpdate(String name, {bool serverRunning = true, int? slots}) {
    _modelName = name;
    _send({
      'cmd': 'status_update',
      'modelName': name,
      'serverRunning': serverRunning,
      if (_hardwareInfo != null) 'hardware': _hardwareInfo,
      'slots': slots,
    });
  }

  void _cleanup() {
    _generation++;
    _connected = false;
    _connecting = null;
    _activeConnectionKey = null;
    if (_connectionResult != null && !_connectionResult!.isCompleted)
      _connectionResult!.complete(false);
    for (final subscription in _subscriptions) {
      unawaited(subscription.cancel());
    }
    _subscriptions.clear();
    final process = _process;
    _process = null;
    if (process != null) {
      try {
        process.stdin.writeln(jsonEncode({'cmd': 'exit'}));
      } catch (_) {}
      unawaited(
        process.exitCode.timeout(
          const Duration(seconds: 2),
          onTimeout: () {
            process.kill();
            return -1;
          },
        ),
      );
    }
  }

  void disconnect() {
    _cleanup();
    _lastError = null;
    _lastErrorCode = 'user_disconnected';
    _lastFailureRetryable = false;
    _emit({
      'type': 'disconnected',
      'code': 'user_disconnected',
      'reason': 'user_disconnected',
      'retryable': false,
    });
  }

  void dispose() {
    _cleanup();
    _disposed = true;
    unawaited(_messages.close());
  }
}
