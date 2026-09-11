import 'dart:io';

/// 本地文件服务 - 不依赖 Python 桥接

class LocalFileService {
  static Future<List<Map<String, dynamic>>> listFilesAsync(String path) async {
    if (path.trim().isEmpty) return [];
    try {
      final files = <Map<String, dynamic>>[];
      await for (final entity in Directory(path).list(followLinks: false)) {
        if (entity is File && entity.path.toLowerCase().endsWith('.gguf')) {
          final stat = await entity.stat();
          files.add({
            'name': entity.uri.pathSegments.last,
            'path': entity.path,
            'size': stat.size,
            'is_dir': false,
          });
        }
      }
      files.sort(
        (a, b) => a['name'].toString().compareTo(b['name'].toString()),
      );
      return files;
    } catch (_) {
      return [];
    }
  }

  /// 列出目录下的文件
  static List<Map<String, dynamic>> listFiles(
    String path, {
    String pattern = ".gguf",
  }) {
    try {
      final dir = Directory(path);
      if (!dir.existsSync()) return [];
      final files = dir
          .listSync()
          .whereType<File>()
          .where((f) => f.path.endsWith(pattern))
          .toList();
      files.sort((a, b) => a.path.compareTo(b.path));
      return files
          .map(
            (f) => {
              "name": f.path.split(Platform.pathSeparator).last,
              "path": f.path,
              "size": f.lengthSync(),
              "is_dir": false,
            },
          )
          .toList();
    } catch (_) {
      return [];
    }
  }

  /// 列出 Windows 驱动器
  static List<String> listDrives() {
    if (!Platform.isWindows) return ["/"];
    try {
      final drives = <String>[];
      for (var letter in [
        'A',
        'B',
        'C',
        'D',
        'E',
        'F',
        'G',
        'H',
        'I',
        'J',
        'K',
        'L',
        'M',
        'N',
        'O',
        'P',
        'Q',
        'R',
        'S',
        'T',
        'U',
        'V',
        'W',
        'X',
        'Y',
        'Z',
      ]) {
        final path = '$letter:\\';
        if (Directory(path).existsSync()) drives.add(path);
      }
      return drives;
    } catch (_) {
      return ["C:\\"];
    }
  }
}
