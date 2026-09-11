import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:openmymodel/services/python_bridge.dart';
import 'package:openmymodel/services/cloud_url.dart';

void main() {
  test(
    'SSE preserves split UTF8, CRLF, multiline data and final half line',
    () async {
      final bytes = utf8.encode(
        'data: {"text":"你好"}\r\n\r\ndata:first\ndata: second\n\ndata: last',
      );
      final events = await decodeSse(
        Stream.fromIterable(bytes.map((byte) => [byte])),
      ).toList();
      expect(events, ['{"text":"你好"}', 'first\nsecond', 'last']);
    },
  );

  test('SSE stops at DONE and ignores comment events', () async {
    final events = await decodeSse(
      Stream.value(utf8.encode(': ping\n\ndata: [DONE]\n\ndata: ignored\n\n')),
    ).toList();
    expect(events, isEmpty);
  });

  test('Cloud URL handles HTTPS and existing websocket paths', () {
    expect(
      normalizeCloudUri('host.test:3000').toString(),
      'http://host.test:3000',
    );
    expect(
      cloudEndpoint(
        'wss://host.test/prefix/ws/node',
        '/admin/nodes',
      ).toString(),
      'https://host.test/prefix/admin/nodes',
    );
    for (final url in [
      'ftp://host.test',
      'http://user:pass@host.test',
      'http://host.test?secret=yes',
      '',
    ]) {
      expect(() => normalizeCloudUri(url), throwsFormatException);
    }
  });

  test('Profiles parse objects and encode Chinese names in query', () async {
    final bridge = PythonBridge(
      clientFactory: () => MockClient((request) async {
        if (request.method == 'DELETE') {
          expect(request.url.queryParameters['name'], '中文 档案 & one');
          return http.Response('{"ok":true}', 200);
        }
        return http.Response('{"server_path":"server.exe","port":9090}', 200);
      }),
    );
    addTearDown(bridge.dispose);
    expect((await bridge.loadProfile('example'))!.port, 9090);
    expect(await bridge.deleteProfile('中文 档案 & one'), true);
  });

  test('HTTP failures expose detail instead of empty chat', () async {
    final bridge = PythonBridge(
      clientFactory: () => MockClient(
        (_) async => http.Response('{"detail":"not running"}', 503),
      ),
    );
    addTearDown(bridge.dispose);
    await expectLater(
      bridge.chatStream([]).toList(),
      throwsA(
        isA<BridgeException>().having((e) => e.statusCode, 'status', 503),
      ),
    );
    await expectLater(bridge.stopServer(), throwsA(isA<BridgeException>()));
  });

  test(
    'Cancelling a real pending stream closes its upstream connection',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final started = Completer<void>();
      final bridge = PythonBridge(baseUrl: 'http://127.0.0.1:${server.port}');
      HttpResponse? response;
      server.listen((request) async {
        await request.drain<void>();
        response = request.response;
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
        );
        request.response.write('data: {"choices":[]}\n\n');
        await request.response.flush();
        started.complete();
      });
      addTearDown(() async {
        bridge.dispose();
        await server.close(force: true);
      });
      final finished = bridge
          .chatStream([])
          .drain<void>()
          .catchError((Object _) {});
      await started.future.timeout(const Duration(seconds: 3));
      bridge.cancelChat();
      await finished.timeout(const Duration(seconds: 3));
      // A fresh request is allowed only once the cancelled stream has settled.
      await response?.close();
    },
  );

  test('Dispose prevents accidental recreation of an HTTP client', () async {
    final bridge = PythonBridge();
    bridge.dispose();
    await expectLater(bridge.getStatus(), throwsStateError);
    await expectLater(bridge.chatStream([]).toList(), throwsStateError);
  });
}
