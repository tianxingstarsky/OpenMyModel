import 'dart:async';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:openmymodel/pages/home_page.dart';
import 'package:openmymodel/pages/chat_page.dart';
import 'package:openmymodel/pages/cloud_page.dart';
import 'package:openmymodel/services/python_bridge.dart';

class ChatFixture extends PythonBridge {
  final chunks = StreamController<String>();
  int cancellations = 0;
  @override
  Stream<String> chatStream(
    List<Map<String, dynamic>> messages, {
    double temp = 0.7,
  }) => chunks.stream;
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
    final fixture = ChatFixture();
    await tester.pumpWidget(
      ft.FluentApp(home: HomePage(manageRuntime: false, bridge: fixture)),
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
    fixture.chunks.add('{"choices":[{"delta":{"content":"partial reply"}}]}');
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
