import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

import '../models/server_config.dart';
import '../services/local_file_service.dart';
import '../services/python_bridge.dart';
import 'chat_page.dart';
import 'cloud_page.dart';

class HomePage extends StatefulWidget {
  final PythonBridge? bridge;
  final bool manageRuntime;
  const HomePage({super.key, this.bridge, this.manageRuntime = true});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WindowListener {
  late final PythonBridge _bridge = widget.bridge ?? PythonBridge();
  final GlobalKey<ChatPageState> _chatKey = GlobalKey<ChatPageState>();
  final GlobalKey<CloudPageState> _cloudKey = GlobalKey<CloudPageState>();
  final ScrollController _scrollCtrl = ScrollController();
  final TextEditingController tcServer = TextEditingController();
  final TextEditingController tcFolder = TextEditingController();
  final TextEditingController tcModel = TextEditingController();
  final TextEditingController tcMmproj = TextEditingController();
  final TextEditingController tcProfile = TextEditingController();
  final TextEditingController tcExtraArgs = TextEditingController();
  final Map<String, TextEditingController> _numCtrls = {};
  final Map<String, FocusNode> _numFocus = {};
  final Map<String, String> _numErrors = {};

  Timer? _pollTimer;
  Process? _bridgeProcess;
  Future<void>? _checkInFlight;
  Future<void>? _restartInFlight;
  List<Map<String, dynamic>> _files = [];
  List<dynamic> _profiles = [];
  ServerConfig _cfg = ServerConfig();
  bool _running = false;
  bool _ready = false;
  bool _starting = false;
  bool _bridgeReady = false;
  bool _closing = false;
  int _currentIndex = 0;
  int _scanGeneration = 0;
  int _bridgeFailCount = 0;
  int _runtimePort = 0;
  String _runtimeModel = '';
  String _runtimeApiKey = '';
  String _status = '检查中...';
  String _logs = '';
  String _runtimeHost = '127.0.0.1';
  String _bridgeToken = '';
  String _bridgeId = '';

  @override
  void initState() {
    super.initState();
    if (widget.manageRuntime) {
      windowManager.addListener(this);
      windowManager.setPreventClose(true);
      unawaited(_initialize());
    }
  }

  Future<void> _initialize() async {
    await _loadPrefs();
    if (!mounted || _closing) return;
    await _refresh();
    if (!mounted || _closing) return;
    await _startBridge();
    if (!mounted || _closing) return;
    await _check();
    await _loadP();
    if (!mounted || _closing) return;
    _startPolling();
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted || _closing) return;
    setState(() {
      tcServer.text = prefs.getString('server_path') ?? '';
      tcFolder.text = prefs.getString('model_folder') ?? '';
    });
  }

  Future<void> _savePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_path', tcServer.text.trim());
    await prefs.setString('model_folder', tcFolder.text.trim());
  }

  String _newId(int length) {
    final random = Random.secure();
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return List.generate(
      length,
      (_) => chars[random.nextInt(chars.length)],
    ).join();
  }

  Iterable<String> _ancestorPaths(String path) sync* {
    var directory = Directory(path).absolute;
    for (var i = 0; i < 8; i++) {
      yield directory.path;
      final parent = directory.parent;
      if (parent.path == directory.path) break;
      directory = parent;
    }
  }

  String? _firstFile(Iterable<String> paths) {
    for (final path in paths) {
      if (File(path).existsSync()) return File(path).absolute.path;
    }
    return null;
  }

  Future<String?> _findPython() async {
    final executableDir = File(Platform.resolvedExecutable).parent.path;
    final roots = <String>{
      ..._ancestorPaths(executableDir),
      ..._ancestorPaths(Directory.current.path),
    };
    final bundled = _firstFile([
      '$executableDir/python/python.exe',
      for (final root in roots) '$root/python/python.exe',
      for (final root in roots) '$root/python/.venv/Scripts/python.exe',
      for (final root in roots) '$root/python/venv/Scripts/python.exe',
    ]);
    if (bundled != null) return bundled;
    for (final candidate in ['python', 'python3']) {
      try {
        final result = await Process.run(candidate, ['--version']);
        if (result.exitCode == 0) return candidate;
      } catch (_) {}
    }
    return null;
  }

  String? _findBridgeScript() {
    final executableDir = File(Platform.resolvedExecutable).parent.path;
    final roots = <String>{
      ..._ancestorPaths(executableDir),
      ..._ancestorPaths(Directory.current.path),
    };
    return _firstFile([
      '$executableDir/bridge_server.py',
      for (final root in roots) '$root/bridge_server.py',
      for (final root in roots) '$root/python/bridge_server.py',
    ]);
  }

  Future<void> _startBridge() async {
    if (_closing || _bridgeProcess != null) return;
    final python = await _findPython();
    final script = _findBridgeScript();
    if (_closing) return;
    if (python == null || script == null) {
      if (mounted) {
        setState(() {
          _bridgeReady = false;
          _status = '找不到 Python 或 bridge_server.py';
        });
      }
      return;
    }
    try {
      await _bridge.getStatus();
      if (mounted && !_closing)
        setState(() => _status = '8765 已被其他桥接占用，请先关闭另一份应用');
      return;
    } catch (_) {}
    if (!mounted || _closing) return;
    _bridgeToken = _newId(48);
    _bridgeId = _newId(24);
    try {
      final environment = Map<String, String>.from(Platform.environment)
        ..['OPENMYMODEL_BRIDGE_TOKEN'] = _bridgeToken
        ..['OPENMYMODEL_BRIDGE_ID'] = _bridgeId;
      final process = await Process.start(
        python,
        ['-u', script],
        workingDirectory: File(script).parent.path,
        environment: environment,
        runInShell: false,
      );
      if (_closing) {
        process.kill();
        return;
      }
      _bridgeProcess = process;
      process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) => _recordBridgeOutput(line, false));
      process.stderr
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen((line) => _recordBridgeOutput(line, true));
      unawaited(
        process.exitCode.then((code) {
          if (!identical(_bridgeProcess, process)) return;
          _bridgeProcess = null;
          if (mounted && !_closing) {
            setState(() {
              _bridgeReady = false;
              _status = '桥接服务已退出，等待重连 ($code)';
            });
          }
        }),
      );
      if (mounted) setState(() => _status = '桥接启动中...');
    } catch (error) {
      if (mounted) {
        setState(() {
          _bridgeReady = false;
          _status = '桥接启动失败: $error';
        });
      }
    }
  }

  void _recordBridgeOutput(String line, bool stderr) {
    if (!mounted || _closing) return;
    _logs = '$_logs$line\n';
    if (_logs.length > 12000) _logs = _logs.substring(_logs.length - 12000);
    if (!stderr) return;
    if (line.contains('Traceback') || line.contains('ModuleNotFoundError')) {
      setState(() => _status = '桥接错误: $line');
    }
  }

  Future<void> _check() {
    if (_closing || _starting) return Future<void>.value();
    final current = _checkInFlight;
    if (current != null) return current;
    final operation = _performCheck();
    _checkInFlight = operation;
    unawaited(
      operation.whenComplete(() {
        if (identical(_checkInFlight, operation)) _checkInFlight = null;
      }),
    );
    return operation;
  }

  Future<void> _performCheck() async {
    try {
      final status = await _bridge.getStatus();
      if (!mounted || _closing) return;
      final statusId = status['bridge_id']?.toString();
      final statusPid = int.tryParse(status['bridge_pid']?.toString() ?? '');
      final process = _bridgeProcess;
      final owned =
          statusId == _bridgeId &&
          statusPid != null &&
          process != null &&
          (statusPid == process.pid ||
              status['bridge_parent_pid'] == process.pid);
      if (!owned) {
        setState(() {
          _bridgeReady = false;
          _ready = false;
          _running = false;
          _status = process == null ? '已有未归属的桥接服务，未接管' : '桥接身份不匹配，未接管';
        });
        return;
      }
      _bridgeFailCount = 0;
      final running = status['running'] == true;
      final ready = status['ready'] == true;
      final port = int.tryParse(status['port']?.toString() ?? '') ?? 0;
      final model = status['model']?.toString() ?? '';
      final becameReady = !_bridgeReady;
      setState(() {
        _bridgeReady = true;
        if (status['log_tail'] is List &&
            (status['log_tail'] as List).isNotEmpty)
          _logs = (status['log_tail'] as List).join('\n');
        _running = running;
        _ready = ready;
        if (running) {
          _runtimePort = port;
          _runtimeModel = model;
          _runtimeHost = status['host']?.toString() ?? '127.0.0.1';
          if (_runtimeHost == '0.0.0.0' || _runtimeHost.isEmpty)
            _runtimeHost = '127.0.0.1';
          if (_runtimeHost == '::') _runtimeHost = '::1';
          _status = ready ? '运行中 - $model' : '模型加载中...';
        } else {
          _runtimePort = 0;
          _runtimeModel = '';
          _runtimeApiKey = '';
          _status = status['last_error']?.toString().isNotEmpty == true
              ? status['last_error'].toString()
              : '已就绪，选择模型后启动';
        }
      });
      if (becameReady) await _loadP();
    } catch (_) {
      if (!mounted || _closing) return;
      _bridgeFailCount++;
      setState(() {
        _bridgeReady = false;
        _running = false;
        _ready = false;
        _status = '桥接未就绪，自动重连中...';
      });
      if (_bridgeFailCount >= 3 && _restartInFlight == null) {
        _restartInFlight = _restartBridge();
        try {
          await _restartInFlight;
        } finally {
          _restartInFlight = null;
        }
      }
    }
  }

  Future<void> _restartBridge() async {
    if (_closing || !mounted) return;
    if (_bridgeProcess != null) {
      setState(() => _status = '桥接暂时不可达，请重试；为保护运行中的模型不会强制结束进程');
      return;
    }
    _bridgeFailCount = 0;
    await _startBridge();
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) => _check());
  }

  Future<void> _loadP() async {
    if (!_bridgeReady) return;
    try {
      final profiles = await _bridge.listProfiles();
      if (mounted && !_closing) setState(() => _profiles = profiles);
    } catch (_) {}
  }

  Future<void> _refresh() async {
    final generation = ++_scanGeneration;
    final files = await LocalFileService.listFilesAsync(tcFolder.text.trim());
    if (mounted && !_closing && generation == _scanGeneration) {
      setState(() => _files = files);
    }
  }

  Future<void> _pickS() async {
    final result = await FilePicker.platform.pickFiles(
      dialogTitle: 'llama-server.exe',
      allowedExtensions: ['exe'],
      type: FileType.custom,
    );
    if (!mounted || result?.files.single.path == null) return;
    setState(() => tcServer.text = result!.files.single.path!);
    await _savePrefs();
  }

  Future<void> _pickF() async {
    final path = await FilePicker.platform.getDirectoryPath(
      dialogTitle: '模型文件夹',
    );
    if (!mounted || path == null) return;
    setState(() => tcFolder.text = path);
    await _refresh();
    await _savePrefs();
  }

  void _setConfig(ServerConfig config) {
    _cfg = config;
    tcServer.text = config.serverPath;
    _numErrors.clear();
    tcModel.text = config.modelPath;
    tcMmproj.text = config.mmprojPath;
    tcExtraArgs.text = config.extraArgs;
    for (final entry in _numCtrls.entries) {
      final value = _numberValue(entry.key, config);
      if (value != null) entry.value.text = value.toString();
    }
  }

  num? _numberValue(String flag, ServerConfig config) {
    switch (flag) {
      case '--n-gpu-layers':
        return config.nGpuLayers;
      case '--ctx-size':
        return config.contextSize;
      case '--batch-size':
        return config.batchSize;
      case '--ubatch-size':
        return config.ubatchSize;
      case '--threads':
        return config.threads;
      case '--parallel':
        return config.slots;
      case '--port':
        return config.port;
      case '--rope-freq-base':
        return config.ropeFreqBase;
      case '--rope-freq-scale':
        return config.ropeFreqScale;
      case '--yarn-ext-factor':
        return config.yarnExtFactor;
      case '--yarn-attn-factor':
        return config.yarnAttnFactor;
    }
    return null;
  }

  Future<void> _start() async {
    if (_starting) return;
    if (tcServer.text.trim().isEmpty) return _msg('请设置 llama-server.exe 路径');
    if (tcModel.text.trim().isEmpty) return _msg('请选模型');
    if (!_bridgeReady) return _msg('桥接服务未就绪，请稍候');
    if (_numErrors.values.any((error) => error.isNotEmpty))
      return _msg('请先修正无效参数');
    setState(() => _starting = true);
    try {
      _cfg
        ..serverPath = tcServer.text.trim()
        ..modelPath = tcModel.text.trim()
        ..mmprojPath = tcMmproj.text.trim()
        ..extraArgs = tcExtraArgs.text.trim();
      final identity = await _bridge.getStatus();
      if (identity['bridge_id'] != _bridgeId ||
          (identity['bridge_pid'] != _bridgeProcess?.pid &&
              identity['bridge_parent_pid'] != _bridgeProcess?.pid))
        throw StateError('桥接身份不匹配');
      await _bridge.startServer(_cfg);
      _runtimeApiKey = _cfg.apiKey;
      await _savePrefs();
      await _performCheck();
      if (mounted && _ready) _msg('已启动', ok: true);
    } catch (error) {
      if (mounted) _msg('启动失败: $error');
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _stop() async {
    if (!_running || _starting) return;
    setState(() => _starting = true);
    try {
      final identity = await _bridge.getStatus();
      if (identity['bridge_id'] != _bridgeId ||
          (identity['bridge_pid'] != _bridgeProcess?.pid &&
              identity['bridge_parent_pid'] != _bridgeProcess?.pid))
        throw StateError('桥接身份不匹配');
      _bridge.cancelChat();
      await _bridge.stopServer();
      await _performCheck();
    } catch (error) {
      if (mounted) _msg('停止失败: $error');
    } finally {
      if (mounted && !_closing) setState(() => _starting = false);
    }
  }

  Future<void> _savePf() async {
    final name = tcProfile.text.trim();
    if (name.isEmpty) return _msg('请输入档案名');
    if (_numErrors.values.any((error) => error.isNotEmpty))
      return _msg('请先修正无效参数');
    if (_profiles.any((p) => p['name'] == name)) {
      final confirmed = await ft.showDialog<bool>(
        context: context,
        builder: (context) => ft.ContentDialog(
          title: Text('覆盖档案“$name”？'),
          actions: [
            ft.Button(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            ft.FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('覆盖'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }
    _cfg
      ..serverPath = tcServer.text.trim()
      ..modelPath = tcModel.text.trim()
      ..mmprojPath = tcMmproj.text.trim()
      ..extraArgs = tcExtraArgs.text.trim();
    try {
      if (!await _bridge.saveProfile(name, _cfg)) throw StateError('保存失败');
      tcProfile.clear();
      await _loadP();
      if (mounted) _msg('档案已保存', ok: true);
    } catch (error) {
      if (mounted) _msg('保存档案失败: $error');
    }
  }

  Future<void> _loadPf(String name) async {
    try {
      final config = await _bridge.loadProfile(name);
      if (config == null) throw StateError('档案不存在或格式无效');
      if (!mounted) return;
      setState(() => _setConfig(config));
      _msg('档案已加载', ok: true);
    } catch (error) {
      if (mounted) _msg('加载档案失败: $error');
    }
  }

  Future<void> _deleteProfile(String name) async {
    final confirmed = await ft.showDialog<bool>(
      context: context,
      builder: (dialogContext) => ft.ContentDialog(
        title: const Text('删除配置档案'),
        content: Text('确定删除“$name”吗？此操作无法撤销。'),
        actions: [
          ft.Button(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('取消'),
          ),
          ft.FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || _closing) return;
    try {
      if (!await _bridge.deleteProfile(name)) throw StateError('删除失败');
      await _loadP();
      if (mounted) _msg('档案已删除', ok: true);
    } catch (error) {
      if (mounted) _msg('删除档案失败: $error');
    }
  }

  void _msg(String message, {bool ok = false}) {
    if (!mounted || _closing) return;
    ft.displayInfoBar(
      context,
      builder: (_, close) => ft.InfoBar(
        title: Text(message),
        severity: ok ? ft.InfoBarSeverity.success : ft.InfoBarSeverity.warning,
        onClose: close,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final models = _files
        .where(
          (file) => !file['name'].toString().toLowerCase().startsWith('mmproj'),
        )
        .toList();
    final mmprojs = _files
        .where(
          (file) => file['name'].toString().toLowerCase().startsWith('mmproj'),
        )
        .toList();
    return ft.NavigationView(
      pane: ft.NavigationPane(
        selected: _currentIndex,
        onChanged: (index) => setState(() => _currentIndex = index),
        displayMode: ft.PaneDisplayMode.compact,
        items: [
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.home),
            title: const Text('首页'),
            body: const SizedBox(),
          ),
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.chat),
            title: const Text('对话'),
            body: const SizedBox(),
          ),
          ft.PaneItem(
            icon: const Icon(ft.FluentIcons.cloud),
            title: const Text('云端连接'),
            body: const SizedBox(),
          ),
        ],
      ),
      paneBodyBuilder: (_, __) => IndexedStack(
        index: _currentIndex,
        children: [
          _page(models, mmprojs),
          ChatPage(key: _chatKey, bridge: _bridge),
          CloudPage(
            key: _cloudKey,
            llamaUrl: Uri(
              scheme: 'http',
              host: _runtimeHost,
              port: _runtimePort > 0 ? _runtimePort : _cfg.port,
            ).toString(),
            llamaApiKey: _runtimeApiKey,
            modelName: _runtimeModel,
            serverRunning: _running,
            serverReady: _ready,
          ),
        ],
      ),
    );
  }

  Widget _page(
    List<Map<String, dynamic>> models,
    List<Map<String, dynamic>> mmprojs,
  ) {
    return SingleChildScrollView(
      controller: _scrollCtrl,
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'OpenMyModel',
            style: TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
          ),
          Text(
            '本地算力 / 云端共享',
            style: TextStyle(fontSize: 14, color: Colors.grey[600]),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: _ready
                      ? Colors.green
                      : _running
                      ? Colors.orange
                      : _bridgeReady
                      ? Colors.blue
                      : Colors.grey,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _ready
                          ? '运行中'
                          : _running
                          ? '加载中'
                          : '未启动',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    Text(
                      _status,
                      style: TextStyle(fontSize: 12, color: Colors.grey[500]),
                    ),
                  ],
                ),
              ),
              if (!_bridgeReady)
                ft.Button(
                  onPressed: _closing ? null : _check,
                  child: const Text('重试桥接'),
                )
              else if (_running)
                ft.Button(
                  onPressed: _starting || _closing ? null : _stop,
                  child: Text(_starting ? '停止中…' : '停止'),
                )
              else
                ft.FilledButton(
                  onPressed: _starting || _closing ? null : _start,
                  child: Text(_starting ? '启动中...' : '启动 llama-server'),
                ),
            ],
          ),
          const SizedBox(height: 20),
          _lbl('llama-server.exe'),
          Row(
            children: [
              Expanded(
                child: ft.TextBox(controller: tcServer, placeholder: '选择 exe'),
              ),
              const SizedBox(width: 8),
              ft.Button(onPressed: _pickS, child: const Text('浏览')),
            ],
          ),
          const SizedBox(height: 14),
          _lbl('模型文件夹'),
          Row(
            children: [
              Expanded(
                child: ft.TextBox(
                  controller: tcFolder,
                  placeholder: '选择模型文件夹',
                  onChanged: (_) => _refresh(),
                ),
              ),
              const SizedBox(width: 8),
              ft.Button(onPressed: _pickF, child: const Text('浏览')),
            ],
          ),
          const SizedBox(height: 14),
          _lbl('模型'),
          _grid(models, tcModel),
          const SizedBox(height: 8),
          Row(
            children: [
              _lbl('mmproj (可选)'),
              ft.HyperlinkButton(
                onPressed: () => setState(() => tcMmproj.clear()),
                child: const Text('清除'),
              ),
            ],
          ),
          _grid(mmprojs, tcMmproj),
          const SizedBox(height: 16),
          ft.Expander(
            header: const Text(
              '推理参数',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
            ),
            content: _params(),
          ),
          const SizedBox(height: 8),
          ft.Expander(
            header: const Text(
              '配置档案',
              style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
            ),
            content: _profs(),
          ),
          const SizedBox(height: 8),
          ft.Expander(
            header: const Text('运行日志'),
            content: SelectableText(
              _logs.isEmpty ? '暂无日志' : _logs,
              style: const TextStyle(fontSize: 12),
            ),
          ),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  Widget _lbl(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: Text(
      text,
      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
    ),
  );

  Widget _grid(
    List<Map<String, dynamic>> files,
    TextEditingController controller,
  ) {
    if (files.isEmpty)
      return Text(
        '暂无',
        style: TextStyle(color: Colors.grey[400], fontSize: 12),
      );
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: files.map((file) {
        final name = file['name'] as String;
        final size = ((file['size'] ?? 0) / 1024 / 1024 / 1024).toStringAsFixed(
          1,
        );
        final selected = controller.text == file['path'];
        return GestureDetector(
          onTap: () => setState(() => controller.text = file['path'] ?? ''),
          child: ft.Card(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            backgroundColor: selected
                ? const Color(0xFF0078D4).withAlpha(20)
                : null,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: selected ? FontWeight.bold : FontWeight.normal,
                  ),
                ),
                Text(
                  '$size GB',
                  style: TextStyle(fontSize: 10, color: Colors.grey[500]),
                ),
              ],
            ),
          ),
        );
      }).toList(),
    );
  }

  Widget _params() => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _section('核心参数'),
        const SizedBox(height: 10),
        _num(
          '--n-gpu-layers',
          'GPU 层数',
          '加载到 GPU 的模型层数，-1=全部加载到显存',
          _cfg.nGpuLayers,
          (value) => _cfg.nGpuLayers = value.toInt(),
          min: -1,
        ),
        _num(
          '--ctx-size',
          '上下文长度',
          '模型最大上下文窗口，如 32768/128000',
          _cfg.contextSize,
          (value) => _cfg.contextSize = value.toInt(),
          min: 1,
        ),
        _num(
          '--batch-size',
          '批处理大小',
          '并行处理的 token 数量，影响吞吐量',
          _cfg.batchSize,
          (value) => _cfg.batchSize = value.toInt(),
          min: 1,
        ),
        _num(
          '--ubatch-size',
          '微批处理',
          '单次推理的最小批次，一般为 batch/4',
          _cfg.ubatchSize,
          (value) => _cfg.ubatchSize = value.toInt(),
          min: 1,
        ),
        _num(
          '--threads',
          'CPU 线程数',
          '推理使用的 CPU 线程，0=自动检测',
          _cfg.threads,
          (value) => _cfg.threads = value.toInt(),
          min: 0,
        ),
        _num(
          '--parallel',
          '并行槽位',
          '同时处理的最大并发请求数',
          _cfg.slots,
          (value) => _cfg.slots = value.toInt(),
          min: 1,
        ),
        _num(
          '--port',
          '服务端口',
          'llama-server HTTP 监听端口',
          _cfg.port,
          (value) => _cfg.port = value.toInt(),
          min: 1,
          max: 65535,
        ),
        const SizedBox(height: 16),
        _section('缓存量化'),
        const SizedBox(height: 10),
        _choice(
          '--cache-type-k',
          'K 缓存量化',
          'Key 缓存的量化精度，q8_0 推荐',
          _cfg.cacheTypeK,
          {'f16', 'q8_0', 'q4_0', _cfg.cacheTypeK}.toList(),
          (value) => setState(() => _cfg.cacheTypeK = value),
        ),
        _choice(
          '--cache-type-v',
          'V 缓存量化',
          'Value 缓存的量化精度，q8_0 推荐',
          _cfg.cacheTypeV,
          {'f16', 'q8_0', 'q4_0', _cfg.cacheTypeV}.toList(),
          (value) => setState(() => _cfg.cacheTypeV = value),
        ),
        const SizedBox(height: 16),
        _section('功能开关'),
        const SizedBox(height: 10),
        _bool(
          '--flash-attn',
          'Flash Attention',
          '启用 FA 加速推理，减少显存占用',
          _cfg.flashAttn,
          (value) => setState(() => _cfg.flashAttn = value),
        ),
        _bool(
          '--mlock',
          '内存锁定',
          '锁定模型到物理内存，防止 swap 影响性能',
          _cfg.mlLock,
          (value) => setState(() => _cfg.mlLock = value),
        ),
        _bool(
          '--cont-batching',
          '连续批处理',
          '动态合并请求，提高吞吐量',
          _cfg.contBatching,
          (value) => setState(() => _cfg.contBatching = value),
        ),
        _bool(
          '--embeddings',
          '嵌入模式',
          '启用文本嵌入提取功能',
          _cfg.embeddings,
          (value) => setState(() => _cfg.embeddings = value),
        ),
        const SizedBox(height: 8),
        ft.Expander(
          header: Text(
            '高级参数',
            style: TextStyle(fontSize: 12, color: Colors.grey[600]),
          ),
          content: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 10),
              _num(
                '--rope-freq-base',
                'RoPE 基础频率',
                '位置编码基准频率，0=自动',
                _cfg.ropeFreqBase,
                (value) => _cfg.ropeFreqBase = value.toDouble(),
                decimal: true,
                min: 0,
              ),
              _num(
                '--rope-freq-scale',
                'RoPE 缩放',
                '位置编码缩放因子，用于扩展上下文',
                _cfg.ropeFreqScale,
                (value) => _cfg.ropeFreqScale = value.toDouble(),
                decimal: true,
                min: 0,
              ),
              _num(
                '--yarn-ext-factor',
                'YaRN 扩展因子',
                'NTK 感知外推的扩展系数',
                _cfg.yarnExtFactor,
                (value) => _cfg.yarnExtFactor = value.toDouble(),
                decimal: true,
                min: 0,
              ),
              _num(
                '--yarn-attn-factor',
                'YaRN 注意力因子',
                '注意力分配的缩放比例',
                _cfg.yarnAttnFactor,
                (value) => _cfg.yarnAttnFactor = value.toDouble(),
                decimal: true,
                min: 0,
              ),
              _bool(
                '--no-kv-offload',
                '禁用 KV 卸载',
                '强制 KV 缓存留在显存',
                _cfg.noKvOffload,
                (value) => setState(() => _cfg.noKvOffload = value),
              ),
              _bool(
                '--no-mmap',
                '禁用 mmap',
                '不使用内存映射加载模型',
                _cfg.noMmap,
                (value) => setState(() => _cfg.noMmap = value),
              ),
              const SizedBox(height: 8),
              _section('额外启动参数'),
              const SizedBox(height: 6),
              SizedBox(
                width: 400,
                child: ft.TextBox(
                  controller: tcExtraArgs,
                  placeholder: '其他 llama-server 命令行参数',
                  onChanged: (value) => _cfg.extraArgs = value,
                ),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _num(
    String flag,
    String name,
    String desc,
    num value,
    void Function(num) onChanged, {
    bool decimal = false,
    num? min,
    num? max,
  }) {
    final controller = _numCtrls.putIfAbsent(
      flag,
      () => TextEditingController(text: value.toString()),
    );
    final focus = _numFocus.putIfAbsent(flag, FocusNode.new);
    final error = _numErrors[flag];
    final formatter = TextInputFormatter.withFunction((oldValue, newValue) {
      final pattern = decimal ? RegExp(r'^-?\d*\.?\d*$') : RegExp(r'^-?\d*$');
      return pattern.hasMatch(newValue.text) ? newValue : oldValue;
    });
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: SizedBox(
        width: 380,
        child: ft.Card(
          padding: const EdgeInsets.all(10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(
                    flag,
                    style: const TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: Color(0xFF0078D4),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    name,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                desc,
                style: TextStyle(fontSize: 11, color: Colors.grey[600]),
              ),
              const SizedBox(height: 6),
              SizedBox(
                width: 200,
                child: ft.TextBox(
                  controller: controller,
                  focusNode: focus,
                  inputFormatters: [formatter],
                  onChanged: (text) {
                    final parsed = decimal
                        ? double.tryParse(text)
                        : int.tryParse(text);
                    String? message;
                    if (parsed == null || !parsed.isFinite) message = '请输入有效数字';
                    if (parsed != null && min != null && parsed < min)
                      message = '最小值为 $min';
                    if (parsed != null && max != null && parsed > max)
                      message = '最大值为 $max';
                    setState(() {
                      _numErrors[flag] = message ?? '';
                      if (message == null && parsed != null) onChanged(parsed);
                    });
                  },
                  onEditingComplete: () {
                    if (controller.text.isEmpty ||
                        num.tryParse(controller.text) == null)
                      setState(() => _numErrors[flag] = '请输入有效数字');
                  },
                ),
              ),
              if (error != null && error.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    error,
                    style: const TextStyle(fontSize: 11, color: Colors.red),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _choice(
    String flag,
    String name,
    String desc,
    String value,
    List<String> options,
    void Function(String) onChanged,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: SizedBox(
      width: 380,
      child: ft.Card(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  flag,
                  style: const TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: Color(0xFF0078D4),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(desc, style: TextStyle(fontSize: 11, color: Colors.grey[600])),
            const SizedBox(height: 6),
            SizedBox(
              width: 200,
              child: ft.ComboBox(
                value: value,
                items: options
                    .map(
                      (option) =>
                          ft.ComboBoxItem(value: option, child: Text(option)),
                    )
                    .toList(),
                onChanged: (next) {
                  if (next != null) onChanged(next);
                },
              ),
            ),
          ],
        ),
      ),
    ),
  );

  Widget _bool(
    String flag,
    String name,
    String desc,
    bool value,
    void Function(bool) onChanged,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 10),
    child: SizedBox(
      width: 380,
      child: ft.Card(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Text(
                  flag,
                  style: const TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: Color(0xFF0078D4),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  name,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 8),
                ft.ToggleSwitch(checked: value, onChanged: onChanged),
              ],
            ),
            Text(desc, style: TextStyle(fontSize: 11, color: Colors.grey[600])),
          ],
        ),
      ),
    ),
  );

  Widget _section(String text) => Text(
    text,
    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
  );

  Widget _profs() => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_profiles.isNotEmpty)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: _profiles.map((profile) {
              final name = profile['name']?.toString() ?? '';
              return ft.Card(
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 4,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    GestureDetector(
                      onTap: () => _loadPf(name),
                      child: Text(
                        name,
                        style: const TextStyle(fontWeight: FontWeight.w500),
                      ),
                    ),
                    const SizedBox(width: 6),
                    ft.IconButton(
                      icon: const Icon(ft.FluentIcons.chrome_close, size: 14),
                      onPressed: () => _deleteProfile(name),
                    ),
                  ],
                ),
              );
            }).toList(),
          ),
        const SizedBox(height: 8),
        Row(
          children: [
            SizedBox(
              width: 150,
              child: ft.TextBox(controller: tcProfile, placeholder: '档案名'),
            ),
            const SizedBox(width: 8),
            ft.Button(onPressed: _savePf, child: const Text('保存')),
          ],
        ),
      ],
    ),
  );

  @override
  Future<void> onWindowClose() async {
    if (_closing) return;
    setState(() {
      _closing = true;
      _status = '正在关闭模型和桥接…';
    });
    _pollTimer?.cancel();
    _bridge.cancelChat();
    _cloudKey.currentState?.disconnectForShutdown();
    final process = _bridgeProcess;
    if (process != null) {
      try {
        final status = await _bridge.getStatus();
        if (status['bridge_id'] == _bridgeId &&
            (status['bridge_pid'] == process.pid ||
                status['bridge_parent_pid'] == process.pid)) {
          await _bridge.shutdownBridge(_bridgeToken);
        }
        await process.exitCode.timeout(const Duration(seconds: 15));
      } catch (_) {
        try {
          await process.exitCode.timeout(const Duration(milliseconds: 100));
        } catch (_) {
          if (mounted)
            setState(() {
              _closing = false;
              _status = '桥接未能安全关闭，请停止模型后重试。未强制结束运行中的进程。';
            });
          _cloudKey.currentState?.resumeAfterCancelledShutdown();
          _startPolling();
          return;
        }
      }
    }
    await windowManager.destroy();
  }

  @override
  void dispose() {
    _closing = true;
    _pollTimer?.cancel();
    windowManager.removeListener(this);
    for (final focus in _numFocus.values) focus.dispose();
    for (final controller in _numCtrls.values) controller.dispose();
    tcServer.dispose();
    tcFolder.dispose();
    tcModel.dispose();
    tcMmproj.dispose();
    tcProfile.dispose();
    tcExtraArgs.dispose();
    _scrollCtrl.dispose();
    _bridge.dispose();
    super.dispose();
  }
}
