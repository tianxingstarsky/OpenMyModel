import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/services/websocket_service.dart';

Map<String, dynamic> inventory(String name) => {
  'os': 'windows',
  'arch': 'x64',
  'status': 'detected',
  'source': 'nvidia-smi',
  'detectedAt': '2026-10-07T00:00:00.000Z',
  'devices': [
    {'name': name, 'backend': 'cuda', 'totalMemoryMiB': 16311},
  ],
};

void main() {
  test(
    'Bridge reports detected hardware before model startup and on refresh',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final service = WebSocketService()
        ..setBridgePath('../scripts/cloud_bridge.js');
      final initialHardware = inventory('Initial GPU');
      service.setHardwareInfo(initialHardware);
      (initialHardware['devices'] as List).first['name'] = 'Caller mutation';
      final auth = Completer<Map<String, dynamic>>();
      final refreshed = Completer<Map<String, dynamic>>();
      final modelReady = Completer<Map<String, dynamic>>();
      WebSocket? socket;
      server.listen((request) async {
        socket = await WebSocketTransformer.upgrade(request);
        socket!.listen((raw) {
          final message = Map<String, dynamic>.from(jsonDecode(raw as String));
          if (message['type'] == 'auth') {
            auth.complete(message);
            socket!.add(
              jsonEncode({'type': 'auth_ok', 'nodeId': 'hardware-node'}),
            );
          }
          if (message['type'] == 'status_update' &&
              message['hardware'] is Map) {
            final devices = message['hardware']['devices'] as List;
            if (devices.first['name'] == 'Refreshed GPU' &&
                !refreshed.isCompleted) {
              refreshed.complete(message);
            }
            if (message['serverRunning'] == true && !modelReady.isCompleted) {
              modelReady.complete(message);
            }
          }
        });
      });
      addTearDown(() async {
        service.dispose();
        await socket?.close();
        await server.close(force: true);
      });
      expect(
        await service.connect(
          'http://127.0.0.1:${server.port}',
          'fixture-password',
          serverRunning: false,
        ),
        true,
      );
      final first = await auth.future.timeout(const Duration(seconds: 3));
      expect(first['serverRunning'], false);
      expect(first['hardware']['devices'].first['name'], 'Initial GPU');
      service.setHardwareInfo(inventory('Refreshed GPU'));
      final update = await refreshed.future.timeout(const Duration(seconds: 3));
      expect(update['hardware']['devices'].first['totalMemoryMiB'], 16311);
      service.sendStatusUpdate('Ready model', serverRunning: true, slots: 3);
      final ready = await modelReady.future.timeout(const Duration(seconds: 3));
      expect(ready['modelName'], 'Ready model');
      expect(ready['hardware']['devices'].first['name'], 'Refreshed GPU');
    },
  );

  test(
    'Probe completion during authentication is delivered after auth',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final service = WebSocketService()
        ..setBridgePath('../scripts/cloud_bridge.js');
      final auth = Completer<void>();
      final update = Completer<Map<String, dynamic>>();
      WebSocket? socket;
      server.listen((request) async {
        socket = await WebSocketTransformer.upgrade(request);
        socket!.listen((raw) {
          final message = Map<String, dynamic>.from(jsonDecode(raw as String));
          if (message['type'] == 'auth') auth.complete();
          if (message['type'] == 'status_update' && !update.isCompleted) {
            update.complete(message);
          }
        });
      });
      addTearDown(() async {
        service.dispose();
        await socket?.close();
        await server.close(force: true);
      });
      final connection = service.connect(
        'http://127.0.0.1:${server.port}',
        'fixture-password',
        serverRunning: false,
      );
      await auth.future.timeout(const Duration(seconds: 3));
      service.setHardwareInfo(inventory('Detected during authentication'));
      socket!.add(jsonEncode({'type': 'auth_ok', 'nodeId': 'hardware-node'}));
      expect(await connection, true);
      final received = await update.future.timeout(const Duration(seconds: 3));
      expect(
        received['hardware']['devices'].first['name'],
        'Detected during authentication',
      );
      expect(received['serverRunning'], isNot(true));
    },
  );
}
