import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:window_manager/window_manager.dart';
import 'pages/home_page.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  await windowManager.setMinimumSize(const Size(960, 640));
  await windowManager.setSize(const Size(1200, 800));
  await windowManager.center();
  await windowManager.setTitle("OpenMyModel");
  runApp(const OpenMyModelApp());
}

class OpenMyModelApp extends StatelessWidget {
  const OpenMyModelApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ft.FluentApp(
      title: "OpenMyModel",
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.light,
      theme: ft.FluentThemeData(
        brightness: Brightness.light,
        fontFamily: "SimSun",
        scaffoldBackgroundColor: const Color(0xFFF5F5F5),
        navigationPaneTheme: ft.NavigationPaneThemeData(
          backgroundColor: const Color(0xFFFAFAFA),
        ),
      ),
      home: HomePage(),
    );
  }
}