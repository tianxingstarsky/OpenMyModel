import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main() async {
  final password = Platform.environment['ADMIN_PASSWORD'];
  if (password == null || password.isEmpty) {
    stderr.writeln('Set ADMIN_PASSWORD before running the WebSocket smoke test.');
    exitCode = 1;
    return;
  }
  WebSocket? socket;
  try {
    socket = await WebSocket.connect(
      Platform.environment['CLOUD_WS_URL'] ?? 'ws://127.0.0.1:3000/ws/node',
    ).timeout(const Duration(seconds: 10));
    socket.add(jsonEncode({
      'type': 'auth', 'password': password,
      'nodeName': 'dart-smoke', 'serverRunning': false, 'protocolVersion': 2,
    }));
    final message = jsonDecode(await socket.first.timeout(const Duration(seconds: 10)) as String);
    if (message['type'] != 'auth_ok') {
      throw StateError(message['message']?.toString() ?? 'Authentication failed');
    }
    stdout.writeln('WebSocket authentication succeeded.');
  } catch (error) {
    stderr.writeln('WebSocket test failed: $error');
    exitCode = 1;
  } finally {
    await socket?.close();
  }
}
