import 'package:flutter/material.dart';

/// 插件接口
/// 所有插件必须实现此接口

abstract class OutMyPlugin {
  String get name;
  String get description;
  IconData get icon;

  /// 初始化插件
  Future<void> init();

  /// 获取插件设置页面
  Widget? get settingsPage;

  /// 获取插件主页内容
  Widget? get mainPage;
}