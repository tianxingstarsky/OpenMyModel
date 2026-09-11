import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/server_config.dart';

class BridgeException implements Exception {
  final String message;
  final int? statusCode;
  BridgeException(this.message, [this.statusCode]);
  @override
  String toString() =>
      statusCode == null ? message : 'HTTP $statusCode: $message';
}

Stream<String> decodeSse(Stream<List<int>> bytes) async* {
  final data = <String>[];
  await for (final line
      in bytes.transform(utf8.decoder).transform(const LineSplitter())) {
    if (line.isEmpty) {
      if (data.isNotEmpty) {
        final event = data.join('\n');
        data.clear();
        if (event.trim() == '[DONE]') return;
        yield event;
      }
    } else if (line.startsWith('data:')) {
      final value = line.substring(5);
      data.add(value.startsWith(' ') ? value.substring(1) : value);
    }
  }
  if (data.isNotEmpty && data.join('\n').trim() != '[DONE]')
    yield data.join('\n');
}

class PythonBridge {
  final String baseUrl;
  final http.Client Function() _clientFactory;
  final _clients = <http.Client>{};
  http.Client? _chatClient;
  bool _disposed = false;
  PythonBridge({
    this.baseUrl = 'http://127.0.0.1:8765',
    http.Client Function()? clientFactory,
  }) : _clientFactory = clientFactory ?? http.Client.new;

  Future<dynamic> _request(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, String>? headers,
    Object? body,
    Duration timeout = const Duration(seconds: 5),
  }) async {
    if (_disposed) throw StateError('桥接客户端已关闭');
    final client = _clientFactory();
    _clients.add(client);
    try {
      final request = http.Request(method, _uri(path, query));
      if (headers != null) request.headers.addAll(headers);
      if (body != null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = jsonEncode(body);
      }
      final response = await (() async => http.Response.fromStream(
        await client.send(request),
      ))().timeout(timeout);
      return _decode(response);
    } finally {
      client.close();
      _clients.remove(client);
    }
  }

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$baseUrl$path').replace(queryParameters: query);
  dynamic _decode(http.Response response) {
    dynamic data;
    final text = utf8.decode(response.bodyBytes, allowMalformed: true);
    try {
      data = jsonDecode(text);
    } catch (_) {
      data = text;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = data is Map
          ? data['detail'] ?? data['error'] ?? data
          : data;
      final message = error is Map ? error['message'] ?? error : error;
      throw BridgeException(message.toString(), response.statusCode);
    }
    return data;
  }

  Future<Map<String, dynamic>> getStatus() async =>
      Map<String, dynamic>.from(await _request('GET', '/api/status'));

  Future<bool> startServer(ServerConfig config) async {
    final data = await _request(
      'POST',
      '/api/server/start',
      body: config.toJson(),
      timeout: const Duration(seconds: 15),
    );
    if (data is! Map || data['ok'] != true) throw BridgeException('启动未成功');
    return true;
  }

  Future<void> stopServer() async {
    await _request(
      'POST',
      '/api/server/stop',
      timeout: const Duration(seconds: 15),
    );
  }

  Future<bool> shutdownBridge(
    String token, {
    Duration timeout = const Duration(seconds: 15),
  }) async {
    final data = await _request(
      'POST',
      '/api/shutdown',
      headers: {'X-Bridge-Token': token},
      timeout: timeout,
    );
    return data is Map && data['ok'] == true;
  }

  Future<bool> checkHealth() async {
    final data = await _request('GET', '/api/server/check');
    return data is Map && data['healthy'] == true;
  }

  Future<List<dynamic>> listProfiles() async =>
      List<dynamic>.from(await _request('GET', '/api/profiles'));

  Future<bool> saveProfile(String name, ServerConfig config) async {
    final data = await _request(
      'POST',
      '/api/profiles/save',
      body: {'name': name, 'config': config.toJson()},
    );
    return data is Map && data['ok'] == true;
  }

  Future<ServerConfig?> loadProfile(String name) async {
    dynamic data = await _request(
      'POST',
      '/api/profiles/load',
      body: {'name': name},
    );
    if (data is String) data = jsonDecode(data);
    return ServerConfig.fromJson(Map<String, dynamic>.from(data));
  }

  Future<bool> deleteProfile(String name) async {
    final data = await _request(
      'DELETE',
      '/api/profiles/delete',
      query: {'name': name},
    );
    return data is Map && data['ok'] == true;
  }

  Future<Map<String, dynamic>> listFiles(
    String path, {
    String pattern = '*.gguf',
  }) async => Map<String, dynamic>.from(
    await _request(
      'GET',
      '/api/files/list',
      query: {'path': path, 'pattern': pattern},
      timeout: const Duration(seconds: 10),
    ),
  );

  Future<List<String>> listDrives() async {
    final data = await _request('GET', '/api/files/drives');
    return List<String>.from(data['drives'] ?? []);
  }

  Stream<String> chatStream(
    List<Map<String, dynamic>> messages, {
    double temp = 0.7,
  }) async* {
    if (_disposed) throw StateError('桥接客户端已关闭');
    if (_chatClient != null) throw StateError('已有对话请求正在生成');
    final client = _clientFactory();
    _chatClient = client;
    try {
      final request = http.Request('POST', _uri('/api/chat'))
        ..headers['Content-Type'] = 'application/json'
        ..body = jsonEncode({
          'messages': messages,
          'temperature': temp,
          'stream': true,
        });
      final response = await client
          .send(request)
          .timeout(const Duration(seconds: 120));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        _decode(
          await http.Response.fromStream(
            response,
          ).timeout(const Duration(seconds: 10)),
        );
      }
      if (!(response.headers['content-type'] ?? '').contains(
        'text/event-stream',
      )) {
        throw BridgeException('服务未返回 SSE 流式响应', response.statusCode);
      }
      await for (final event in decodeSse(
        response.stream.timeout(const Duration(seconds: 120)),
      )) {
        yield event;
      }
    } finally {
      client.close();
      if (identical(_chatClient, client)) _chatClient = null;
    }
  }

  void cancelChat() => _chatClient?.close();

  void dispose() {
    _disposed = true;
    cancelChat();
    for (final client in _clients) {
      client.close();
    }
    _clients.clear();
  }
}
