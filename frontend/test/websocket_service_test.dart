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
      final statusResult = Completer<Map<String, dynamic>>();
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
          if (message['type'] == 'status_update' && !statusResult.isCompleted)
            statusResult.complete(Map<String, dynamic>.from(message));
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
          slots: 4,
        ),
        true,
      );
      expect(service.isConnected, true);
      expect(
        (await keyResult.future.timeout(const Duration(seconds: 3)))['valid'],
        true,
      );
      service.sendStatusUpdate('fixture-model', slots: null);
      final status = await statusResult.future.timeout(
        const Duration(seconds: 3),
      );
      expect(status.containsKey('slots'), true);
      expect(status['slots'], isNull);
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
      expect(service.lastFailureRetryable, false);
      expect(service.lastErrorCode, 'invalid_server_url');
      expect(service.isConnected, false);
    },
  );

  test('Repeated requests for the same connection open one tunnel', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final service = WebSocketService()
      ..setBridgePath('../scripts/cloud_bridge.js');
    final sockets = <WebSocket>[];
    var authentications = 0;
    server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((raw) {
        if (jsonDecode(raw as String)['type'] != 'auth') return;
        authentications++;
        socket.add(jsonEncode({'type': 'auth_ok', 'nodeId': 'shared-node'}));
      });
    });
    addTearDown(() async {
      service.dispose();
      for (final socket in sockets) {
        await socket.close();
      }
      await server.close(force: true);
    });
    final url = 'http://127.0.0.1:${server.port}';
    final first = service.connect(url, 'same-password');
    final duplicate = service.connect(url, 'same-password');
    expect(identical(first, duplicate), true);
    expect(await first, true);
    expect(await duplicate, true);
    expect(await service.connect(url, 'same-password'), true);
    expect(authentications, 1);
  });

  test('Changing credentials replaces a pending connection', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final service = WebSocketService()
      ..setBridgePath('../scripts/cloud_bridge.js');
    final sockets = <WebSocket>[];
    final firstAuth = Completer<void>();
    final passwords = <String>[];
    server.listen((request) async {
      final socket = await WebSocketTransformer.upgrade(request);
      sockets.add(socket);
      socket.listen((raw) {
        final message = jsonDecode(raw as String);
        if (message['type'] != 'auth') return;
        passwords.add(message['password'] as String);
        if (message['password'] == 'first-password') {
          firstAuth.complete();
        } else {
          socket.add(jsonEncode({'type': 'auth_ok', 'nodeId': 'second-node'}));
        }
      });
    });
    addTearDown(() async {
      service.dispose();
      for (final socket in sockets) {
        await socket.close();
      }
      await server.close(force: true);
    });
    final url = 'http://127.0.0.1:${server.port}';
    final first = service.connect(url, 'first-password');
    await firstAuth.future.timeout(const Duration(seconds: 3));
    final second = service.connect(url, 'second-password');
    expect(await first, false);
    expect(await second, true);
    expect(passwords, ['first-password', 'second-password']);
    expect(service.nodeId, 'second-node');
    expect(service.isConnected, true);
    expect(service.lastError, isNull);
  });

  test(
    'Node identity is retained only for the same server and account',
    () async {
      final servers = [
        await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
        await HttpServer.bind(InternetAddress.loopbackIPv4, 0),
      ];
      final service = WebSocketService()
        ..setBridgePath('../scripts/cloud_bridge.js');
      final sockets = <WebSocket>[];
      final sentIds = <String>[];
      for (final server in servers) {
        server.listen((request) async {
          final socket = await WebSocketTransformer.upgrade(request);
          sockets.add(socket);
          socket.listen((raw) {
            final message = jsonDecode(raw as String);
            if (message['type'] != 'auth') return;
            sentIds.add(message['nodeId'] as String);
            socket.add(
              jsonEncode({
                'type': 'auth_ok',
                'nodeId': 'node-${sentIds.length}',
              }),
            );
          });
        });
      }
      addTearDown(() async {
        service.dispose();
        for (final socket in sockets) {
          await socket.close();
        }
        for (final server in servers) {
          await server.close(force: true);
        }
      });
      final firstUrl = 'http://127.0.0.1:${servers.first.port}';
      expect(
        await service.connect(
          firstUrl,
          'first-account',
          nodeId: 'persisted-node',
        ),
        true,
      );
      service.disconnect();
      expect(await service.connect(firstUrl, 'first-account'), true);
      expect(await service.connect(firstUrl, 'second-account'), true);
      expect(
        await service.connect(
          'http://127.0.0.1:${servers.last.port}',
          'second-account',
        ),
        true,
      );
      expect(sentIds, ['persisted-node', 'node-1', '', '']);
    },
  );

  test(
    'Disconnect cancels authentication and does not report a network failure',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final service = WebSocketService()
        ..setBridgePath('../scripts/cloud_bridge.js');
      final auth = Completer<WebSocket>();
      final closed = Completer<void>();
      final events = <Map<String, dynamic>>[];
      final subscription = service.messages.listen(events.add);
      server.listen((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        socket.listen((raw) {
          if (jsonDecode(raw as String)['type'] == 'auth')
            auth.complete(socket);
        }, onDone: closed.complete);
      });
      addTearDown(() async {
        service.dispose();
        await subscription.cancel();
        await server.close(force: true);
      });
      final attempt = service.connect(
        'http://127.0.0.1:${server.port}',
        'password',
      );
      await auth.future.timeout(const Duration(seconds: 3));
      service.disconnect();
      expect(await attempt, false);
      await closed.future.timeout(const Duration(seconds: 3));
      expect(service.isConnected, false);
      expect(service.lastError, isNull);
      expect(service.lastFailureRetryable, false);
      expect(events.where((event) => event['type'] == 'connected'), isEmpty);
      expect(events.last['code'], 'user_disconnected');
    },
  );

  test(
    'An authentication deadline closes the socket and reports a retryable timeout',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final service = WebSocketService(
        connectionTimeout: const Duration(seconds: 1),
      )..setBridgePath('../scripts/cloud_bridge.js');
      final auth = Completer<void>();
      final closed = Completer<void>();
      server.listen((request) async {
        final socket = await WebSocketTransformer.upgrade(request);
        socket.listen((raw) {
          if (jsonDecode(raw as String)['type'] == 'auth') auth.complete();
        }, onDone: closed.complete);
      });
      addTearDown(() async {
        service.dispose();
        await server.close(force: true);
      });
      final timeout = service.messages.firstWhere(
        (event) => event['code'] == 'connection_timeout',
      );
      final attempt = service.connect(
        'http://127.0.0.1:${server.port}',
        'password',
      );
      await auth.future.timeout(const Duration(seconds: 3));
      expect(await attempt, false);
      expect((await timeout)['retryable'], true);
      await closed.future.timeout(const Duration(seconds: 3));
      expect(service.isConnected, false);
      expect(service.lastFailureRetryable, true);
      expect(service.lastErrorCode, 'connection_timeout');
    },
  );

  test(
    'A rejected account remains a non-retryable authentication failure',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final service = WebSocketService()
        ..setBridgePath('../scripts/cloud_bridge.js');
      WebSocket? socket;
      server.listen((request) async {
        socket = await WebSocketTransformer.upgrade(request);
        socket!.listen((raw) {
          if (jsonDecode(raw as String)['type'] != 'auth') return;
          socket!.add(
            jsonEncode({
              'type': 'auth_error',
              'code': 'provider_not_approved',
              'message': '请等待管理员批准算力申请',
              'retryable': false,
            }),
          );
        });
      });
      addTearDown(() async {
        service.dispose();
        await socket?.close();
        await server.close(force: true);
      });
      final error = service.messages.firstWhere(
        (event) => event['type'] == 'error',
      );
      expect(
        await service.connect('http://127.0.0.1:${server.port}', 'token'),
        false,
      );
      expect((await error)['code'], 'provider_not_approved');
      expect(service.lastFailureRetryable, false);
      expect(service.lastErrorCode, 'provider_not_approved');
      expect(service.lastError, '请等待管理员批准算力申请');
      expect(service.isConnected, false);
    },
  );
}
