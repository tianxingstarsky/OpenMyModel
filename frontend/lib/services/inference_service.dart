/// 本地推理引擎服务：直接管理 llama-server (llama.cpp b10909) 子进程。
///
/// 取代旧 Python Bridge 的进程管理与本地聊天代理；聊天直接走引擎官方
/// OpenAI 兼容 API (/v1/chat/completions SSE)。只终止本服务启动的进程，
/// 不按端口或进程名查找和杀进程。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import '../models/server_config.dart';
import 'sse.dart';

class EngineException implements Exception {
  final String message;
  final int? exitCode;
  EngineException(this.message, [this.exitCode]);
  @override
  String toString() =>
      exitCode == null ? message : '$message (退出码 $exitCode)';
}

enum EngineState {
  /// 未发现可用的引擎二进制。
  notFound,

  /// 引擎可用但未运行。
  idle,

  /// 正在拉起进程或模型加载中。
  starting,

  /// /health 已响应但模型仍在加载。
  loading,

  /// /health 返回 ok，可以接受请求。
  ready,

  stopping,

  /// 进程崩溃、启动失败或加载超时。
  error,
}

/// 一个已发现的引擎二进制（来自 engine.json 或自定义路径）。
class EngineInfo {
  final String directory;
  final String executable;
  final String tag;
  final String backend;
  final String versionSummary;
  final bool bundled;

  EngineInfo({
    required this.directory,
    required this.executable,
    required this.tag,
    required this.backend,
    this.versionSummary = '',
    this.bundled = false,
  });

  String get label => 'llama.cpp $tag · ${backend.toUpperCase()}';
}

/// 引擎运行时快照，状态变化时通过 [InferenceService.onChange] 发出。
class EngineRuntime {
  final EngineState state;
  final EngineInfo? engine;
  final String? pid;
  final int? exitCode;
  final String modelPath;
  final String host;
  final int port;
  final DateTime? startedAt;
  final String lastError;
  final List<String> logTail;
  final Map<String, dynamic>? props;

  const EngineRuntime({
    this.state = EngineState.idle,
    this.engine,
    this.pid,
    this.exitCode,
    this.modelPath = '',
    this.host = '127.0.0.1',
    this.port = 8080,
    this.startedAt,
    this.lastError = '',
    this.logTail = const [],
    this.props,
  });

  EngineRuntime copyWith({
    EngineState? state,
    EngineInfo? engine,
    String? pid,
    int? exitCode,
    String? modelPath,
    String? host,
    int? port,
    DateTime? startedAt,
    String? lastError,
    List<String>? logTail,
    Map<String, dynamic>? props,
  }) => EngineRuntime(
        state: state ?? this.state,
        engine: engine ?? this.engine,
        pid: pid ?? this.pid,
        exitCode: exitCode ?? this.exitCode,
        modelPath: modelPath ?? this.modelPath,
        host: host ?? this.host,
        port: port ?? this.port,
        startedAt: startedAt ?? this.startedAt,
        lastError: lastError ?? this.lastError,
        logTail: logTail ?? this.logTail,
        props: props ?? this.props,
      );

  bool get isTransitioning =>
      state == EngineState.starting || state == EngineState.stopping;

  bool get isRunning =>
      state == EngineState.starting ||
      state == EngineState.loading ||
      state == EngineState.ready;

  Duration get uptime =>
      isRunning && startedAt != null ? DateTime.now().difference(startedAt!) : Duration.zero;

  /// /props 中报告的模型是否具备视觉输入能力。
  bool get supportsVision {
    final modalities = props?['modalities'];
    return modalities is Map && modalities['vision'] == true;
  }

  Map<String, dynamic> toStatusJson() => {
        'running': isRunning,
        'ready': state == EngineState.ready,
        'state': state.name,
        'port': port,
        'host': host,
        'model': modelPath.isEmpty ? '' : modelPath.split(Platform.pathSeparator).last,
        'pid': pid,
        'exit_code': exitCode,
        'uptime_seconds': uptime.inSeconds,
        'last_error': lastError,
        'engine_tag': engine?.tag ?? '',
        'engine_backend': engine?.backend ?? '',
        'log_tail': logTail,
      };
}

/// 进程抽象，便于测试注入假进程。
abstract class EngineProcess {
  int get pid;
  Stream<String> get stdoutText;
  Stream<String> get stderrText;
  Future<int> get exitCode;
  bool kill();
}

class RealEngineProcess implements EngineProcess {
  final Process _process;
  RealEngineProcess(this._process);

  @override
  int get pid => _process.pid;

  @override
  Stream<String> get stdoutText =>
      _process.stdout.transform(utf8.decoder).transform(const LineSplitter());

  @override
  Stream<String> get stderrText =>
      _process.stderr.transform(utf8.decoder).transform(const LineSplitter());

  @override
  Future<int> get exitCode => _process.exitCode;

  @override
  bool kill() => _process.kill(ProcessSignal.sigterm);
}

typedef EngineProcessFactory =
    Future<EngineProcess> Function(
      String executable,
      List<String> args, {
      String? workingDirectory,
    });

/// 探测引擎可用的计算设备：返回 `--list-devices` 的原始输出。
typedef DeviceProber = Future<String> Function(String executable);

Future<String> _probeDevicesDefault(String executable) async {
  final result = await Process.run(
    executable,
    ['--list-devices'],
    workingDirectory: File(executable).parent.path,
    stdoutEncoding: const Utf8Codec(allowMalformed: true),
    stderrEncoding: const Utf8Codec(allowMalformed: true),
  ).timeout(const Duration(seconds: 10));
  return '${result.stdout ?? ''}\n${result.stderr ?? ''}';
}

final RegExp _gpuDeviceLine = RegExp(r'^\s*(CUDA|Vulkan)\d*\s*:', multiLine: true);

class InferenceService {
  final http.Client Function() _clientFactory;
  final EngineProcessFactory _processFactory;
  final String? Function() _engineDirOverride;
  final DeviceProber _deviceProber;
  final Duration healthInterval;
  final Duration healthTimeout;

  final List<EngineInfo> engines = [];
  EngineInfo? selectedEngine;

  EngineRuntime _runtime = const EngineRuntime();
  final _changes = StreamController<EngineRuntime>.broadcast();

  EngineProcess? _process;
  StreamSubscription? _stdoutSub;
  StreamSubscription? _stderrSub;
  final List<String> _logs = [];
  final Map<String, Future<String>> _probeCache = {};
  bool _autoSelectedEngine = false;
  ServerConfig? _runningConfig;
  Directory? _apiKeyDirectory;
  bool _userStopping = false;
  Future<void>? _lifecycleLock;
  http.Client? _chatClient;
  bool _disposed = false;

  static const _maxLogLines = 500;
  static const _maxLineLength = 2000;

  InferenceService({
    http.Client Function()? clientFactory,
    EngineProcessFactory? processFactory,
    String? Function()? engineDirOverride,
    DeviceProber? deviceProber,
    this.healthInterval = const Duration(milliseconds: 400),
    this.healthTimeout = const Duration(minutes: 10),
  })  : _clientFactory = clientFactory ?? http.Client.new,
        _processFactory = processFactory ??
            ((exe, args, {workingDirectory}) async => RealEngineProcess(
                  await Process.start(exe, args, runInShell: false),
                )),
        _engineDirOverride = engineDirOverride ?? (() => null),
        _deviceProber = deviceProber ?? _probeDevicesDefault;

  EngineRuntime get runtime => _runtime;

  /// 当前运行中的配置（云端与首页展示用）；未运行时为 null。
  ServerConfig? get runningConfig => _runningConfig;

  /// 最近捕获的引擎日志（已脱敏）。
  List<String> get logs => List.unmodifiable(_logs);

  Stream<EngineRuntime> get onChange => _changes.stream;

  bool get isReady => _runtime.state == EngineState.ready;

  void _emit(EngineRuntime next) {
    _runtime = next;
    if (!_changes.isClosed) _changes.add(next);
  }

  // ---------- 引擎发现 ----------

  /// 扫描内置 runtime、开发目录和用户自定义目录，读出 engine.json 元数据。
  Future<void> discoverEngines() async {
    engines.clear();
    final candidates = <String>[];
    final override = _engineDirOverride();
    if (override != null && override.isNotEmpty) {
      candidates.add(override);
    }
    final exeDir = File(Platform.resolvedExecutable).parent;
    candidates.add('${exeDir.path}${Platform.pathSeparator}runtime${Platform.pathSeparator}llama');
    // 开发模式：从构建目录向上找仓库根的 artifacts/engine。
    Directory? probe = exeDir.parent;
    for (var i = 0; i < 6 && probe != null; i++) {
      candidates.add('${probe.path}${Platform.pathSeparator}artifacts${Platform.pathSeparator}engine');
      probe = probe.parent;
    }
    final seen = <String>{};
    for (final dir in candidates) {
      if (seen.contains(dir) || !Directory(dir).existsSync()) continue;
      seen.add(dir);
      for (final entity in Directory(dir).listSync(followLinks: false)) {
        if (entity is! Directory) continue;
        final info = _infoFromDirectory(entity.path);
        if (info != null) engines.add(info);
      }
    }
    engines.sort(_backendPriority);
    if (selectedEngine == null ||
        !engines.any((e) => e.executable == selectedEngine!.executable)) {
      // 先落到 CPU 基准（任何机器都能启动），随后按真实设备探测升级到
      // CUDA/Vulkan；没有对应硬件时不会误选（例如 A 卡机器不选 CUDA）。
      final cpu = engines
          .where((e) => e.backend.toLowerCase() == 'cpu')
          .toList();
      if (cpu.isNotEmpty || engines.isNotEmpty) {
        selectedEngine = cpu.isNotEmpty ? cpu.first : engines.last;
        _autoSelectedEngine = true;
        unawaited(_upgradeSelectionByDevices());
      } else {
        selectedEngine = null;
      }
    }
    _emit(_runtime.copyWith(
      engine: selectedEngine,
      state: selectedEngine == null ? EngineState.notFound : _runtime.state,
    ));
  }

  Future<void> _upgradeSelectionByDevices() async {
    if (_disposed || !_autoSelectedEngine) return;
    // 按优先级逐个探测非 CPU 引擎，命中第一个报告真实 GPU 的。
    final candidates = engines
        .where((e) => e.backend.toLowerCase() != 'cpu')
        .toList()
      ..sort(_backendPriority);
    for (final engine in candidates) {
      if (_disposed || !_autoSelectedEngine || _runtime.isRunning) return;
      String output;
      try {
        output = await _probeCache.putIfAbsent(engine.executable, () {
          return _deviceProber(engine.executable)
              .catchError((Object _) => '')
              .timeout(const Duration(seconds: 12), onTimeout: () => '');
        });
      } on Exception {
        continue;
      }
      if (_disposed || !_autoSelectedEngine) return;
      if (_gpuDeviceLine.hasMatch(output)) {
        selectedEngine = engine;
        _autoSelectedEngine = false;
        _emit(_runtime.copyWith(engine: engine, lastError: ''));
        return;
      }
    }
    // 没有任何 GPU 后端可用：保持 CPU。
    _autoSelectedEngine = false;
  }

  static int _backendPriority(EngineInfo a, EngineInfo b) {
    const order = ['cuda', 'vulkan', 'cpu'];
    int rank(EngineInfo e) {
      final i = order.indexOf(e.backend.toLowerCase());
      return i < 0 ? order.length : i;
    }

    return rank(a).compareTo(rank(b));
  }

  EngineInfo? _infoFromDirectory(String dir) {
    final exe = '$dir${Platform.pathSeparator}llama-server.exe';
    if (!File(exe).existsSync()) return null;
    final manifest = File('$dir${Platform.pathSeparator}engine.json');
    if (manifest.existsSync()) {
      try {
        final data = jsonDecode(manifest.readAsStringSync());
        if (data is Map) {
          return EngineInfo(
            directory: dir,
            executable: exe,
            tag: '${data['tag'] ?? '未知版本'}',
            backend: '${data['backend'] ?? 'unknown'}',
            versionSummary: (data['versionOutput'] ?? '').toString().split('\n').first,
            bundled: true,
          );
        }
      } catch (_) {
        // 损坏的 engine.json 仍按可用引擎处理，只是信息不完整。
      }
    }
    return EngineInfo(
      directory: dir,
      executable: exe,
      tag: '自定义',
      backend: 'unknown',
      bundled: false,
    );
  }

  void selectEngine(EngineInfo info) {
    if (_runtime.isRunning) {
      throw EngineException('引擎正在运行，请先停止模型后再切换');
    }
    selectedEngine = info;
    _autoSelectedEngine = false; // 用户显式选择优先于自动探测。
    _emit(_runtime.copyWith(engine: info, lastError: ''));
  }

  // ---------- 进程生命周期 ----------

  static bool _isLoopbackHost(String host) {
    var normalized = host.trim().toLowerCase();
    if (normalized.startsWith('[') && normalized.endsWith(']')) {
      normalized = normalized.substring(1, normalized.length - 1);
    }
    if (normalized == 'localhost' || normalized.endsWith('.localhost')) {
      return true;
    }
    return InternetAddress.tryParse(normalized)?.isLoopback ?? false;
  }

  Future<String?> _writeApiKeyFile(String apiKey) async {
    if (apiKey.isEmpty) return null;
    Directory? directory;
    try {
      directory = await Directory.systemTemp.createTemp('openmymodel-node-key-');
      if (Platform.isWindows) {
        final identity = await Process.run('whoami', ['/user', '/fo', 'csv', '/nh'], runInShell: false);
        final sid = RegExp(r'S-\d+(?:-\d+)+')
            .firstMatch('${identity.stdout}\n${identity.stderr}')?.group(0);
        if (identity.exitCode != 0 || sid == null) {
          throw EngineException('无法安全限制节点 API Key 临时文件的访问权限');
        }
        final acl = await Process.run('icacls', [
          directory.path, '/inheritance:r', '/grant:r', '*${sid}:(OI)(CI)F',
        ], runInShell: false);
        if (acl.exitCode != 0) {
          throw EngineException('无法安全限制节点 API Key 临时文件的访问权限');
        }
      }
      final file = File('${directory.path}${Platform.pathSeparator}api-key');
      await file.writeAsString('$apiKey\n', flush: true);
      _apiKeyDirectory = directory;
      return file.path;
    } catch (error) {
      if (directory != null && await directory.exists()) {
        try { await directory.delete(recursive: true); } catch (_) {}
      }
      if (error is EngineException) rethrow;
      throw EngineException('无法安全创建节点 API Key 临时文件: $error');
    }
  }

  Future<void> _deleteApiKeyFile() async {
    final directory = _apiKeyDirectory;
    if (directory == null) return;
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        if (await directory.exists()) await directory.delete(recursive: true);
        _apiKeyDirectory = null;
        return;
      } catch (_) {
        if (attempt < 4) await Future<void>.delayed(Duration(milliseconds: 50 * (attempt + 1)));
      }
    }
    throw EngineException('无法删除节点 API Key 临时文件；服务启动已中止以避免遗留密钥');
  }

  /// 校验并生成 llama-server 命令行参数（暴露用于测试）。
  static List<String> buildArgs(ServerConfig config, {String? apiKeyFile}) {
    if (config.modelPath.isEmpty) {
      throw EngineException('未选择模型文件');
    }
    final host = config.host.trim();
    if (host.isEmpty) {
      throw EngineException('服务地址不能为空');
    }
    final apiKey = config.apiKey.trim();
    if (!_isLoopbackHost(host) && apiKey.isEmpty) {
      throw EngineException('监听地址允许其他设备访问时必须设置节点 API Key');
    }
    final port = config.port;
    if (port < 1 || port > 65535) {
      throw EngineException('端口必须在 1-65535 之间');
    }
    final args = <String>[];
    args.addAll(['-m', config.modelPath]);
    if (config.mmprojPath.isNotEmpty) {
      args.addAll(['--mmproj', config.mmprojPath]);
    }
    // n_gpu_layers: -1 = all, 0 = auto（引擎默认）, >0 = 精确层数。
    final ngl = config.nGpuLayers;
    if (ngl < 0) {
      args.addAll(['-ngl', 'all']);
    } else if (ngl > 0) {
      args.addAll(['-ngl', '$ngl']);
    }
    if (config.contextSize > 0) args.addAll(['-c', '${config.contextSize}']);
    if (config.batchSize > 0) args.addAll(['-b', '${config.batchSize}']);
    if (config.ubatchSize > 0) args.addAll(['-ub', '${config.ubatchSize}']);
    if (config.threads > 0) args.addAll(['-t', '${config.threads}']);
    switch (config.flashAttnMode) {
      case 'on':
        args.addAll(['-fa', 'on']);
      case 'off':
        args.addAll(['-fa', 'off']);
    }
    if (config.cacheTypeK.isNotEmpty) args.addAll(['-ctk', config.cacheTypeK]);
    if (config.cacheTypeV.isNotEmpty) args.addAll(['-ctv', config.cacheTypeV]);
    if (config.slots > 0) args.addAll(['-np', '${config.slots}']);
    if (config.embeddings) args.add('--embeddings');
    if (config.reranking) args.add('--rerank');
    if (config.enableMetrics) args.add('--metrics');
    if (config.contBatchingMode == 'off') args.add('--no-cont-batching');
    if (config.contBatchingMode == 'on') args.add('--cont-batching');
    final noMmap = config.noMmap;
    final mlLock = config.mlLock;
    if (noMmap && mlLock) {
      args.addAll(['-lm', 'mmap+mlock']);
    } else if (noMmap) {
      args.addAll(['-lm', 'none']);
    } else if (mlLock) {
      args.addAll(['-lm', 'mlock']);
    }
    if (config.noKvOffload) args.add('--no-kv-offload');
    if (config.ropeFreqBase > 0) {
      args.addAll(['--rope-freq-base', '${config.ropeFreqBase}']);
    }
    if (config.ropeFreqScale > 0) {
      args.addAll(['--rope-freq-scale', '${config.ropeFreqScale}']);
    }
    if (config.yarnExtFactor > 0) {
      args.addAll(['--yarn-ext-factor', '${config.yarnExtFactor}']);
    }
    if (config.yarnAttnFactor > 0) {
      args.addAll(['--yarn-attn-factor', '${config.yarnAttnFactor}']);
    }
    // 干净的 API 模型名，云端/本地展示一致。
    final stem = config.modelPath
        .split(Platform.pathSeparator)
        .last
        .replaceAll(RegExp(r'\.gguf$', caseSensitive: false), '');
    if (stem.isNotEmpty) args.addAll(['-a', stem]);
    args.addAll(['--host', host]);
    args.addAll(['--port', '$port']);
    if (apiKey.isNotEmpty) {
      if (apiKeyFile == null) {
        args.addAll(['--api-key', apiKey]);
      } else {
        args.addAll(['--api-key-file', apiKeyFile]);
      }
    }
    if (config.extraArgs.trim().isNotEmpty) {
      final extra = splitCommandLine(config.extraArgs);
      for (final token in extra) {
        final name = token.split('=').first.trim();
        if (['--host', '--port', '--api-key', '--api-key-file'].contains(name)) {
          throw EngineException('请使用 host/port/api_key 配置项，不要在额外参数中覆盖服务地址或密钥');
        }
        args.add(token);
      }
    }
    return args;
  }

  /// 解析带双引号的参数串（Windows 风格，非 POSIX 转义）。
  static List<String> splitCommandLine(String input) {
    final result = <String>[];
    final buffer = StringBuffer();
    var inQuotes = false;
    var hasToken = false;
    for (var i = 0; i < input.length; i++) {
      final ch = input[i];
      if (ch == '"') {
        inQuotes = !inQuotes;
        hasToken = true;
      } else if (ch == ' ' && !inQuotes) {
        if (hasToken || buffer.isNotEmpty) {
          result.add(buffer.toString());
          buffer.clear();
          hasToken = false;
        }
      } else {
        buffer.write(ch);
      }
    }
    if (hasToken || buffer.isNotEmpty) result.add(buffer.toString());
    return result;
  }

  Uri _baseUri(ServerConfig config) {
    final host = (config.host == '0.0.0.0' || config.host.isEmpty)
        ? '127.0.0.1'
        : config.host;
    return Uri.parse('http://$host:${config.port}');
  }

  Map<String, String> _authHeaders(ServerConfig config) => {
        if (config.apiKey.trim().isNotEmpty)
          'Authorization': 'Bearer ${config.apiKey.trim()}',
      };

  Future<void> start(ServerConfig config) async {
    if (_disposed) throw EngineException('推理服务已关闭');
    final normalizedConfig = config.copy()
      ..host = config.host.trim()
      ..apiKey = config.apiKey.trim();
    while (_lifecycleLock != null) {
      await _lifecycleLock;
    }
    final existing = _runningConfig;
    if (_runtime.isRunning && existing != null && _sameConfig(existing, normalizedConfig)) {
      return; // 幂等：相同配置重复启动无副作用。
    }
    if (_runtime.isRunning) {
      throw EngineException('llama-server 已在运行；请先停止，再使用新配置启动');
    }
    final engine = selectedEngine;
    if (engine == null) {
      throw EngineException('未发现可用的 llama-server 引擎');
    }
    final completer = Completer<void>();
    _lifecycleLock = completer.future;
    try {
      await _startLocked(normalizedConfig, engine);
    } finally {
      _lifecycleLock = null;
      if (!completer.isCompleted) completer.complete();
    }
  }

  static bool _sameConfig(ServerConfig a, ServerConfig b) {
    // 额外参数里逗号/引号差异不大但进程参数不同；简单做 JSON 比较。
    return jsonEncode(a.toJson()) == jsonEncode(b.toJson());
  }

  Future<void> _startLocked(ServerConfig config, EngineInfo engine) async {
    buildArgs(config); // Validate before creating a secret file.
    final apiKeyFile = await _writeApiKeyFile(config.apiKey.trim());
    final args = buildArgs(config, apiKeyFile: apiKeyFile);
    _logs.clear();
    _userStopping = false;
    // 全新运行时快照，避免上一次运行的 props/exitCode 残留。
    _emit(EngineRuntime(
      state: EngineState.starting,
      engine: engine,
      modelPath: config.modelPath,
      host: config.host,
      port: config.port,
      startedAt: DateTime.now(),
      logTail: const [],
    ));
    try {
      final process = await _processFactory(engine.executable, args,
          workingDirectory: engine.directory);
      _process = process;
      _runningConfig = config;
      _emit(_runtime.copyWith(pid: '${process.pid}'));
      _stdoutSub = process.stdoutText.listen(_onLog);
      _stderrSub = process.stderrText.listen(_onLog);
      unawaited(process.exitCode.then(_onProcessExit));
    } catch (e) {
      _runningConfig = null;
      await _deleteApiKeyFile();
      _fail('启动 llama-server 失败: $e');
      throw EngineException(_runtime.lastError);
    }
    // 进程秒退检测（如缺 DLL、参数非法）。
    await Future<void>.delayed(const Duration(milliseconds: 150));
    if (!_runtime.isRunning) {
      final err = _runtime.lastError.isEmpty ? 'llama-server 启动后立即退出' : _runtime.lastError;
      await _deleteApiKeyFile();
      _fail(err);
      throw EngineException(err);
    }
    _emit(_runtime.copyWith(state: EngineState.loading));
    try {
      await _waitUntilHealthy(config, onListening: apiKeyFile == null ? null : _deleteApiKeyFile);
    } on EngineException {
      _runningConfig = null;
      await _killOwnedProcess();
      await _deleteApiKeyFile();
      rethrow;
    }
    final props = await _fetchPropsSafe(config);
    _emit(_runtime.copyWith(state: EngineState.ready, props: props, lastError: ''));
  }

  void _onLog(String line) {
    if (line.isEmpty) return;
    var text = line.length > _maxLineLength ? line.substring(0, _maxLineLength) : line;
    final key = _runningConfig?.apiKey;
    if (key != null && key.isNotEmpty) text = text.replaceAll(key, '[REDACTED]');
    _logs.add(text);
    if (_logs.length > _maxLogLines) _logs.removeRange(0, _logs.length - _maxLogLines);
  }

  void _onProcessExit(int code) {
    if (_userStopping || _disposed) return;
    if (_runtime.state == EngineState.ready ||
        _runtime.state == EngineState.loading ||
        _runtime.state == EngineState.starting) {
      final tail = _logs.take(5).join('\n');
      _runningConfig = null;
      _emit(_runtime.copyWith(
        state: EngineState.error,
        exitCode: code,
        lastError: 'llama-server 进程已退出 (退出码 $code)${tail.isEmpty ? '' : '\n$tail'}',
      ));
    } else {
      _emit(_runtime.copyWith(exitCode: code));
    }
  }

  Future<void> _waitUntilHealthy(ServerConfig config, {Future<void> Function()? onListening}) async {
    final deadline = DateTime.now().add(healthTimeout);
    final health = _baseUri(config).replace(path: '/health');
    Object? lastError;
    while (DateTime.now().isBefore(deadline)) {
      if (!_runtime.isRunning || _process == null) {
        throw EngineException(_runtime.lastError.isEmpty
            ? 'llama-server 在加载过程中退出'
            : _runtime.lastError);
      }
      final client = _clientFactory();
      try {
        final response = await client
            .get(health, headers: _authHeaders(config))
            .timeout(const Duration(seconds: 3));
        await onListening?.call();
        if (response.statusCode == 200) {
          return;
        }
        if (response.statusCode == 503) {
          _emit(_runtime.copyWith(state: EngineState.loading));
        } else {
          throw EngineException(
              'health 检查返回 HTTP ${response.statusCode}: ${response.body}');
        }
      } on EngineException {
        rethrow;
      } on TimeoutException {
        lastError = 'health 检查超时';
      } catch (e) {
        // 连接被拒绝 = 进程尚未监听，继续轮询。
        lastError = e;
      } finally {
        client.close();
      }
      await Future<void>.delayed(healthInterval);
    }
    throw EngineException('模型加载超时（>${healthTimeout.inSeconds} 秒）${lastError == null ? '' : '：$lastError'}');
  }

  Future<Map<String, dynamic>?> _fetchPropsSafe(ServerConfig config) async {
    final client = _clientFactory();
    try {
      final response = await client
          .get(_baseUri(config).replace(path: '/props'),
              headers: _authHeaders(config))
          .timeout(const Duration(seconds: 5));
      if (response.statusCode == 200) {
        final data = jsonDecode(utf8.decode(response.bodyBytes, allowMalformed: true));
        if (data is Map<String, dynamic>) return data;
      }
    } catch (_) {
      // /props 不可用不影响 ready 状态。
    } finally {
      client.close();
    }
    return null;
  }

  Future<void> stop() async {
    while (_lifecycleLock != null) {
      await _lifecycleLock;
    }
    final completer = Completer<void>();
    _lifecycleLock = completer.future;
    try {
      _userStopping = true;
      if (_runtime.isRunning || _process != null) {
        _emit(_runtime.copyWith(state: EngineState.stopping));
        await _killOwnedProcess();
      }
      _runningConfig = null;
      _emit(EngineRuntime(
        state: EngineState.idle,
        engine: selectedEngine,
        lastError: '',
      ));
    } finally {
      _lifecycleLock = null;
      if (!completer.isCompleted) completer.complete();
      _userStopping = false;
    }
  }

  Future<void> _killOwnedProcess() async {
    final process = _process;
    if (process == null) return;
    _process = null;
    process.kill();
    try {
      await process.exitCode.timeout(const Duration(seconds: 5));
    } on TimeoutException {
      // Windows 上 TerminateProcess 很少失败；再试一次后放弃等待。
      process.kill();
      await process.exitCode.timeout(const Duration(seconds: 3), onTimeout: () => -1);
    }
    await _stdoutSub?.cancel();
    await _stderrSub?.cancel();
    _stdoutSub = null;
    _stderrSub = null;
  }

  void _fail(String message) {
    _runningConfig = null;
    _emit(_runtime.copyWith(
      state: EngineState.error,
      lastError: message,
      logTail: List<String>.from(_logs.take(20)),
    ));
  }

  // ---------- HTTP API ----------

  /// OpenAI 兼容流式聊天，产出解析后的增量 JSON 块。
  Stream<Map<String, dynamic>> chatStream(
    List<Map<String, dynamic>> messages, {
    double? temperature,
    int? maxTokens,
    Map<String, dynamic>? extra,
  }) async* {
    final config = _runningConfig;
    if (config == null || !isReady) {
      throw EngineException('模型尚未就绪，请等待加载完成后再发送消息');
    }
    if (_chatClient != null) {
      throw EngineException('已有对话请求正在生成');
    }
    final client = _clientFactory();
    _chatClient = client;
    try {
      final body = <String, dynamic>{
        'messages': messages,
        'stream': true,
        'stream_options': {'include_usage': true},
        if (temperature != null) 'temperature': temperature,
        if (maxTokens != null) 'max_tokens': maxTokens,
        ...?extra,
      };
      final request = http.Request(
        'POST',
        _baseUri(config).replace(path: '/v1/chat/completions'),
      )
        ..headers['Content-Type'] = 'application/json'
        ..headers['Accept'] = 'text/event-stream'
        ..headers.addAll(_authHeaders(config))
        ..body = jsonEncode(body);
      final response = await client.send(request).timeout(const Duration(seconds: 60));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final bytes = await response.stream.bytesToString().timeout(const Duration(seconds: 10));
        String message = bytes;
        try {
          final decoded = jsonDecode(bytes);
          if (decoded is Map) {
            final error = decoded['error'];
            message = error is Map
                ? '${error['message'] ?? error}'
                : '${decoded['detail'] ?? decoded}';
          }
        } catch (_) {}
        throw EngineException(message, response.statusCode);
      }
      final contentType = response.headers['content-type'] ?? '';
      if (contentType.contains('application/json')) {
        // 非流式错误回落（例如服务器返回 JSON 错误对象）。
        final bytes = await response.stream.bytesToString();
        throw EngineException(bytes, response.statusCode);
      }
      await for (final event
          in decodeSse(response.stream.timeout(const Duration(seconds: 300)))) {
        try {
          final data = jsonDecode(event);
          if (data is Map<String, dynamic>) yield data;
        } catch (_) {
          // 跳过无法解析的片段。
        }
      }
    } finally {
      client.close();
      if (identical(_chatClient, client)) _chatClient = null;
    }
  }

  void cancelChat() => _chatClient?.close();

  Future<Map<String, dynamic>?> fetchProps() async {
    final config = _runningConfig;
    if (config == null || !isReady) return null;
    return _fetchPropsSafe(config);
  }

  /// 供云端 Node Bridge 同步的状态。
  Map<String, dynamic> statusForCloud() => _runtime.toStatusJson();

  void dispose() {
    _disposed = true;
    cancelChat();
    _userStopping = true;
    _process?.kill();
    _stdoutSub?.cancel();
    _stderrSub?.cancel();
    _changes.close();
  }
}
