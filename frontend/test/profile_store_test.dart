import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/models/server_config.dart';
import 'package:openmymodel/services/profile_store.dart';

void main() {
  late Directory tempDir;
  late ProfileStore store;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omm-profiles-test');
    store = ProfileStore(dir: tempDir.path);
  });

  tearDown(() async {
    await tempDir.delete(recursive: true);
  });

  test('保存/读取 round-trip 保留新字段', () async {
    final config = ServerConfig(
      modelPath: r'C:\models\qwen.gguf',
      nGpuLayers: -1,
      contextSize: 32768,
      servedModelName: 'chat-balanced',
      hfToken: 'hf-test-token',
      vllmImage: 'vllm/vllm-openai:v0.30.0',
      apiKey: 'sk-omm-node-test',
      flashAttnMode: 'on',
      contBatchingMode: 'off',
      reranking: true,
      enableMetrics: true,
      cacheTypeK: 'q8_0',
    );
    await store.save('默认 配置.1', config);
    final loaded = await store.load('默认 配置.1');
    expect(loaded!.modelPath, config.modelPath);
    expect(loaded.servedModelName, config.servedModelName);
    expect(loaded.hfToken, config.hfToken);
    expect(loaded.vllmImage, config.vllmImage);
    expect(loaded.apiKey, config.apiKey);
    expect(loaded.nGpuLayers, -1);
    expect(loaded.flashAttnMode, 'on');
    expect(loaded.contBatchingMode, 'off');
    expect(loaded.reranking, true);
    expect(loaded.enableMetrics, true);
    final list = await store.list();
    expect(list.single['name'], '默认 配置.1');
    expect(list.single['model'], 'qwen.gguf');
    expect((list.single['updated_at'] as String).isNotEmpty, true);
  });

  test('兼容旧 Python Bridge 档案格式（布尔 flash_attn/cont_batching）', () async {
    // 旧格式：dataclass 展平 JSON + name/created_at/updated_at。
    final legacy = File('${tempDir.path}${Platform.pathSeparator}旧档案.json');
    await legacy.writeAsString('''
{
  "server_path": "C:/llama/llama-server.exe",
  "model_path": "C:/models/llama.gguf",
  "mmproj_path": "",
  "n_gpu_layers": 99,
  "context_size": 128000,
  "batch_size": 2048,
  "ubatch_size": 512,
  "threads": 0,
  "flash_attn": true,
  "cache_type_k": "q8_0",
  "cache_type_v": "q8_0",
  "host": "127.0.0.1",
  "port": 8081,
  "api_key": "",
  "slots": 1,
  "embeddings": false,
  "rope_freq_base": 0.0,
  "rope_freq_scale": 0.0,
  "yarn_ext_factor": 0.0,
  "yarn_attn_factor": 0.0,
  "no_kv_offload": false,
  "cont_batching": false,
  "ml_lock": false,
  "no_mmap": false,
  "extra_args": "",
  "name": "旧档案",
  "created_at": "2026-01-01T00:00:00.000",
  "updated_at": "2026-01-02T00:00:00.000"
}
''');
    final loaded = await store.load('旧档案');
    expect(loaded!.flashAttnMode, 'on');
    expect(loaded.contBatchingMode, 'off');
    expect(loaded.contextSize, 128000);
    expect(loaded.port, 8081);
    // 新布尔语义写入时保留 created_at。
    final config = loaded..modelPath = r'C:\models\new.gguf';
    await store.save('旧档案', config);
    final raw = await legacy.readAsString();
    expect(raw.contains('2026-01-01T00:00:00.000'), true);
  });

  test('非法档案名被拒绝（保留名/非法字符/大小写冲突）', () async {
    for (final bad in ['', '  ', '.', '..', 'CON', 'com1', 'a/b', 'a?b']) {
      expect(
        () => store.save(bad, ServerConfig()),
        throwsA(isA<ProfileNameException>()),
        reason: '名称 "$bad" 应被拒绝',
      );
    }
    await store.save('Profile', ServerConfig());
    expect(
      () => store.save('PROFILE', ServerConfig()),
      throwsA(isA<ProfileNameException>()),
    );
  });

  test('删除档案，缺失返回 false；损坏档案跳过列表', () async {
    await store.save('ok', ServerConfig());
    File(
      '${tempDir.path}${Platform.pathSeparator}broken.json',
    ).writeAsStringSync('{not json');
    expect((await store.list()).map((p) => p['name']), ['ok']);
    expect(await store.delete('ok'), true);
    expect(await store.delete('ok'), false);
  });
}
