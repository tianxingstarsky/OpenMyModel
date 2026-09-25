import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/models/server_config.dart';
import 'package:openmymodel/services/inference_service.dart';

class _ScriptedProcess implements EngineProcess {
  final stdoutLines = StreamController<String>.broadcast();
  final _exit = Completer<int>();
  int kills = 0;

  @override
  int get pid => 1234;

  @override
  Stream<String> get stdoutText => stdoutLines.stream;

  @override
  Stream<String> get stderrText => const Stream<String>.empty();

  @override
  Future<int> get exitCode => _exit.future;

  @override
  bool kill() {
    kills++;
    if (!_exit.isCompleted) _exit.complete(0);
    return true;
  }
}

class _HealthServer {
  HttpServer? _server;
  int healthHits = 0;
  int loadingHits = 0;
  String? lastHealthAuthorization;
  Map<String, String>? lastChatHeaders;
  String? lastChatBody;

  Future<Uri> start({bool loadingFirst = false}) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    server.listen((request) async {
      if (request.uri.path == '/health') {
        healthHits++;
        lastHealthAuthorization = request.headers.value('authorization') ?? '';
        if (loadingFirst && healthHits == 1) {
          loadingHits++;
          request.response.statusCode = 503;
          request.response.write('{"error":{"message":"Loading model"}}');
          await request.response.close();
        } else {
          request.response.write('{"status":"ok"}');
          await request.response.close();
        }
      } else if (request.uri.path == '/props') {
        request.response.write(
          '{"modalities":{"vision":true},"model":{"path":"m.gguf"}}',
        );
        await request.response.close();
      } else if (request.uri.path == '/v1/chat/completions') {
        lastChatHeaders = {
          'authorization': request.headers.value('authorization') ?? '',
          'content-type': request.headers.value('content-type') ?? '',
        };
        lastChatBody = await utf8.decoder.bind(request).join();
        request.response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        request.response.write(
          'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'
          'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n'
          'data: [DONE]\n\n',
        );
        await request.response.flush();
        await request.response.close();
      } else {
        request.response.statusCode = 404;
        await request.response.close();
      }
    });
    return Uri.parse('http://127.0.0.1:${server.port}');
  }

  Future<void> close() async {
    await _server?.close(force: true);
  }
}

final EngineInfo _engineOf = EngineInfo(
  directory: 'test',
  executable: 'llama-server.exe',
  tag: 'b10909',
  backend: 'cpu',
);

InferenceService _serviceWith(
  _ScriptedProcess process,
  Uri base, {
  Future<void> Function(List<String>)? onStart,
}) {
  final service = InferenceService(
    processFactory: (exe, args, {workingDirectory}) async {
      await onStart?.call(args);
      return process;
    },
    engineDirOverride: () => '',
    healthInterval: const Duration(milliseconds: 10),
  );
  service.engines.add(_engineOf);
  service.selectEngine(_engineOf);
  return service;
}

void main() {
  group('buildArgs (llama.cpp b10909 命令行)', () {
    test('默认配置依赖引擎默认值（auto ngl、上下文取模型默认）', () {
      final args = InferenceService.buildArgs(
        ServerConfig(modelPath: r'C:\models\demo.gguf'),
      );
      expect(args, isNot(contains('-ngl')));
      expect(args, isNot(contains('-c')));
      expect(args, containsAll(['-m', r'C:\models\demo.gguf']));
      expect(args, containsAll(['--host', '127.0.0.1']));
      expect(args, containsAll(['--port', '8080']));
      // 模型名别名来自文件名。
      final aliasIndex = args.indexOf('-a');
      expect(args[aliasIndex + 1], 'demo');
    });

    test('ngl 全部/精确映射与加载模式组合', () {
      expect(
        InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', nGpuLayers: -1, mlLock: true),
        ),
        containsAllInOrder(['-ngl', 'all', '-lm', 'mlock']),
      );
      expect(
        InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', nGpuLayers: 24, noMmap: true),
        ),
        containsAllInOrder(['-ngl', '24', '-lm', 'none']),
      );
      expect(
        InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', mlLock: true, noMmap: true),
        ),
        containsAllInOrder(['-lm', 'mmap+mlock']),
      );
    });

    test('flash attention 与连续批处理三态', () {
      expect(
        InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', flashAttnMode: 'on'),
        ),
        containsAllInOrder(['-fa', 'on']),
      );
      final off = InferenceService.buildArgs(
        ServerConfig(
          modelPath: 'm.gguf',
          flashAttnMode: 'off',
          contBatchingMode: 'off',
        ),
      );
      expect(off, containsAllInOrder(['-fa', 'off']));
      expect(off, contains('--no-cont-batching'));
      expect(
        InferenceService.buildArgs(ServerConfig(modelPath: 'm.gguf')),
        isNot(contains('-fa')),
      );
    });

    test('额外参数禁止覆盖服务地址与密钥', () {
      expect(
        () => InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', extraArgs: '--port 9'),
        ),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', extraArgs: '--api-key=x'),
        ),
        throwsA(isA<EngineException>()),
      );
      // 带引号的合法参数允许透传。
      final args = InferenceService.buildArgs(
        ServerConfig(modelPath: 'm.gguf', extraArgs: '"--some-flag" value'),
      );
      expect(args, containsAll(['--some-flag', 'value']));
    });

    test('缺失模型或非法端口被拒绝', () {
      expect(
        () => InferenceService.buildArgs(ServerConfig()),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', port: 70000),
        ),
        throwsA(isA<EngineException>()),
      );
    });

    test('非回环监听地址必须配置节点 API Key', () {
      expect(
        () => InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', host: '0.0.0.0'),
        ),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => InferenceService.buildArgs(
          ServerConfig(modelPath: 'm.gguf', host: '192.168.1.20'),
        ),
        throwsA(isA<EngineException>()),
      );

      for (final host in ['localhost', '127.0.0.2', '::1', '[::1]']) {
        expect(
          InferenceService.buildArgs(
            ServerConfig(modelPath: 'm.gguf', host: host),
          ),
          containsAll(['--host', host]),
          reason:
              '$host is a loopback listener and does not need a network key',
        );
      }

      final protected = InferenceService.buildArgs(
        ServerConfig(
          modelPath: 'm.gguf',
          host: '0.0.0.0',
          apiKey: ' node-secret ',
        ),
      );
      expect(
        protected,
        containsAll(['--host', '0.0.0.0', '--api-key', 'node-secret']),
      );
      final protectedByFile = InferenceService.buildArgs(
        ServerConfig(
          modelPath: 'm.gguf',
          host: '0.0.0.0',
          apiKey: 'node-secret',
        ),
        apiKeyFile: r'C:\private\api-key',
      );
      expect(
        protectedByFile,
        containsAll(['--api-key-file', r'C:\private\api-key']),
      );
      expect(protectedByFile, isNot(contains('node-secret')));
    });
  });

  group('buildVllmArgs (Linux NVIDIA Docker)', () {
    test('uses protected loopback port, model alias and validated limits', () {
      final args = InferenceService.buildVllmArgs(
        ServerConfig(
          modelPath: 'Qwen/Qwen3-8B',
          servedModelName: 'chat-balanced',
          apiKey: 'sk-omm-node-0123456789abcdef',
          port: 8090,
          contextSize: 32768,
          slots: 4,
        ),
        envFile: '/tmp/private-env',
        containerName: 'openmymodel-vllm-test',
      );
      expect(
        args,
        containsAllInOrder([
          'run',
          '--rm',
          '--init',
          '--name',
          'openmymodel-vllm-test',
          '--gpus',
          'all',
          '--ipc=host',
          '--publish',
          '127.0.0.1:8090:8000',
          '--env-file',
          '/tmp/private-env',
          'vllm/vllm-openai:v0.30.0',
          '--model',
          'Qwen/Qwen3-8B',
          '--served-model-name',
          'chat-balanced',
          '--host',
          '0.0.0.0',
          '--port',
          '8000',
          '--max-model-len',
          '32768',
          '--max-num-seqs',
          '4',
        ]),
      );
      expect(args.join(' '), isNot(contains('sk-omm-node-0123456789abcdef')));
    });

    test('mounts an existing local model directory read-only', () async {
      final model = await Directory.systemTemp.createTemp('omm-local-model-');
      addTearDown(() => model.delete(recursive: true));
      final args = InferenceService.buildVllmArgs(
        ServerConfig(
          modelPath: model.path,
          apiKey: 'sk-omm-node-0123456789abcdef',
        ),
        envFile: '/tmp/private-env',
        containerName: 'openmymodel-vllm-local-test',
      );
      expect(
        args,
        containsAll([
          '--volume',
          '${model.absolute.path}:/openmymodel-model:ro',
          '--model',
          '/openmymodel-model',
        ]),
      );
    });

    test('rejects missing or unsafe node credentials, images and ports', () {
      ServerConfig valid() => ServerConfig(
        modelPath: 'Qwen/Qwen3-8B',
        apiKey: 'sk-omm-node-0123456789abcdef',
      );
      List<String> build(ServerConfig config) => InferenceService.buildVllmArgs(
        config,
        envFile: '/tmp/private-env',
        containerName: 'openmymodel-vllm-invalid-test',
      );

      expect(
        () => build(valid()..apiKey = ''),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => build(valid()..apiKey = 'short'),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => build(valid()..hfToken = 'hf_token\nINJECTED=x'),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => build(valid()..vllmImage = 'attacker/image:latest'),
        throwsA(isA<EngineException>()),
      );
      expect(
        () => build(valid()..port = 70000),
        throwsA(isA<EngineException>()),
      );
    });
  });

  test('启动状态机：starting → loading → ready，健康探测携带 API Key', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start();
    addTearDown(health.close);
    final service = _serviceWith(process, base);
    addTearDown(service.dispose);
    final states = <EngineState>[];
    final sub = service.onChange.listen((runtime) => states.add(runtime.state));
    addTearDown(sub.cancel);

    await service.start(
      ServerConfig(modelPath: 'm.gguf', port: base.port, apiKey: 'sk-secret'),
    );
    await Future<void>.delayed(Duration.zero); // 广播流事件投递需要一次微任务调度。
    expect(service.isReady, true);
    expect(states, contains(EngineState.starting));
    expect(states, contains(EngineState.loading));
    expect(states.last, EngineState.ready);
    // props 已被读取，视觉能力来自 /props。
    expect(service.runtime.supportsVision, true);
    // 幂等重启：相同配置不重新拉起进程。
    final pidBefore = service.runtime.pid;
    await service.start(
      ServerConfig(modelPath: 'm.gguf', port: base.port, apiKey: 'sk-secret'),
    );
    expect(service.runtime.pid, pidBefore);
  });

  test('启动时通过受限临时文件传递节点 API Key，不放入进程参数', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start(loadingFirst: true);
    addTearDown(health.close);
    String? keyFilePath;
    String? keyFileContents;
    List<String>? startedArgs;
    final service = _serviceWith(
      process,
      base,
      onStart: (args) async {
        startedArgs = List<String>.from(args);
        final fileFlag = args.indexOf('--api-key-file');
        expect(fileFlag, greaterThanOrEqualTo(0));
        keyFilePath = args[fileFlag + 1];
        keyFileContents = await File(keyFilePath!).readAsString();
      },
    );
    addTearDown(service.dispose);

    await service.start(
      ServerConfig(
        modelPath: 'm.gguf',
        port: base.port,
        apiKey: 'sk-node-secret',
      ),
    );
    expect(startedArgs, isNotNull);
    expect(startedArgs, isNot(contains('sk-node-secret')));
    expect(startedArgs!.join(' '), isNot(contains('sk-node-secret')));
    expect(keyFileContents, 'sk-node-secret\n');
    expect(health.loadingHits, 1);
    expect(health.lastHealthAuthorization, 'Bearer sk-node-secret');
    expect(
      await File(keyFilePath!).exists(),
      isFalse,
      reason:
          'the secret file is removed as soon as llama-server accepts HTTP requests',
    );
  });

  test('日志脱敏 API Key，模型别名随启动写入命令行', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start();
    addTearDown(health.close);
    final service = _serviceWith(process, base);
    addTearDown(service.dispose);
    await service.start(
      ServerConfig(modelPath: 'm.gguf', port: base.port, apiKey: 'sk-secret'),
    );
    process.stdoutLines.add('using api key sk-secret on port ${base.port}');
    await Future<void>.delayed(Duration.zero);
    expect(service.logs.join('\n'), isNot(contains('sk-secret')));
    expect(service.logs.join('\n'), contains('[REDACTED]'));
  });

  test('崩溃检测：ready 后进程退出进入 error', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start();
    addTearDown(health.close);
    final service = _serviceWith(process, base);
    addTearDown(service.dispose);
    await service.start(ServerConfig(modelPath: 'm.gguf', port: base.port));
    expect(service.isReady, true);
    process.kill(); // 模拟外部崩溃。
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(service.runtime.state, EngineState.error);
    expect(service.runtime.exitCode, 0);
  });

  test('stop 终止自有进程并回到 idle', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start();
    addTearDown(health.close);
    final service = _serviceWith(process, base);
    addTearDown(service.dispose);
    await service.start(ServerConfig(modelPath: 'm.gguf', port: base.port));
    await service.stop();
    expect(process.kills, 1);
    expect(service.runtime.state, EngineState.idle);
    expect(service.runningConfig, isNull);
  });

  test(
    'stop interrupts an engine start waiting for its process to launch',
    () async {
      final process = _ScriptedProcess();
      final enteredFactory = Completer<void>();
      final allowFactoryToReturn = Completer<void>();
      final service =
          InferenceService(
              processFactory: (exe, args, {workingDirectory}) async {
                enteredFactory.complete();
                await allowFactoryToReturn.future;
                return process;
              },
              engineDirOverride: () => '',
              healthInterval: const Duration(milliseconds: 5),
            )
            ..engines.add(_engineOf)
            ..selectEngine(_engineOf);
      addTearDown(service.dispose);

      final start = service.start(ServerConfig(modelPath: 'm.gguf'));
      await enteredFactory.future;
      final stopping = service.stop();
      allowFactoryToReturn.complete();
      await expectLater(start, throwsA(isA<EngineException>()));
      await stopping;
      expect(process.kills, 1);
      expect(service.runtime.state, EngineState.idle);
      expect(service.runningConfig, isNull);
    },
  );

  test('聊天直连 /v1/chat/completions：SSE 解析、鉴权与取消', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start();
    addTearDown(health.close);
    final service = _serviceWith(process, base);
    addTearDown(service.dispose);
    await service.start(
      ServerConfig(modelPath: 'm.gguf', port: base.port, apiKey: 'sk-chat'),
    );
    final chunks = await service.chatStream([
      {'role': 'user', 'content': '你好'},
    ], temperature: 0.5).toList();
    expect(chunks.length, 2);
    expect(chunks[0]['choices'][0]['delta']['content'], '你好');
    expect(chunks[1]['choices'][0]['delta']['reasoning_content'], '想一想');
    expect(health.lastChatHeaders?['authorization'], 'Bearer sk-chat');
    final body = jsonDecode(health.lastChatBody!);
    expect(body['stream'], true);
    expect(body['temperature'], 0.5);
    expect(body['stream_options']['include_usage'], true);
    // 服务端断流后可立即再次发起（无悬挂状态）。
    await expectLater(
      service.chatStream([
        {'role': 'user', 'content': 'again'},
      ]).toList(),
      completes,
    );
  });

  test('模型未就绪时聊天被拒绝', () async {
    final health = _HealthServer();
    await health.start();
    addTearDown(health.close);
    final service =
        InferenceService(
            engineDirOverride: () => '',
            healthInterval: const Duration(milliseconds: 5),
          )
          ..engines.add(_engineOf)
          ..selectEngine(_engineOf);
    addTearDown(service.dispose);
    await expectLater(
      service.chatStream([]).toList(),
      throwsA(isA<EngineException>()),
    );
  });

  test('503 loading → ok 的加载轮询', () async {
    final process = _ScriptedProcess();
    final health = _HealthServer();
    final base = await health.start(loadingFirst: true);
    addTearDown(health.close);
    final service = _serviceWith(process, base);
    addTearDown(service.dispose);
    await service.start(ServerConfig(modelPath: 'm.gguf', port: base.port));
    expect(health.loadingHits, 1);
    expect(service.isReady, true);
  });

  group(
    '引擎自动选择（真实设备探测）',
    () {
      late Directory engineRoot;

      setUp(() async {
        engineRoot = await Directory.systemTemp.createTemp('omm-engines-test');
        for (final backend in ['cuda', 'vulkan', 'cpu']) {
          final dir = Directory(
            '${engineRoot.path}${Platform.pathSeparator}llama-b10909-$backend-x64',
          )..createSync();
          File(
            '${dir.path}${Platform.pathSeparator}llama-server.exe',
          ).writeAsStringSync('');
          File(
            '${dir.path}${Platform.pathSeparator}engine.json',
          ).writeAsStringSync('{"tag":"b10909","backend":"$backend"}');
        }
      });

      tearDown(() async {
        await engineRoot.delete(recursive: true);
      });

      String exeOf(String backend) =>
          '${engineRoot.path}${Platform.pathSeparator}'
          'llama-b10909-$backend-x64${Platform.pathSeparator}llama-server.exe';

      Future<InferenceService> discoveredWith(
        Future<String> Function(String exe) prober,
      ) async {
        final service = InferenceService(
          engineDirOverride: () => engineRoot.path,
          deviceProber: prober,
        );
        addTearDown(service.dispose);
        await service.discoverEngines();
        // 探测在后台异步完成；假探针无真实延迟，短等待即可稳定。
        await Future<void>.delayed(const Duration(milliseconds: 80));
        return service;
      }

      test('N 卡：CUDA 报告设备时优先于 Vulkan', () async {
        final service = await discoveredWith(
          (exe) async =>
              exe == exeOf('cuda') ? '  CUDA0: NVIDIA RTX (16GB)' : '',
        );
        expect(service.selectedEngine!.backend, 'cuda');
      });

      test('A 卡/无 N 卡：CUDA 无设备时选 Vulkan', () async {
        final service = await discoveredWith(
          (exe) async => exe == exeOf('vulkan')
              ? 'Available devices:\n  Vulkan0: AMD Radeon (16GB)'
              : 'Available devices:\n',
        );
        expect(service.selectedEngine!.backend, 'vulkan');
      });

      test('无任何 GPU：保持 CPU 基准', () async {
        final service = await discoveredWith((exe) async => '');
        expect(service.selectedEngine!.backend, 'cpu');
      });

      test('探测异常按无设备处理，不阻塞其他引擎', () async {
        final service = await discoveredWith(
          (exe) async => exe == exeOf('vulkan')
              ? throw StateError('driver load failed')
              : '',
        );
        expect(service.selectedEngine!.backend, 'cpu');
      });

      test('用户手动选择后探测不再覆盖', () async {
        final service = InferenceService(
          engineDirOverride: () => engineRoot.path,
          deviceProber: (exe) async => exe == exeOf('cuda') ? '  CUDA0: X' : '',
        );
        addTearDown(service.dispose);
        await service.discoverEngines();
        // 在异步探测完成前手动选择 Vulkan。
        final vulkan = service.engines.firstWhere((e) => e.backend == 'vulkan');
        service.selectEngine(vulkan);
        await Future<void>.delayed(const Duration(milliseconds: 80));
        expect(service.selectedEngine!.backend, 'vulkan');
      });
    },
    skip: Platform.isLinux ? 'Windows llama-server engine discovery' : null,
  );
}
