import "dart:async";
import "dart:convert";
import "dart:io";

/// WebSocket 隧道 - 通过 Node.js 桥接进程管理云端连接
class WebSocketService {
  Process? _process;
  bool _connected = false;
  String _nodeId = "";
  String _llamaUrl = "http://127.0.0.1:8080";
  String _modelName = "";
  List<Map<String, dynamic>> _localKeys = [];
  String _bridgePath = "";

  final _msgCtrl = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get messages => _msgCtrl.stream;
  bool get isConnected => _connected;
  String get nodeId => _nodeId;

  void setLlamaUrl(String url) => _llamaUrl = url;
  void setModelName(String n) => _modelName = n;
  void setLocalKeys(List<Map<String, dynamic>> keys) {
    _localKeys = keys;
    _send({"cmd": "set_keys", "keys": keys});
  }

  void _oldSetLocalKeys(List<Map<String, dynamic>> keys) => _localKeys = keys;
  void setBridgePath(String path) => _bridgePath = path;

  void _send(Map<String, dynamic> cmd) {
    if (_process != null) {
      _process!.stdin.write(jsonEncode(cmd) + "\n");
    }
  }

  Future<bool> connect(String serverUrl, String password, {String nodeName = "local-node"}) async {
    try {
      // Kill existing process
      _process?.kill();
      _process = null;

      final bridgeScript = _bridgePath.isNotEmpty
          ? _bridgePath
          : "scripts/cloud_bridge.js";

      _process = await Process.start("node", [bridgeScript]);
      _connected = false;

      // Listen for stdout (JSON messages)
      _process!.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) {
        try {
          final msg = jsonDecode(line) as Map<String, dynamic>;
          final type = msg["type"] as String?;
          if (type == "connected") {
            _nodeId = msg["nodeId"] ?? "";
            _connected = true;
          } else if (type == "disconnected") {
            _connected = false;
          } else if (type == "error") {
            _connected = false;
          }
          _msgCtrl.add(msg);
        } catch (_) {}
      });

      // Listen for stderr
      _process!.stderr
          .transform(utf8.decoder)
          .listen((d) {/* ignore stderr */});

      // Send connect command
      _send({
        "cmd": "connect",
        "url": serverUrl,
        "password": password,
        "nodeName": nodeName,
        "llamaUrl": _llamaUrl,
        "modelName": _modelName,
      });
      // Sync keys after connect
      if (_localKeys.isNotEmpty) {
        _send({"cmd": "set_keys", "keys": _localKeys});
      }

      // Wait for connected or error
      final c = Completer<bool>();
      StreamSubscription? sub;
      sub = _msgCtrl.stream.listen((msg) {
        if (msg["type"] == "connected") {
          if (!c.isCompleted) c.complete(true);
        } else if (msg["type"] == "error") {
          if (!c.isCompleted) c.complete(false);
        } else if (msg["type"] == "disconnected") {
          if (!c.isCompleted) c.complete(false);
        }
      });

      final result = await c.future.timeout(const Duration(seconds: 10));
      sub?.cancel();
      return result;
    } catch (_) {
      _connected = false;
      return false;
    }
  }

  void sendStatusUpdate(String n) {
    _modelName = n;
    _send({"cmd": "status_update", "modelName": n});
  }

  void disconnect() {
    _send({"cmd": "disconnect"});
    _process?.kill();
    _process = null;
    _connected = false;
  }

  void dispose() { disconnect(); _msgCtrl.close(); }
}
