import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_picker/file_picker.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:window_manager/window_manager.dart';

import '../models/server_config.dart';
import '../services/inference_service.dart';
import '../services/local_file_service.dart';
import '../services/profile_store.dart';
import 'chat_page.dart';
import 'cloud_page.dart';

class HomePage extends StatefulWidget {
  final InferenceService? inference;
  final ProfileStore? profiles;
  final bool manageRuntime;
  const HomePage({
    super.key,
    this.inference,
    this.profiles,
    this.manageRuntime = true,
  });

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> with WindowListener {
  late final InferenceService _inference = widget.inference ?? InferenceService();
  late final bool _ownsInference = widget.inference == null;
  late final ProfileStore _profileStore = widget.profiles ?? ProfileStore();
  final GlobalKey<ChatPageState> _chatKey = GlobalKey<ChatPageState>();
  final GlobalKey<CloudPageState> _cloudKey = GlobalKey<CloudPageState>();
  final ScrollController _scrollCtrl = ScrollController();
  final TextEditingController tcFolder = TextEditingController();
  final TextEditingController tcModel = TextEditingController();
  final TextEditingController tcMmproj = TextEditingController();
  final TextEditingController tcProfile = TextEditingController();
  final TextEditingController tcExtraArgs = TextEditingController();
  final TextEditingController tcApiKey = TextEditingController();
  final Map<String, TextEditingController> _numCtrls = {};
  final Map<String, FocusNode> _numFocus = {};
  final Map<String, String> _numErrors = {};

  StreamSubscription<EngineRuntime>? _engineSub;
  List<Map<String, dynamic>> _files = [];
  List<Map<String, dynamic>> _profiles = [];
  ServerConfig _cfg = ServerConfig();
  bool _starting = false;
  bool _stopping = false;
  bool _closing = false;
  bool _showNodeApiKey = false;
  int _currentIndex = 0;
  int _scanGeneration = 0;

  @override
  void initState() {
    super.initState();
    _engineSub = _inference.onChange.listen((_) {
      if (mounted && !_closing) setState(() {});
    });
    if (widget.manageRuntime) {
      windowManager.addListener(this);
      windowManager.setPreventClose(true);
      unawaited(_initialize());
    }
  }

  Future<void> _initialize() async {
    await _loadPrefs();
    if (!mounted || _closing) return;
    await _inference.discoverEngines();
    await _refresh();
    if (!mounted || _closing) return;
    await _loadP();
  }

  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted || _closing) return;
    setState(() {
      tcFolder.text = prefs.getString('model_folder') ?? '';
    });
  }

  Future<void> _savePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('model_folder', tcFolder.text.trim());
  }

  Future<void> _refresh() async {
    final generation = ++_scanGeneration;
    final files = await LocalFileService.listFilesAsync(tcFolder.text.trim());
    if (mounted && !_closing && generation == _scanGeneration) {
      setState(() => _files = files);
    }
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
    _numErrors.clear();
    tcModel.text = config.modelPath;
    tcMmproj.text = config.mmprojPath;
    tcExtraArgs.text = config.extraArgs;
    tcApiKey.text = config.apiKey;
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
    if (_starting || _stopping || _closing) return;
    if (_inference.selectedEngine == null) {
      return _msg('未发现 llama-server 引擎，请检查安装目录');
    }
    if (tcModel.text.trim().isEmpty) return _msg('请选择模型');
    if (_numErrors.values.any((error) => error.isNotEmpty))
      return _msg('请先修正无效参数');
    setState(() => _starting = true);
    try {
      _cfg
        ..modelPath = tcModel.text.trim()
        ..mmprojPath = tcMmproj.text.trim()
        ..extraArgs = tcExtraArgs.text.trim()
        ..apiKey = tcApiKey.text.trim();
      await _inference.start(_cfg);
      await _savePrefs();
      if (mounted && _inference.isReady) _msg('模型已就绪', ok: true);
    } catch (error) {
      if (mounted) _msg('启动失败: $error');
    } finally {
      if (mounted && !_closing) setState(() => _starting = false);
    }
  }

  Future<void> _stop() async {
    if (_starting || _stopping || _closing) return;
    if (!_inference.runtime.isRunning) return;
    setState(() => _stopping = true);
    try {
      await _inference.stop();
    } catch (error) {
      if (mounted) _msg('停止失败: $error');
    } finally {
      if (mounted && !_closing) setState(() => _stopping = false);
    }
  }

  Future<void> _loadP() async {
    try {
      final profiles = await _profileStore.list();
      if (mounted && !_closing) setState(() => _profiles = profiles);
    } catch (_) {}
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
      ..modelPath = tcModel.text.trim()
      ..mmprojPath = tcMmproj.text.trim()
      ..extraArgs = tcExtraArgs.text.trim()
      ..apiKey = tcApiKey.text.trim();
    try {
      await _profileStore.save(name, _cfg);
      tcProfile.clear();
      await _loadP();
      if (mounted) _msg('档案已保存', ok: true);
    } on ProfileNameException catch (error) {
      if (mounted) _msg(error.message);
    } catch (error) {
      if (mounted) _msg('保存档案失败: $error');
    }
  }

  void _generateNodeApiKey() {
    final random = math.Random.secure();
    final bytes = List.generate(
      32,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    final value = 'sk-oom-node-$bytes';
    setState(() {
      tcApiKey.text = value;
      _cfg.apiKey = value;
      _showNodeApiKey = false;
    });
  }

  Future<void> _copyNodeApiKey() async {
    final value = tcApiKey.text.trim();
    if (value.isEmpty) return _msg('请先设置或生成节点 API Key');
    try {
      await Clipboard.setData(ClipboardData(text: value));
      if (mounted && !_closing) _msg('节点 API Key 已复制', ok: true);
    } catch (error) {
      if (mounted && !_closing) _msg('复制失败: $error');
    }
  }

  Future<void> _loadPf(String name) async {
    try {
      final config = await _profileStore.load(name);
      if (config == null) throw StateError('档案不存在或格式无效');
      if (!mounted) return;
      setState(() => _setConfig(config));
      _msg('档案已加载', ok: true);
    } on ProfileNameException catch (error) {
      if (mounted) _msg(error.message);
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
      if (!await _profileStore.delete(name)) throw StateError('删除失败');
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

  String _modelName(EngineRuntime runtime) {
    final path = _inference.runningConfig?.modelPath ?? runtime.modelPath;
    if (path.isEmpty) return '';
    return path.split(Platform.pathSeparator).last;
  }

  String get _status {
    final runtime = _inference.runtime;
    switch (runtime.state) {
      case EngineState.notFound:
        return '未发现 llama-server 引擎；请确认安装目录 runtime/llama 完整后重新启动应用';
      case EngineState.idle:
        return runtime.lastError.isNotEmpty
            ? runtime.lastError
            : (_inference.selectedEngine == null
                ? '选择模型后启动'
                : '引擎就绪：${_inference.selectedEngine!.label}');
      case EngineState.starting:
        return '正在启动 llama-server...';
      case EngineState.loading:
        return '模型加载中...';
      case EngineState.ready:
        final model = _modelName(runtime);
        return '运行中${model.isEmpty ? '' : ' - $model'}（端口 ${runtime.port}）';
      case EngineState.stopping:
        return '正在停止...';
      case EngineState.error:
        return runtime.lastError.isEmpty ? '引擎错误' : runtime.lastError;
    }
  }

  Color _statusColor(EngineRuntime runtime) {
    switch (runtime.state) {
      case EngineState.ready:
        return Colors.green;
      case EngineState.loading:
      case EngineState.starting:
      case EngineState.stopping:
        return Colors.orange;
      case EngineState.idle:
        return Colors.blue;
      case EngineState.error:
        return Colors.red;
      case EngineState.notFound:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final runtime = _inference.runtime;
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
    final host = (runtime.host.isEmpty || runtime.host == '0.0.0.0')
        ? '127.0.0.1'
        : runtime.host;
    final port = runtime.isRunning && runtime.port > 0
        ? runtime.port
        : _cfg.port;
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
          _page(models, mmprojs, runtime),
          ChatPage(key: _chatKey, inference: _inference),
          CloudPage(
            key: _cloudKey,
            llamaUrl: Uri(scheme: 'http', host: host, port: port).toString(),
            llamaApiKey: _inference.runningConfig?.apiKey ?? '',
            modelName: _modelName(runtime),
            serverRunning: runtime.isRunning,
            serverReady: runtime.state == EngineState.ready,
            slots: _inference.runningConfig?.slots,
          ),
        ],
      ),
    );
  }

  Widget _page(
    List<Map<String, dynamic>> models,
    List<Map<String, dynamic>> mmprojs,
    EngineRuntime runtime,
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
            '本地算力 / 云端共享 · 内置 llama.cpp ${runtime.engine?.tag ?? ''}',
            style: TextStyle(fontSize: 14, color: Colors.grey[600]),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: _statusColor(runtime),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      switch (runtime.state) {
                        EngineState.ready => '运行中',
                        EngineState.loading => '加载中',
                        EngineState.starting => '启动中',
                        EngineState.stopping => '停止中',
                        EngineState.error => '错误',
                        EngineState.notFound => '未发现引擎',
                        EngineState.idle => '未启动',
                      },
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
              if (runtime.isRunning || runtime.state == EngineState.stopping)
                ft.Button(
                  onPressed: _starting || _stopping || _closing ? null : _stop,
                  child: Text(_stopping ? '停止中…' : '停止'),
                )
              else
                ft.FilledButton(
                  onPressed: _starting || _stopping || _closing ? null : _start,
                  child: Text(_starting ? '启动中...' : '启动模型'),
                ),
            ],
          ),
          const SizedBox(height: 20),
          _lbl('推理引擎'),
          _inference.engines.length > 1
              ? ft.ComboBox<String>(
                  value: _inference.selectedEngine?.label,
                  items: _inference.engines
                      .map(
                        (engine) => ft.ComboBoxItem(
                          value: engine.label,
                          child: Text(engine.label),
                        ),
                      )
                      .toList(),
                  onChanged: (label) {
                    final match = _inference.engines
                        .where((engine) => engine.label == label);
                    if (match.isNotEmpty) {
                      _inference.selectEngine(match.first);
                      setState(() {});
                    }
                  },
                )
              : Text(
                  _inference.selectedEngine?.label ?? '未发现引擎',
                  style: const TextStyle(fontSize: 13),
                ),
          if ((_inference.selectedEngine?.versionSummary ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _inference.selectedEngine!.versionSummary,
                style: TextStyle(fontSize: 11, color: Colors.grey[500]),
              ),
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
              _lbl('mmproj (可选，多模态投影)'),
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
            content: _logsView(),
          ),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  Widget _logsView() {
    final logs = _inference.logs;
    if (logs.isEmpty) {
      return const SelectableText('暂无日志', style: TextStyle(fontSize: 12));
    }
    return SingleChildScrollView(
      reverse: true,
      child: SelectableText(
        logs.join('\n'),
        style: const TextStyle(fontSize: 12),
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
          '加载到 GPU 的层数：-1=全部，0=自动（引擎按显存自适应）',
          _cfg.nGpuLayers,
          (value) => _cfg.nGpuLayers = value.toInt(),
          min: -1,
        ),
        _num(
          '--ctx-size',
          '上下文长度',
          '0=使用模型元数据默认值，或指定如 32768',
          _cfg.contextSize,
          (value) => _cfg.contextSize = value.toInt(),
          min: 0,
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
          '同时处理的最大并发请求数，0=自动',
          _cfg.slots,
          (value) => _cfg.slots = value.toInt(),
          min: 0,
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
        const SizedBox(height: 8),
        _section('节点 API 安全'),
        const SizedBox(height: 4),
        SizedBox(
          width: 560,
          child: Text(
            '设置后，llama-server 将要求 Bearer API Key。云端管理端的对应节点路由也要填写同一密钥；直接访问节点时使用此密钥。修改后需重启模型生效。留空表示节点 HTTP 接口不启用密钥校验。',
            style: TextStyle(fontSize: 11, color: Colors.grey[600]),
          ),
        ),
        const SizedBox(height: 8),
        SizedBox(
          width: 560,
          child: ft.TextBox(
            controller: tcApiKey,
            obscureText: !_showNodeApiKey,
            placeholder: '节点保护密钥（留空则不启用）',
            onChanged: (value) => _cfg.apiKey = value,
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          children: [
            ft.Button(
              onPressed: _generateNodeApiKey,
              child: const Text('生成随机密钥'),
            ),
            ft.Button(onPressed: _copyNodeApiKey, child: const Text('复制密钥')),
            ft.Button(
              onPressed: () =>
                  setState(() => _showNodeApiKey = !_showNodeApiKey),
              child: Text(_showNodeApiKey ? '隐藏密钥' : '显示密钥'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        _section('缓存量化'),
        const SizedBox(height: 10),
        _choice(
          '--cache-type-k',
          'K 缓存量化',
          'Key 缓存的量化精度，引擎默认 f16',
          _cfg.cacheTypeK,
          {'f16', 'q8_0', 'q4_0', _cfg.cacheTypeK}.toList(),
          (value) => setState(() => _cfg.cacheTypeK = value),
        ),
        _choice(
          '--cache-type-v',
          'V 缓存量化',
          'Value 缓存的量化精度，引擎默认 f16',
          _cfg.cacheTypeV,
          {'f16', 'q8_0', 'q4_0', _cfg.cacheTypeV}.toList(),
          (value) => setState(() => _cfg.cacheTypeV = value),
        ),
        const SizedBox(height: 16),
        _section('功能开关'),
        const SizedBox(height: 10),
        _choice(
          '-fa',
          'Flash Attention',
          'auto=按硬件能力自动决定；on/off=强制开关',
          _cfg.flashAttnMode,
          const ['auto', 'on', 'off'],
          (value) => setState(() => _cfg.flashAttnMode = value),
        ),
        _choice(
          '-cb',
          '连续批处理',
          'auto=引擎默认开启；off=关闭动态批处理',
          _cfg.contBatchingMode,
          const ['auto', 'on', 'off'],
          (value) => setState(() => _cfg.contBatchingMode = value),
        ),
        _bool(
          '--embeddings',
          '嵌入模式',
          '仅用于嵌入模型：启用文本嵌入接口',
          _cfg.embeddings,
          (value) => setState(() => _cfg.embeddings = value),
        ),
        _bool(
          '--rerank',
          '重排模式',
          '启用 /v1/rerank 重排接口（需重排模型）',
          _cfg.reranking,
          (value) => setState(() => _cfg.reranking = value),
        ),
        _bool(
          '--metrics',
          '指标端点',
          '启用 Prometheus /metrics 监控端点',
          _cfg.enableMetrics,
          (value) => setState(() => _cfg.enableMetrics = value),
        ),
        _bool(
          '--mlock',
          '内存锁定（-lm mlock）',
          '锁定模型到物理内存，防止 swap 影响性能',
          _cfg.mlLock,
          (value) => setState(() => _cfg.mlLock = value),
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
                'KV 缓存保留在内存而非显存',
                _cfg.noKvOffload,
                (value) => setState(() => _cfg.noKvOffload = value),
              ),
              _bool(
                '--no-mmap',
                '禁用 mmap（-lm none）',
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
    });
    _cloudKey.currentState?.disconnectForShutdown();
    // 只终止本应用启动的引擎进程；未运行时 stop() 是快速无操作。
    try {
      await _inference.stop().timeout(const Duration(seconds: 10));
    } catch (_) {}
    await windowManager.destroy();
  }

  @override
  void dispose() {
    _closing = true;
    _engineSub?.cancel();
    windowManager.removeListener(this);
    for (final focus in _numFocus.values) focus.dispose();
    for (final controller in _numCtrls.values) controller.dispose();
    tcFolder.dispose();
    tcModel.dispose();
    tcMmproj.dispose();
    tcProfile.dispose();
    tcExtraArgs.dispose();
    tcApiKey.dispose();
    _scrollCtrl.dispose();
    if (_ownsInference) _inference.dispose();
    super.dispose();
  }
}
