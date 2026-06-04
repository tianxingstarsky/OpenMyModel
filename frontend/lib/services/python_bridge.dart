import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/server_config.dart';

/// Python 桥接服务 HTTP 客户端
/// 与本地 Python bridge_server.py 通信

class PythonBridge {
  static const String _baseUrl = "http://127.0.0.1:8765";
  http.Client? _client;

  http.Client get _http {
    _client ??= http.Client();
    return _client!;
  }

  void dispose() {
    _client?.close();
    _client = null;
  }

  // ==================== 服务管理 ====================

  Future<Map<String, dynamic>> getStatus() async {
    final resp = await _http.get(Uri.parse("$_baseUrl/api/status"))
        .timeout(const Duration(seconds: 5));
    return jsonDecode(resp.body);
  }

  Future<bool> startServer(ServerConfig config) async {
    final resp = await _http.post(
      Uri.parse("$_baseUrl/api/server/start"),
      headers: {"Content-Type": "application/json"},
      body: jsonEncode(config.toJson()),
    ).timeout(const Duration(seconds: 10));
    return resp.statusCode == 200;
  }

  Future<void> stopServer() async {
    try {
      await _http.post(Uri.parse("$_baseUrl/api/server/stop"))
          .timeout(const Duration(seconds: 5));
    } catch (_) {}
  }

  Future<bool> checkHealth() async {
    try {
      final resp = await _http.get(Uri.parse("$_baseUrl/api/server/check"))
          .timeout(const Duration(seconds: 5));
      final data = jsonDecode(resp.body);
      return data["healthy"] == true;
    } catch (_) {
      return false;
    }
  }

  // ==================== 配置档案 ====================

  Future<List<dynamic>> listProfiles() async {
    final resp = await _http.get(Uri.parse("$_baseUrl/api/profiles"))
        .timeout(const Duration(seconds: 5));
    return jsonDecode(resp.body);
  }

  Future<bool> saveProfile(String name, ServerConfig config) async {
    final resp = await _http.post(
      Uri.parse("$_baseUrl/api/profiles/save"),
      headers: {"Content-Type": "application/json"},
      body: jsonEncode({"name": name, "config": config.toJson()}),
    ).timeout(const Duration(seconds: 5));
    return resp.statusCode == 200;
  }

  Future<ServerConfig?> loadProfile(String name) async {
    try {
      final resp = await _http.post(
        Uri.parse("$_baseUrl/api/profiles/load"),
        headers: {"Content-Type": "application/json"},
        body: jsonEncode({"name": name}),
      ).timeout(const Duration(seconds: 5));
      if (resp.statusCode == 200) {
        return ServerConfig.fromJson(jsonDecode(resp.body));
      }
    } catch (_) {}
    return null;
  }

  Future<bool> deleteProfile(String name) async {
    final resp = await _http.delete(
      Uri.parse("$_baseUrl/api/profiles/delete?name=$name"),
    ).timeout(const Duration(seconds: 5));
    return resp.statusCode == 200;
  }

  // ==================== 文件浏览 ====================

  Future<Map<String, dynamic>> listFiles(String path, {String pattern = "*.gguf"}) async {
    final resp = await _http.get(
      Uri.parse("$_baseUrl/api/files/list?path=${Uri.encodeComponent(path)}&pattern=$pattern"),
    ).timeout(const Duration(seconds: 10));
    return jsonDecode(resp.body);
  }

  Future<List<String>> listDrives() async {
    final resp = await _http.get(Uri.parse("$_baseUrl/api/files/drives"))
        .timeout(const Duration(seconds: 5));
    final data = jsonDecode(resp.body);
    return List<String>.from(data["drives"] ?? []);
  }

  // ==================== 流式聊天 ====================

  Stream<String> chatStream(List<Map<String, dynamic>> messages, {double temp = 0.7}) async* {
    var streamClient = http.Client();
    try {
      final request = http.Request("POST", Uri.parse("$_baseUrl/api/chat"));
      request.headers["Content-Type"] = "application/json";
      request.body = jsonEncode({
        "messages": messages,
        "temperature": temp,
        "stream": true,
      });

      final response = await streamClient.send(request);
      await for (final chunk in response.stream.transform(utf8.decoder)) {
        for (final line in chunk.split("\n")) {
          if (line.startsWith("data: ") && line != "data: [DONE]") {
            yield line.substring(6);
          }
        }
      }
    } finally {
      streamClient.close();
    }
  }
}
