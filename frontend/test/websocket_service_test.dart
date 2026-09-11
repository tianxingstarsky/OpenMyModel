import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/services/websocket_service.dart';

void main() {
  test(
    'Production bridge receives keys before auth and tracks real socket exit',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final service = WebSocketService();
      final keyResult = Completer<Map<String, dynamic>>();
      WebSocket? cloudSocket;
      service.setBridgePath('../scripts/cloud_bridge.js');
      service.setLocalKeys([
        {'key': 'local-fixture-key', 'isActive': true},
      ]);
      final disconnected = service.messages.firstWhere(
        (message) => message['type'] == 'disconnected',
      );
      server.listen((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        cloudSocket = socket;
        socket.listen((raw) {
          final message = jsonDecode(raw as String);
          if (message['type'] == 'auth') {
            expect(message['serverRunning'], true);
            socket.add(
              jsonEncode({'type': 'auth_ok', 'nodeId': 'fixture-node'}),
            );
            socket.add(
              jsonEncode({
                'type': 'validate_key',
                'requestId': 'key-check',
                'key': 'local-fixture-key',
              }),
            );
          }
          if (message['type'] == 'key_valid' && !keyResult.isCompleted)
            keyResult.complete(Map<String, dynamic>.from(message));
        });
      });
      addTearDown(() async {
        service.dispose();
        await cloudSocket?.close();
        await server.close(force: true);
      });
      expect(
        await service.connect(
          'http://127.0.0.1:${server.port}',
          'fixture-password',
        ),
        true,
      );
      expect(service.isConnected, true);
      expect(
        (await keyResult.future.timeout(const Duration(seconds: 3)))['valid'],
        true,
      );
      await cloudSocket!.close();
      await disconnected.timeout(const Duration(seconds: 3));
      expect(service.isConnected, false);
    },
  );

  test(
    'Concurrent connection calls share one attempt and invalid URL fails clearly',
    () async {
      final service = WebSocketService();
      addTearDown(service.dispose);
      final result = await Future.wait([
        service.connect('ftp://invalid.test', 'password'),
        service.connect('ftp://invalid.test', 'password'),
      ]);
      expect(result, [false, false]);
      expect(service.lastError, contains('HTTP(S)'));
      expect(service.isConnected, false);
    },
  );
}
