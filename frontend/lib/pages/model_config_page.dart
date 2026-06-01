import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:file_picker/file_picker.dart';
import '../models/server_config.dart';
import '../services/python_bridge.dart';

/// 模型配置页 - 选择模型、mmproj、启动/停止

class ModelConfigPage extends StatefulWidget {
  final PythonBridge bridge;
  final String serverPath;

  const ModelConfigPage({super.key, required this.bridge, required this.serverPath});

  @override
  State<ModelConfigPage> createState() => _ModelConfigPageState();
}

class _ModelConfigPageState extends State<ModelConfigPage> {
  final TextEditingController _modelCtrl = TextEditingController();
  final TextEditingController _mmprojCtrl = TextEditingController();
  final TextEditingController _modelFolderCtrl = TextEditingController();

  List<Map<String, dynamic>> _files = [];
  bool _loading = false;
  bool _serverRunning = false;

  @override
  void initState() {
    super.initState();
    _modelFolderCtrl.text = "F:\\llama_cpp\\llama-b9253\\models";
    _refreshFiles();
  }

  Future<void> _pickFolder() async {
    final result = await FilePicker.platform.getDirectoryPath(dialogTitle: "选择模型文件夹");
    if (result != null) {
      setState(() => _modelFolderCtrl.text = result);
      _refreshFiles();
    }
  }

  Future<void> _refreshFiles() async {
    setState(() => _loading = true);
    try {
      final result = await widget.bridge.listFiles(_modelFolderCtrl.text);
      setState(() => _files = List<Map<String, dynamic>>.from(result["files"] ?? []));
    } catch (_) {}
    setState(() => _loading = false);
  }

  Future<void> _startServer() async {
    final config = ServerConfig(
      serverPath: widget.serverPath,
      modelPath: _modelCtrl.text,
      mmprojPath: _mmprojCtrl.text,
    );
    final ok = await widget.bridge.startServer(config);
    if (ok) {
      setState(() => _serverRunning = true);
      if (context.mounted) {
        ft.displayInfoBar(context, builder: (c, close) => ft.InfoBar(
          title: const Text("服务已启动"),
          severity: ft.InfoBarSeverity.success,
        ));
      }
    }
  }

  Future<void> _stopServer() async {
    await widget.bridge.stopServer();
    setState(() => _serverRunning = false);
  }

  @override
  Widget build(BuildContext context) {
    final models = _files.where((f) => f["name"].toString().endsWith(".gguf") && !f["name"].toString().startsWith("mmproj")).toList();
    final mmprojs = _files.where((f) => f["name"].toString().startsWith("mmproj")).toList();

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text("模型配置", style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 24),

        // 模型文件夹
        Row(children: [
          Expanded(child: ft.TextBox(controller: _modelFolderCtrl, placeholder: "模型文件夹路径")),
          const SizedBox(width: 8),
          ft.Button(onPressed: _pickFolder, child: const Text("浏览")),
          const SizedBox(width: 8),
          ft.Button(onPressed: _refreshFiles, child: const Text("刷新")),
        ]),
        const SizedBox(height: 16),

        // 模型列表
        const Text("模型文件", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        _loading
            ? const Center(child: ft.ProgressRing())
            : _files.isEmpty
                ? const Text("未找到模型文件，请选择正确的文件夹后点击刷新")
                : _buildFileGrid(models, _modelCtrl, "选择模型"),

        const SizedBox(height: 24),

        // mmproj 列表
        const Text("多模态投影文件 (mmproj)", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        const Text("如果有 mmproj 文件选择后模型将支持图片识别", style: TextStyle(fontSize: 12, color: Colors.grey)),
        const SizedBox(height: 8),
        _buildFileGrid(mmprojs, _mmprojCtrl, "选择 mmproj (可选)"),

        const SizedBox(height: 32),

        // 当前选中
        ft.Card(padding: const EdgeInsets.all(12), child: Column(children: [
          _infoRow("模型", _modelCtrl.text.isEmpty ? "未选择" : _modelCtrl.text.split("\\").last),
          _infoRow("mmproj", _mmprojCtrl.text.isEmpty ? "无" : _mmprojCtrl.text.split("\\").last),
        ])),

        const SizedBox(height: 16),

        // 启动按钮
        Row(children: [
          ft.FilledButton(
            onPressed: _serverRunning ? null : _startServer,
            child: const Text("🚀 启动 llama-server"),
          ),
          const SizedBox(width: 12),
          ft.Button(
            onPressed: _serverRunning ? _stopServer : null,
            child: const Text("停止"),
          ),
        ]),
      ]),
    );
  }

  Widget _buildFileGrid(List<Map<String, dynamic>> files, TextEditingController ctrl, String title) {
    if (files.isEmpty) return Text("无可用文件", style: TextStyle(color: Colors.grey[500]));
    return Wrap(spacing: 6, runSpacing: 6, children: files.map((f) {
      final name = f["name"] as String;
      final sizeMb = ((f["size"] ?? 0) / 1024 / 1024 / 1024).toStringAsFixed(1);
      final isSelected = ctrl.text == f["path"];
      return GestureDetector(
        onTap: () => setState(() => ctrl.text = f["path"] ?? ""),
        child: ft.Card(
          padding: const EdgeInsets.all(8),
          backgroundColor: isSelected ? const Color(0xFF00B7C3).withAlpha(30) : null,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, style: TextStyle(fontWeight: isSelected ? FontWeight.bold : FontWeight.normal)),
            Text("${sizeMb} GB", style: TextStyle(fontSize: 11, color: Colors.grey[500])),
          ]),
        ),
      );
    }).toList());
  }

  Widget _infoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [
        SizedBox(width: 80, child: Text("$label:", style: TextStyle(color: Colors.grey[400]))),
        Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w500))),
      ]),
    );
  }
}