import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:window_manager/window_manager.dart';
import 'pages/home_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  await windowManager.setMinimumSize(const Size(960, 640));
  await windowManager.setSize(const Size(1200, 800));
  await windowManager.center();
  await windowManager.setTitle("OutMyModel");
  runApp(const OutMyModelApp());
}

class OutMyModelApp extends StatelessWidget {
  const OutMyModelApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ft.FluentApp(
      title: "OutMyModel",
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: ft.FluentThemeData.dark().copyWith(
        
        scaffoldBackgroundColor: const Color(0xFF1A1A2E),
        navigationPaneTheme: ft.NavigationPaneThemeData(
          backgroundColor: const Color(0xFF16213E),
        ),
      ),
      home: const HomePage(),
    );
  }
}