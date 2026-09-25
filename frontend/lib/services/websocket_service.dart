import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'cloud_url.dart';

class WebSocketService {
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
  List<Map<String, dynamic>> _localKeys = [];
  Future<bool>? _connecting;
  Completer<bool>? _connectionResult;
  final List<StreamSubscription<dynamic>> _subscriptions = [];
  final _messages = StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get messages => _messages.stream;
  bool get isConnected => _connected;
  String get nodeId => _nodeId;
  String? get lastError => _lastError;

  void _emit(Map<String, dynamic> message) {
    if (!_disposed && !_messages.isClosed) _messages.add(message);
  }

  void setBridgePath(String path) => _bridgePath = path;
  void setModelName(String name) => _modelName = name;
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
      _lastError = '桥接进程已断开: $error';
      _cleanup();
      _emit({'type': 'error', 'message': _lastError});
    }
  }

  Future<bool> connect(
    String serverUrl,
    String password, {
    String nodeName = 'local-node',
    bool serverRunning = true,
    int? slots,
  }) {
    if (_disposed) return Future.value(false);
    if (_connecting != null) return _connecting!;
    final attempt = _connect(
      serverUrl,
      password,
      nodeName,
      serverRunning,
      slots,
    );
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
    _cleanup();
    final generation = _generation;
    _lastError = null;
    final result = Completer<bool>();
    _connectionResult = result;
    try {
      final url = normalizeCloudUri(serverUrl).toString();
      final script = _script();
      final process = await Process.start(_node(script), [
        script,
      ], workingDirectory: File(script).parent.path);
      if (_disposed || generation != _generation) {
        process.kill();
        return false;
      }
      _process = process;
      unawaited(
        process.stdin.done.catchError((Object error) {
          if (!_disposed && generation == _generation) _lastError = '桥接输入已关闭';
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
                      if (!result.isCompleted) result.complete(true);
                      break;
                    case 'error':
                      _lastError = message['message']?.toString() ?? '云端连接失败';
                      _connected = false;
                      if (!result.isCompleted) result.complete(false);
                      break;
                    case 'disconnected':
                      _connected = false;
                      if (!result.isCompleted) result.complete(false);
                      break;
                  }
                  _emit(message);
                } catch (_) {
                  /* Non-protocol output cannot mutate connection state. */
                }
              },
              onError: (Object error) {
                if (generation != _generation) return;
                _lastError = '桥接输出错误: $error';
                if (!result.isCompleted) result.complete(false);
              },
            ),
      );
      _subscriptions.add(process.stderr.transform(utf8.decoder).listen((_) {}));
      unawaited(
        process.exitCode.then((code) {
          if (_disposed || generation != _generation) return;
          _process = null;
          _connected = false;
          _lastError ??= '桥接进程退出 ($code)';
          if (!result.isCompleted) result.complete(false);
          _emit({'type': 'disconnected', 'message': _lastError});
        }),
      );
      _send({'cmd': 'set_keys', 'keys': _localKeys});
      _send({
        'cmd': 'connect',
        'url': url,
        'password': password,
        'nodeId': _nodeId,
        'nodeName': nodeName,
        'llamaUrl': _llamaUrl,
        'llamaApiKey': _llamaApiKey,
        'modelName': _modelName,
        'serverRunning': serverRunning,
        if (slots != null) 'slots': slots,
      });
      final connected = await result.future.timeout(
        const Duration(seconds: 12),
        onTimeout: () {
          _lastError = '连接超时，请检查服务器地址、网络和密码';
          return false;
        },
      );
      if (!connected && generation == _generation) _cleanup();
      return connected && generation == _generation && !_disposed;
    } catch (error) {
      _lastError = error.toString();
      if (generation == _generation) _cleanup();
      _emit({'type': 'error', 'message': _lastError});
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
      if (slots != null) 'slots': slots,
    });
  }

  void _cleanup() {
    _generation++;
    _connected = false;
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
    _connecting = null;
    _cleanup();
    _emit({'type': 'disconnected'});
  }

  void dispose() {
    _cleanup();
    _disposed = true;
    unawaited(_messages.close());
  }
}
