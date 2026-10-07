import 'dart:async';
import 'dart:convert';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:flutter/widgets.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:openmymodel/pages/cloud_page.dart';
import 'package:openmymodel/services/websocket_service.dart';

Future<Map<String, dynamic>> _unknownHardware() async => {
  'os': 'test',
  'arch': 'test',
  'status': 'unknown',
  'devices': <Map<String, dynamic>>[],
  'source': 'unavailable',
  'detectedAt': '2026-10-07T00:00:00.000Z',
};

class _Connection extends WebSocketService {
  final events = StreamController<Map<String, dynamic>>.broadcast();
  final List<bool> outcomes;
  int attempts = 0;
  bool connected = false;
  bool retryable = true;
  final availability = <bool>[];
  final hardwareReports = <Map<String, dynamic>>[];
  _Connection([this.outcomes = const [true]]);
  @override
  Stream<Map<String, dynamic>> get messages => events.stream;
  @override
  bool get isConnected => connected;
  @override
  bool? get lastFailureRetryable => retryable;
  @override
  String? get lastError => connected ? null : '网络暂时不可用';
  @override
  String get nodeId => 'stable-node';
  @override
  Future<bool> connect(
    String serverUrl,
    String password, {
    String nodeName = 'local-node',
    bool serverRunning = true,
    int? slots,
    String? nodeId,
  }) async {
    connected =
        outcomes[attempts < outcomes.length ? attempts : outcomes.length - 1];
    attempts++;
    availability.add(serverRunning);
    if (connected) events.add({'type': 'connected', 'nodeId': 'stable-node'});
    return connected;
  }

  @override
  void sendStatusUpdate(String name, {bool serverRunning = true, int? slots}) {
    availability.add(serverRunning);
  }

  @override
  void setHardwareInfo(Map<String, dynamic> info) {
    hardwareReports.add(info);
  }

  void lose({bool canRetry = true}) {
    connected = false;
    retryable = canRetry;
    // The production bridge emits an error before closing its WebSocket.
    events.add({'type': 'error', 'message': '连接中断', 'retryable': canRetry});
  }

  @override
  void disconnect() {
    connected = false;
  }

  @override
  void dispose() {
    unawaited(events.close());
    super.dispose();
  }
}

Future<void> _mount(
  WidgetTester tester,
  _Connection connection,
  http.Client Function() client, {
  bool ready = true,
  Future<Map<String, dynamic>> Function()? hardwareInfoProvider,
}) async {
  SharedPreferences.setMockInitialValues({
    'cloud_url': 'https://gateway.test',
    'cloud_password': 'admin-password',
  });
  tester.view.physicalSize = const Size(1200, 1100);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    ft.FluentApp(
      home: CloudPage(
        connectionService: connection,
        httpClientFactory: client,
        hardwareInfoProvider: hardwareInfoProvider ?? _unknownHardware,
        serverReady: ready,
        modelName: 'local-model',
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'hardware is uploaded after connection without starting a model',
    (tester) async {
      final hardware = Completer<Map<String, dynamic>>();
      final connection = _Connection();
      var probes = 0;
      await _mount(
        tester,
        connection,
        () => MockClient(
          (request) async => http.Response(
            request.url.path.endsWith('/config') ? '{"mode":"personal"}' : '[]',
            200,
          ),
        ),
        ready: false,
        hardwareInfoProvider: () {
          probes++;
          return hardware.future;
        },
      );
      expect(probes, 0);
      await tester.tap(find.text('连接'));
      await tester.pumpAndSettle();
      expect(connection.connected, isTrue);
      expect(find.text('已连接，等待本地模型就绪'), findsOneWidget);
      expect(probes, 1);
      expect(connection.hardwareReports, isEmpty);
      hardware.complete({
        'os': 'windows',
        'arch': 'x64',
        'status': 'detected',
        'devices': [
          {
            'name': 'GPU from desktop',
            'backend': 'cuda',
            'totalMemoryMiB': 16384,
          },
        ],
        'source': 'nvidia-smi',
        'detectedAt': '2026-10-07T00:00:00.000Z',
      });
      await tester.pumpAndSettle();
      expect(connection.hardwareReports.single['status'], 'detected');
      expect(find.text('GPU from desktop · 16.0 GiB'), findsOneWidget);
      expect(connection.availability.last, false);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets('a disconnected desktop ignores a late hardware probe', (
    tester,
  ) async {
    final hardware = Completer<Map<String, dynamic>>();
    final connection = _Connection();
    await _mount(
      tester,
      connection,
      () => MockClient(
        (request) async => http.Response(
          request.url.path.endsWith('/config') ? '{"mode":"personal"}' : '[]',
          200,
        ),
      ),
      hardwareInfoProvider: () => hardware.future,
    );
    await tester.tap(find.text('连接'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('断开'));
    hardware.complete(await _unknownHardware());
    await tester.pumpAndSettle();
    expect(connection.hardwareReports, isEmpty);
    expect(find.text('已断开'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets('hardware failure reports unknown and can be refreshed', (
    tester,
  ) async {
    final connection = _Connection();
    var probes = 0;
    await _mount(
      tester,
      connection,
      () => MockClient(
        (request) async => http.Response(
          request.url.path.endsWith('/config') ? '{"mode":"personal"}' : '[]',
          200,
        ),
      ),
      hardwareInfoProvider: () async {
        probes++;
        if (probes == 1) throw StateError('Driver unavailable');
        return {...await _unknownHardware(), 'status': 'cpu_only'};
      },
    );
    await tester.tap(find.text('连接'));
    await tester.pumpAndSettle();
    expect(connection.hardwareReports.single['status'], 'unknown');
    expect(connection.connected, isTrue);
    expect(find.text('未能读取显卡信息，可检查驱动后刷新'), findsOneWidget);
    await tester.tap(find.text('刷新设备信息'));
    await tester.pumpAndSettle();
    expect(connection.hardwareReports.last['status'], 'cpu_only');
    expect(find.text('当前未检测到可用 GPU · CPU 模式'), findsOneWidget);
    expect(connection.attempts, 1);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });

  testWidgets(
    'cancelled connection-information import cannot refill credentials later',
    (tester) async {
      final clipboard = Completer<Object?>();
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.getData') return clipboard.future;
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final connection = _Connection();
      await _mount(
        tester,
        connection,
        () => MockClient(
          (request) async => http.Response('{"mode":"personal"}', 200),
        ),
      );
      await tester.tap(find.text('粘贴网页连接信息'));
      await tester.pump();
      await tester.tap(find.text('取消连接'));
      clipboard.complete({
        'text': jsonEncode({
          'version': 1,
          'serverUrl': 'https://unwanted.test',
          'mode': 'provider',
          'nodeName': 'Cancelled',
          'nodeToken': 'omm-relay-node-${List.filled(43, 'x').join()}',
        }),
      });
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ft.TextBox>(find.byKey(const ValueKey('cloud-server-url')))
            .controller!
            .text,
        'https://gateway.test',
      );
      expect(connection.attempts, 0);
      expect(find.text('已断开'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'a desktop can connect before model startup and reports readiness after startup',
    (tester) async {
      final connection = _Connection();
      http.Client client() => MockClient(
        (request) async => http.Response(
          request.url.path.endsWith('/config') ? '{"mode":"personal"}' : '[]',
          200,
        ),
      );
      await _mount(tester, connection, client, ready: false);
      await tester.tap(find.text('连接'));
      await tester.pumpAndSettle();
      expect(connection.attempts, 1);
      expect(connection.availability.last, false);
      expect(find.text('已连接，等待本地模型就绪'), findsOneWidget);
      await tester.pumpWidget(
        ft.FluentApp(
          home: CloudPage(
            connectionService: connection,
            httpClientFactory: client,
            hardwareInfoProvider: _unknownHardware,
            serverReady: true,
            modelName: 'local-model',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(connection.availability.last, true);
      expect(
        connection.attempts,
        1,
        reason: 'starting a model updates the live node without reconnecting',
      );
      expect(find.text('已连接，模型可用'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'web connection package fills a verified account-mode connection without starting it',
    (tester) async {
      final token = 'omm-relay-node-${List.filled(43, 'x').join()}';
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.getData')
            return {
              'text': jsonEncode({
                'version': 1,
                'serverUrl': 'https://new.test/prefix/admin',
                'mode': 'provider',
                'nodeName': 'My GPU',
                'nodeToken': token,
              }),
            };
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final paths = <String>[];
      final connection = _Connection();
      await _mount(
        tester,
        connection,
        () => MockClient((request) async {
          paths.add(request.url.path);
          return http.Response('{"mode":"provider"}', 200);
        }),
      );
      await tester.tap(find.text('粘贴网页连接信息'));
      await tester.pumpAndSettle();
      expect(paths.last, '/prefix/admin/api/public/config');
      expect(
        tester
            .widget<ft.TextBox>(find.byKey(const ValueKey('cloud-server-url')))
            .controller!
            .text,
        'https://new.test/prefix/admin',
      );
      expect(
        tester
            .widget<ft.TextBox>(find.byKey(const ValueKey('cloud-credential')))
            .controller!
            .text,
        token,
      );
      expect(find.textContaining('聚合算力 · 审批后接入'), findsOneWidget);
      expect(connection.attempts, 0);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'a permanent preflight failure stops recovery despite an older transient transport error',
    (tester) async {
      final connection = _Connection();
      var configurations = 0;
      await _mount(
        tester,
        connection,
        () => MockClient((request) async {
          if (!request.url.path.endsWith('/config'))
            return http.Response('[]', 200);
          configurations++;
          return configurations > 2
              ? http.Response('not found', 404)
              : http.Response('{"mode":"personal"}', 200);
        }),
      );
      await tester.tap(find.text('连接'));
      await tester.pumpAndSettle();
      connection.lose();
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 40));
      expect(connection.attempts, 1);
      expect(configurations, 3);
      expect(find.textContaining('第 2/5 次'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'preflight locks repeated clicks and cancellation prevents late connection',
    (tester) async {
      final connection = _Connection();
      final preflight = Completer<http.Response>();
      var requests = 0;
      await _mount(
        tester,
        connection,
        () => MockClient((request) async {
          requests++;
          if (requests == 1) return http.Response('{"mode":"personal"}', 200);
          return preflight.future;
        }),
      );
      final connect = tester.widget<ft.FilledButton>(
        find.ancestor(
          of: find.text('连接'),
          matching: find.byType(ft.FilledButton),
        ),
      );
      connect.onPressed!();
      connect.onPressed!();
      await tester.pump();
      expect(requests, 2);
      await tester.tap(find.text('取消连接'));
      preflight.complete(http.Response('{"mode":"personal"}', 200));
      await tester.pumpAndSettle();
      expect(connection.attempts, 0);
      expect(find.text('已断开'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'network recovery retries more than once and permission closure stops retrying',
    (tester) async {
      final connection = _Connection([true, false, true]);
      await _mount(
        tester,
        connection,
        () => MockClient(
          (request) async => http.Response(
            request.url.path.endsWith('/config') ? '{"mode":"personal"}' : '[]',
            200,
          ),
        ),
      );
      await tester.tap(find.text('连接'));
      await tester.pumpAndSettle();
      expect(connection.attempts, 1);
      connection.lose();
      await tester.pump();
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(connection.attempts, 2);
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      expect(connection.attempts, 3);
      expect(connection.connected, isTrue);
      connection.lose(canRetry: false);
      await tester.pump();
      await tester.pump(const Duration(seconds: 40));
      expect(connection.attempts, 3);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'changing servers clears prior credentials and ignores a stale config response',
    (tester) async {
      final connection = _Connection();
      final stale = Completer<http.Response>();
      await _mount(
        tester,
        connection,
        () => MockClient((request) async {
          if (request.url.host == 'slow.test') return stale.future;
          return http.Response('{"mode":"personal"}', 200);
        }),
      );
      expect(
        tester
            .widget<ft.TextBox>(find.byKey(const ValueKey('cloud-credential')))
            .controller!
            .text,
        'admin-password',
      );
      await tester.enterText(
        find.byKey(const ValueKey('cloud-server-url')),
        'https://slow.test',
      );
      await tester.pump(const Duration(milliseconds: 510));
      await tester.enterText(
        find.byKey(const ValueKey('cloud-server-url')),
        'https://new.test',
      );
      await tester.pump(const Duration(milliseconds: 510));
      await tester.pumpAndSettle();
      stale.complete(http.Response('temporary server failure', 503));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<ft.TextBox>(find.byKey(const ValueKey('cloud-credential')))
            .controller!
            .text,
        isEmpty,
      );
      expect(find.textContaining('个人 · 管理员密码'), findsOneWidget);
      expect(find.textContaining('无法读取服务器模式'), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    },
  );
}
