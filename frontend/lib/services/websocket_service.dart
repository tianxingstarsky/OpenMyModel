import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

/// WebSocket 隧道 —— 透传云后端请求到本地 llama-server
class WebSocketService {
  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  bool _connected = false;
  String _nodeId = '';
  String _llamaUrl = 'http://127.0.0.1:8080';
  String _modelName = '';

  final _msgCtrl = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get messages => _msgCtrl.stream;
  bool get isConnected => _connected;
  String get nodeId => _nodeId;

  void setLlamaUrl(String url) => _llamaUrl = url;
  void setModelName(String n) => _modelName = n;

  Future<bool> connect(String serverUrl, String password, {String nodeName = 'local-node'}) async {
    try {
      _ch = WebSocketChannel.connect(Uri.parse('ws://' + serverUrl + '/ws/node'));
      await _ch!.ready;
      _ch!.sink.add(jsonEncode({'type':'auth','password':password,'nodeId':_nodeId,'nodeName':nodeName,'modelName':_modelName}));

      final c = Completer<bool>();
      _sub = _ch!.stream.listen(
        (d) {
          final m = jsonDecode(d as String);
          if (m['type'] == 'auth_ok') { _nodeId = m['nodeId'] ?? ''; _connected = true; if (!c.isCompleted) c.complete(true); _msgCtrl.add(m); }
          else if (m['type'] == 'auth_error') { if (!c.isCompleted) c.complete(false); }
          else if (m['type'] == 'ping') _ch?.sink.add(jsonEncode({'type':'pong'}));
          else if (m['type'] == 'chat_request') _handleChat(m);
          else _msgCtrl.add(m);
        },
        onError: (_) { _connected = false; if (!c.isCompleted) c.complete(false); },
        onDone: () { _connected = false; _msgCtrl.add({'type':'disconnected'}); },
      );
      return await c.future.timeout(const Duration(seconds: 10));
    } catch (_) { _connected = false; return false; }
  }

  Future<void> _handleChat(Map<String, dynamic> msg) async {
    final rid = msg['requestId'] as String;
    final data = msg['data'] as Map<String, dynamic>?;
    if (data == null) { _sendErr(rid, 'invalid'); return; }
    final stream = data['stream'] == true;
    try {
      final req = http.Request('POST', Uri.parse(_llamaUrl + '/chat/completions'));
      req.headers['Content-Type'] = 'application/json';
      req.body = jsonEncode(data);

      final resp = await http.Client().send(req);
      if (stream) {
        final chunks = <Map<String, dynamic>>[];
        var buf = '';
        await for (final b in resp.stream) {
          buf += utf8.decode(b);
          for (final line in buf.split('\n')) {
            if (line.startsWith('data:') && !line.contains('[DONE]')) {
              try { final c = jsonDecode(line.substring(5).trim()); if (c is Map<String, dynamic>) chunks.add(c); } catch (_) {}
            }
          }
          buf = buf.contains('\n') ? buf.substring(buf.lastIndexOf('\n')+1) : '';
        }
        _ch?.sink.add(jsonEncode({'type':'chat_response','requestId':rid,'data':{'chunks':chunks}}));
      } else {
        final body = await resp.stream.bytesToString();
        final obj = jsonDecode(body);
        _ch?.sink.add(jsonEncode({'type':'chat_response','requestId':rid,'data':obj}));
      }
    } catch (e) { _sendErr(rid, e.toString()); }
  }

  void _sendErr(String rid, String e) => _ch?.sink.add(jsonEncode({'type':'chat_error','requestId':rid,'error':e}));

  void syncKeys(List<Map<String, dynamic>> keys) {
    if (_connected && _ch != null) {
      _ch!.sink.add(jsonEncode({'type':'sync_keys','keys':keys}));
    }
  }

  void disconnect() { _sub?.cancel(); _ch?.sink.close(); _connected = false; }
  void sendStatusUpdate(String n) { _modelName = n; if (_connected) _ch?.sink.add(jsonEncode({'type':'status_update','modelName':n})); }
  void dispose() { disconnect(); _msgCtrl.close(); }
}
