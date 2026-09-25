/// Dart 端配置档案存储，兼容旧 Python Bridge 写入的
/// %USERPROFILE%\.openmymodel\profiles\*.json 格式（含 name/created_at/updated_at）。
import 'dart:convert';
import 'dart:io';

import '../models/server_config.dart';

class ProfileNameException implements Exception {
  final String message;
  ProfileNameException(this.message);
  @override
  String toString() => message;
}

class ProfileStore {
  final String directory;

  ProfileStore({String? dir})
    : directory =
          dir ??
          '${Platform.environment['USERPROFILE'] ?? Platform.environment['HOME'] ?? Directory.systemTemp.path}'
              '${Platform.pathSeparator}.openmymodel${Platform.pathSeparator}profiles';

  static const _reservedNames = {
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'CONIN\$',
    'CONOUT\$',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  };

  Future<void> _secureLinuxStorage({File? file}) async {
    if (!Platform.isLinux) return;
    final dir = Directory(directory);
    if (await dir.exists()) {
      final result = await Process.run('chmod', [
        '700',
        dir.path,
      ], runInShell: false);
      if (result.exitCode != 0) {
        throw FileSystemException('无法限制配置档案目录的访问权限', dir.path);
      }
    }
    if (file != null && await file.exists()) {
      final result = await Process.run('chmod', [
        '600',
        file.path,
      ], runInShell: false);
      if (result.exitCode != 0) {
        throw FileSystemException('无法限制配置档案文件的访问权限', file.path);
      }
    }
  }

  /// 与旧 Python 实现相同的名称规则：文字/数字/空格/._-，防保留名与大小写别名冲突。
  File _profileFile(String name) {
    if (name.isEmpty || name.trim().isEmpty || name == '.' || name == '..') {
      throw ProfileNameException('配置档案名称不能为空或仅包含空白');
    }
    if (name.length > 200 ||
        !RegExp(r'^[\p{L}\p{N}._\- ]+$', unicode: true).hasMatch(name)) {
      throw ProfileNameException('配置档案名称仅支持文字、数字、空格及 ._-，且不能超过 200 字符');
    }
    final base = name.split('.').first.trimRight().toUpperCase();
    if (_reservedNames.contains(base)) {
      throw ProfileNameException('配置档案名称不能使用 Windows 保留设备名称');
    }
    final file = File('$directory${Platform.pathSeparator}$name.json');
    final lower = name.toLowerCase();
    for (final existing in listSync()) {
      if (existing['name'] != name &&
          (existing['name'] as String).toLowerCase() == lower) {
        throw ProfileNameException('配置档案名称与已有档案 \'${existing['name']}\' 冲突');
      }
    }
    return file;
  }

  static String _basename(String path) {
    if (path.isEmpty) return '';
    return path.split(RegExp(r'[/\\]')).last;
  }

  Future<List<Map<String, dynamic>>> list() async {
    final dir = Directory(directory);
    if (!dir.existsSync()) return [];
    await _secureLinuxStorage();
    final result = <Map<String, dynamic>>[];
    final entries =
        dir
            .listSync(followLinks: false)
            .whereType<File>()
            .where((f) => f.path.toLowerCase().endsWith('.json'))
            .toList()
          ..sort(
            (a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()),
          );
    for (final file in entries) {
      try {
        await _secureLinuxStorage(file: file);
        final data = jsonDecode(await file.readAsString());
        if (data is! Map) continue;
        result.add({
          'name': file.uri.pathSegments.last.substring(
            0,
            file.uri.pathSegments.last.length - '.json'.length,
          ),
          'model': _basename('${data['model_path'] ?? ''}'),
          'mmproj': _basename('${data['mmproj_path'] ?? ''}'),
          'context_size': data['context_size'] ?? 0,
          'updated_at': '${data['updated_at'] ?? ''}',
        });
      } catch (_) {
        // 损坏档案跳过，不中断列表。
      }
    }
    return result;
  }

  List<Map<String, dynamic>> listSync() {
    final dir = Directory(directory);
    if (!dir.existsSync()) return [];
    final result = <Map<String, dynamic>>[];
    final entries =
        dir
            .listSync(followLinks: false)
            .whereType<File>()
            .where((f) => f.path.toLowerCase().endsWith('.json'))
            .toList()
          ..sort(
            (a, b) => a.path.toLowerCase().compareTo(b.path.toLowerCase()),
          );
    for (final file in entries) {
      try {
        final data = jsonDecode(file.readAsStringSync());
        if (data is! Map) continue;
        result.add({
          'name': file.uri.pathSegments.last.substring(
            0,
            file.uri.pathSegments.last.length - '.json'.length,
          ),
          'model': _basename('${data['model_path'] ?? ''}'),
          'mmproj': _basename('${data['mmproj_path'] ?? ''}'),
          'context_size': data['context_size'] ?? 0,
          'updated_at': '${data['updated_at'] ?? ''}',
        });
      } catch (_) {}
    }
    return result;
  }

  Future<void> save(String name, ServerConfig config) async {
    final file = _profileFile(name);
    await Directory(directory).create(recursive: true);
    await _secureLinuxStorage();
    final now = DateTime.now().toIso8601String();
    var createdAt = now;
    if (file.existsSync()) {
      try {
        final existing = jsonDecode(await file.readAsString());
        if (existing is Map && existing['created_at'] is String) {
          createdAt = existing['created_at'] as String;
        }
      } catch (_) {}
    }
    final data = {
      ...config.toJson(),
      'name': name,
      'created_at': createdAt,
      'updated_at': now,
    };
    // 原子写：同目录临时文件 + rename。
    final tmp = File(
      '$directory${Platform.pathSeparator}.profile-${DateTime.now().microsecondsSinceEpoch}.tmp',
    );
    try {
      await tmp.create(exclusive: true);
      await _secureLinuxStorage(file: tmp);
      await tmp.writeAsString(jsonEncode(data), flush: true);
      await tmp.rename(file.path);
    } catch (_) {
      if (await tmp.exists()) await tmp.delete();
      rethrow;
    }
  }

  Future<ServerConfig?> load(String name) async {
    final file = _profileFile(name);
    if (!file.existsSync()) return null;
    await _secureLinuxStorage(file: file);
    final data = jsonDecode(await file.readAsString());
    if (data is! Map) {
      throw const FormatException('配置档案必须是 JSON 对象');
    }
    return ServerConfig.fromJson(Map<String, dynamic>.from(data));
  }

  Future<bool> delete(String name) async {
    final file = _profileFile(name);
    if (!file.existsSync()) return false;
    await _secureLinuxStorage(file: file);
    await file.delete();
    return true;
  }
}
