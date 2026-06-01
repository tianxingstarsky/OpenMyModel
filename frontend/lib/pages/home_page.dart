import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:file_picker/file_picker.dart';
import '../services/python_bridge.dart';
import 'model_config_page.dart';
import 'params_config_page.dart';
import 'chat_page.dart';
import 'cloud_page.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  int _currentIndex = 0;
  final PythonBridge _bridge = PythonBridge();

  // 首页状态
  final TextEditingController _serverPathCtrl = TextEditingController();
  final TextEditingController _modelFolderCtrl = TextEditingController();
  String _serverStatus = "未启动";
  bool _isRunning = false;

  @override
  void initState() {
    super.initState();
    _checkStatus();
  }

  Future<void> _checkStatus() async {
    try {
      final status = await _bridge.getStatus();
      setState(() {
        _isRunning = status["running"] ?? false;
        _serverStatus = _isRunning ? "运行中 - ${status["model"]}" : "未启动";
      });
    } catch (_) {
      setState(() => _serverStatus = "桥接服务未连接");
    }
  }

  Future<void> _pickLlamaServer() async {
    final result = await FilePicker.platform.pickFiles(
      dialogTitle: "选择 llama-server.exe",
      allowedExtensions: ["exe"],
    );
    if (result != null && result.files.single.path != null) {
      setState(() => _serverPathCtrl.text = result.files.single.path!);
    }
  }

  Future<void> _pickModelFolder() async {
    final result = await FilePicker.platform.getDirectoryPath(
      dialogTitle: "选择模型文件夹",
    );
    if (result != null) {
      setState(() => _modelFolderCtrl.text = result);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ft.NavigationView(
      pane: ft.NavigationPane(
        selected: _currentIndex,
        onChanged: (i) => setState(() => _currentIndex = i),
        displayMode: ft.PaneDisplayMode.compact,
        items: [
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.home),
            title: const Text("首页"),
            body: _buildHomePage(),
          ),
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.settings),
            title: const Text("模型配置"),
            body: ModelConfigPage(bridge: _bridge, serverPath: _serverPathCtrl.text),
          ),
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.parameter),
            title: const Text("参数档案"),
            body: ParamsConfigPage(bridge: _bridge),
          ),
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.chat),
            title: const Text("对话"),
            body: ChatPage(bridge: _bridge),
          ),
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.cloud),
            title: const Text("云端连接"),
            body: CloudPage(),
          ),
        ],
      ),
    );
  }

  Widget _buildHomePage() {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 标题
          const Text("欢迎使用 OutMyModel", style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          Text("将本地 llama.cpp 算力共享到云端", style: TextStyle(fontSize: 14, color: Colors.grey[400])),
          const SizedBox(height: 32),

          // llama-server 路径
          _buildSection("llama-server 路径",
            "选择 llama-server.exe 的绝对路径"),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: ft.TextBox(controller: _serverPathCtrl, placeholder: "F:\\llama_cpp\\llama-b9253\\llama-server.exe")),
            const SizedBox(width: 8),
            ft.FilledButton(onPressed: _pickLlamaServer, child: const Text("浏览...")),
          ]),
          const SizedBox(height: 24),

          // 模型文件夹
          _buildSection("模型文件夹",
            "选择存放 .gguf 模型文件的目录"),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(child: ft.TextBox(controller: _modelFolderCtrl, placeholder: "F:\\llama_cpp\\llama-b9253\\models")),
            const SizedBox(width: 8),
            ft.FilledButton(onPressed: _pickModelFolder, child: const Text("浏览...")),
          ]),
          const SizedBox(height: 32),

          // 状态
          ft.Card(
            padding: const EdgeInsets.all(16),
            child: Row(children: [
              Icon(_isRunning ? Icons.check_circle : Icons.cancel, color: _isRunning ? Colors.green : Colors.grey),
              const SizedBox(width: 12),
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text("服务状态", style: TextStyle(fontWeight: FontWeight.w600)),
                Text(_serverStatus, style: TextStyle(color: Colors.grey[400], fontSize: 13)),
              ]),
              const Spacer(),
              ft.Button(
                onPressed: _checkStatus,
                child: const Text("刷新"),
              ),
            ]),
          ),
          const SizedBox(height: 16),

          // 快捷提示
          ft.InfoBar(
            title: const Text("快速开始"),
            content: const Text("1. 设置 llama-server 路径 → 2. 选择模型文件夹 → 3. 到「模型配置」页选择模型并启动 → 4. 在「对话」页测试"),
            severity: ft.InfoBarSeverity.info,
          ),
        ],
      ),
    );
  }

  Widget _buildSection(String title, String subtitle) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      const SizedBox(height: 2),
      Text(subtitle, style: TextStyle(fontSize: 12, color: Colors.grey[500])),
    ]);
  }
}
