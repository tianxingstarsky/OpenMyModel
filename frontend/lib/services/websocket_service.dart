import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

/// 云端 WebSocket 服务
/// 维持与 TypeScript 云后端的隧道连接

class WebSocketService {
  WebSocketChannel? _channel;
  bool _connected = false;
  String _nodeId = "";

  final StreamController<Map<String, dynamic>> _messageController =
      StreamController<Map<String, dynamic>>.broadcast();

  Stream<Map<String, dynamic>> get messages => _messageController.stream;
  bool get isConnected => _connected;
  String get nodeId => _nodeId;

  Future<bool> connect(String serverUrl, String password, {String nodeName = "本地算力节点"}) async {
    try {
      final uri = Uri.parse("ws://$serverUrl/ws/node");
      _channel = WebSocketChannel.connect(uri);

      await _channel!.ready;

      // 发送认证
      _channel!.sink.add(jsonEncode({
        "type": "auth",
        "password": password,
        "nodeId": _nodeId,
        "nodeName": nodeName,
      }));

      // 等待认证结果
      final completer = Completer<bool>();
      _channel!.stream.listen(
        (data) {
          final msg = jsonDecode(data as String);
          if (msg["type"] == "auth_ok") {
            _nodeId = msg["nodeId"] ?? "";
            _connected = true;
            completer.complete(true);
          } else if (msg["type"] == "auth_error") {
            completer.complete(false);
          } else {
            _messageController.add(msg);
          }
        },
        onError: (e) {
          _connected = false;
          if (!completer.isCompleted) completer.complete(false);
        },
        onDone: () {
          _connected = false;
        },
      );

      return await completer.future.timeout(const Duration(seconds: 10));
    } catch (_) {
      _connected = false;
      return false;
    }
  }

  void disconnect() {
    _channel?.sink.close();
    _connected = false;
  }

  void sendStatusUpdate(String modelName) {
    if (_connected && _channel != null) {
      _channel!.sink.add(jsonEncode({
        "type": "status_update",
        "modelName": modelName,
      }));
    }
  }
}