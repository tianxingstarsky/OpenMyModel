import "dart:async";
import "dart:convert";
import "package:http/http.dart" as http;
import "package:web_socket_channel/web_socket_channel.dart";

/// WebSocket 隧道 —— 透传云后端请求到本地 llama-server
/// API Key 完全由本地管理，收到 validate_key 时本地核对
class WebSocketService {
  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  bool _connected = false;
  String _nodeId = "";
  String _llamaUrl = "http://127.0.0.1:8080";
  String _modelName = "";
  List<Map<String, dynamic>> _localKeys = [];

  final _msgCtrl = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get messages => _msgCtrl.stream;
  bool get isConnected => _connected;
  String get nodeId => _nodeId;

  void setLlamaUrl(String url) => _llamaUrl = url;
  void setModelName(String n) => _modelName = n;

  /// 设置本地 Key 列表（由 CloudPage 管理）
  void setLocalKeys(List<Map<String, dynamic>> keys) => _localKeys = keys;

  Future<bool> connect(String serverUrl, String password, {String nodeName = "local-node"}) async {
    try {
      _ch = WebSocketChannel.connect(Uri.parse("ws://" + serverUrl + "/ws/node"));
      await _ch!.ready;
      _ch!.sink.add(jsonEncode({"type":"auth","password":password,"nodeId":_nodeId,"nodeName":nodeName,"modelName":_modelName}));

      final c = Completer<bool>();
      _sub = _ch!.stream.listen(
        (d) {
          final m = jsonDecode(d as String);
          switch (m["type"]) {
            case "auth_ok":
              _nodeId = m["nodeId"] ?? "";
              _connected = true;
              if (!c.isCompleted) c.complete(true);
              _msgCtrl.add(m);
            case "auth_error":
              if (!c.isCompleted) c.complete(false);
            case "ping":
              _ch?.sink.add(jsonEncode({"type":"pong"}));
            case "validate_key":
              // 云端请求验证 API Key → 本地核对
              _handleValidateKey(m);
            case "http_relay":
              _handleHttpRelay(m);
            default:
              _msgCtrl.add(m);
          }
        },
        onError: (_) { _connected = false; if (!c.isCompleted) c.complete(false); },
        onDone: () { _connected = false; _msgCtrl.add({"type":"disconnected"}); },
      );
      return await c.future.timeout(const Duration(seconds: 10));
    } catch (_) { _connected = false; return false; }
  }

  /// 本地验证 API Key
  void _handleValidateKey(Map<String, dynamic> msg) {
    final requestId = msg["requestId"] as String;
    final key = msg["key"] as String;
    bool valid = false;
    for (final k in _localKeys) {
      if (k["key"] == key && k["isActive"] == true) {
        valid = true;
        break;
      }
    }
    _ch?.sink.add(jsonEncode({"type":"key_valid","requestId":requestId,"valid":valid}));
  }

  /// 原始 HTTP 镜像转发到 llama-server
  Future<void> _handleHttpRelay(Map<String, dynamic> msg) async {
    final requestId = msg["requestId"] as String;
    final path = msg["path"] as String? ?? "/v1/chat/completions";
    final body = msg["body"] as String? ?? "{}";

    try {
      final req = http.Request("POST", Uri.parse("$_llamaUrl$path"));
      req.headers["Content-Type"] = "application/json";
      req.body = body;

      final resp = await http.Client().send(req);
      final isStream = body.contains('"stream":true') || body.contains('"stream": true');

      if (isStream) {
        final stream = resp.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter());

        await for (final line in stream) {
          if (line.isNotEmpty) {
            _ch?.sink.add(jsonEncode({"type":"http_chunk","requestId":requestId,"data":line + "\n"}));
          }
        }
      } else {
        final respBody = await resp.stream.bytesToString();
        _ch?.sink.add(jsonEncode({"type":"http_chunk","requestId":requestId,"data":respBody}));
      }
      _ch?.sink.add(jsonEncode({"type":"http_done","requestId":requestId}));
    } catch (e) {
      _ch?.sink.add(jsonEncode({
        "type":"http_chunk","requestId":requestId,
        "data":'{"error":{"message":"${e.toString()}","type":"proxy_error"}}',
      }));
      _ch?.sink.add(jsonEncode({"type":"http_done","requestId":requestId}));
    }
  }

  void sendStatusUpdate(String n) {
    _modelName = n;
    if (_connected) _ch?.sink.add(jsonEncode({"type":"status_update","modelName":n}));
  }

  void disconnect() { _sub?.cancel(); _ch?.sink.close(); _connected = false; }
  void dispose() { disconnect(); _msgCtrl.close(); }
}
