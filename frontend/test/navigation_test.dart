import 'dart:async';
import 'dart:io';

import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/models/server_config.dart';
import 'package:openmymodel/pages/home_page.dart';
import 'package:openmymodel/pages/chat_page.dart';
import 'package:openmymodel/pages/cloud_page.dart';
import 'package:openmymodel/services/inference_service.dart';
import 'package:openmymodel/services/profile_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 页面接线测试用的固定就绪引擎；真实网络行为由 inference_service_test 覆盖。
class _ReadyEngineFixture extends InferenceService {
  final chunks = StreamController<Map<String, dynamic>>();
  int cancellations = 0;
  final engine = EngineInfo(
    directory: 'test-engine',
    executable: 'llama-server.exe',
    tag: 'b10909',
    backend: 'cpu',
  );

  @override
  bool get isReady => true;

  @override
  EngineRuntime get runtime => EngineRuntime(
        state: EngineState.ready,
        engine: engine,
        modelPath: 'test-model.gguf',
        port: 8080,
      );

  @override
  ServerConfig? get runningConfig => ServerConfig(modelPath: 'test-model.gguf');

  @override
  List<String> get logs =>
      const ['version: 0.4.0-dev (build 1, commit a2878d3)'];

  @override
  Stream<Map<String, dynamic>> chatStream(
    List<Map<String, dynamic>> messages, {
    double? temperature,
    int? maxTokens,
    Map<String, dynamic>? extra,
  }) =>
      chunks.stream;

  @override
  void cancelChat() {
    cancellations++;
    if (!chunks.isClosed) unawaited(chunks.close());
  }
}

void main() {
  testWidgets('Real Home navigation preserves chat and cloud state', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final fixture = _ReadyEngineFixture();
    await tester.pumpWidget(
      ft.FluentApp(
        home: HomePage(
          manageRuntime: false,
          inference: fixture,
          profiles: ProfileStore(dir: Directory.systemTemp.path),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final chatState = tester.state(find.byType(ChatPage, skipOffstage: false));
    final cloudState = tester.state(
      find.byType(CloudPage, skipOffstage: false),
    );
    final navigation = tester.widget<ft.NavigationView>(
      find.byType(ft.NavigationView),
    );
    navigation.pane!.onChanged!(1);
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byType(ChatPage),
        matching: find.byType(ft.TextBox),
      ),
      'hello',
    );
    await tester.tap(find.text('发送'));
    await tester.pump();
    fixture.chunks.add({
      'choices': [
        {'delta': {'content': 'partial reply'}}
      ],
    });
    await tester.pump();
    expect(find.text('partial reply'), findsOneWidget);
    tester
        .widget<ft.NavigationView>(find.byType(ft.NavigationView))
        .pane!
        .onChanged!(2);
    await tester.pumpAndSettle();
    tester
        .widget<ft.NavigationView>(find.byType(ft.NavigationView))
        .pane!
        .onChanged!(1);
    await tester.pumpAndSettle();
    expect(identical(chatState, tester.state(find.byType(ChatPage))), true);
    expect(
      identical(
        cloudState,
        tester.state(find.byType(CloudPage, skipOffstage: false)),
      ),
      true,
    );
    expect(find.text('partial reply'), findsOneWidget);
    await tester.tap(find.text('停止生成'));
    await tester.pumpAndSettle();
    expect(fixture.cancellations, 1);
    expect(find.text('partial reply'), findsOneWidget);
    expect(find.text('发送'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpAndSettle();
  });
}
