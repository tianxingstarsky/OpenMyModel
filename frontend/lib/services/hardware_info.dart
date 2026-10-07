import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';

import 'package:flutter/services.dart';

class HardwareProcessResult {
  final int exitCode;
  final String stdout;
  final String stderr;

  const HardwareProcessResult(this.exitCode, this.stdout, [this.stderr = '']);
}

typedef HardwareProcessRunner =
    Future<HardwareProcessResult> Function(
      String executable,
      List<String> arguments, {
      String? workingDirectory,
    });
typedef HardwareSystemProbe = Future<Map<String, dynamic>> Function();
typedef HardwareFileReader = Future<String?> Function(String path);
typedef HardwareDirectoryReader = Future<List<String>?> Function(String path);

/// Enumerates the operating system's GPUs independently of model engines.
/// Dedicated memory that cannot be read is omitted, including unified RAM.
class HardwareInfoService {
  HardwareInfoService({
    HardwareProcessRunner? processRunner,
    HardwareSystemProbe? systemProbe,
    HardwareFileReader? fileReader,
    HardwareDirectoryReader? directoryReader,
    this.probeTimeout = const Duration(seconds: 3),
    this.maxOutputBytes = 64 * 1024,
    String? operatingSystem,
    String? architecture,
    DateTime Function()? now,
  }) : _runner = processRunner,
       _systemProbe = systemProbe,
       _fileReader = fileReader ?? _readFile,
       _directoryReader = directoryReader ?? _listDirectory,
       _os = operatingSystem ?? Platform.operatingSystem,
       _arch = architecture ?? Abi.current().toString().split('_').last,
       _now = now ?? DateTime.now;

  final HardwareProcessRunner? _runner;
  final HardwareSystemProbe? _systemProbe;
  final HardwareFileReader _fileReader;
  final HardwareDirectoryReader _directoryReader;
  final Duration probeTimeout;
  final int maxOutputBytes;
  final String _os;
  final String _arch;
  final DateTime Function() _now;
  final Set<Process> _activeProcesses = {};
  bool _disposed = false;

  void dispose() {
    _disposed = true;
    for (final process in _activeProcesses) {
      process.kill();
    }
    _activeProcesses.clear();
  }

  Future<Map<String, dynamic>> detect() async {
    if (_disposed) return _cancelled();
    Map<String, dynamic> system;
    try {
      system = await (_systemProbe?.call() ?? _probeSystem()).timeout(
        probeTimeout + const Duration(seconds: 2),
      );
    } on Object {
      system = {
        'status': 'unknown',
        'source': 'unavailable',
        'devices': <Map<String, dynamic>>[],
        'error': '系统暂时无法读取显卡信息。',
      };
    }
    if (_disposed) return _cancelled();
    final systemDevices = _devices(system['devices']);
    var nvidia = <Map<String, dynamic>>[];
    if (_os == 'windows' || _os == 'linux') {
      try {
        final result = await _run('nvidia-smi', const [
          '--query-gpu=name,memory.total,memory.free',
          '--format=csv,noheader,nounits',
        ]);
        if (_disposed) return _cancelled();
        if (result.exitCode == 0) nvidia = _nvidiaDevices(result.stdout);
      } on Object {
        // Driver tools add VRAM readings but are not required for enumeration.
      }
    }
    if (_disposed) return _cancelled();
    final devices = _mergeNvidia(systemDevices, nvidia);
    final source = system['source'] is String
        ? (system['source'] as String)
        : 'unavailable';
    return _snapshot(
      devices,
      nvidia.isNotEmpty
          ? (systemDevices.isEmpty ? 'nvidia-smi' : '$source+nvidia-smi')
          : source,
      devices.isNotEmpty
          ? 'detected'
          : (system['status'] == 'cpu_only' ? 'cpu_only' : 'unknown'),
      error: devices.isEmpty && system['status'] != 'cpu_only'
          ? '未能读取显卡信息，请检查系统权限或显卡驱动。'
          : null,
    );
  }

  Future<Map<String, dynamic>> _probeSystem() async {
    switch (_os) {
      case 'windows':
        return Map<String, dynamic>.from(
          await const MethodChannel(
                'openmymodel/hardware',
              ).invokeMapMethod<String, dynamic>('getGpuInfo') ??
              const {'status': 'unknown', 'devices': []},
        );
      case 'linux':
        return _linuxDevices();
      case 'macos':
        return _macDevices();
      default:
        return {'status': 'unknown', 'devices': [], 'source': 'unavailable'};
    }
  }

  static Future<String?> _readFile(String path) async {
    try {
      return await File(path).readAsString();
    } on FileSystemException {
      return null;
    }
  }

  static Future<List<String>?> _listDirectory(String path) async {
    try {
      return await Directory(
        path,
      ).list(followLinks: false).map((entry) => entry.path).toList();
    } on FileSystemException {
      return null;
    }
  }

  Future<Map<String, dynamic>> _linuxDevices() async {
    final sysfs = <String, Map<String, dynamic>>{};
    final paths = await _directoryReader('/sys/class/drm');
    for (final path in paths ?? const <String>[]) {
      if (_disposed) return _cancelled();
      if (!RegExp(r'/card\d+$').hasMatch(path)) continue;
      final prefix = '$path/device';
      final vendor = (await _fileReader('$prefix/vendor'))?.trim();
      final id = (await _fileReader('$prefix/device'))?.trim();
      if (vendor == null || id == null) continue;
      final uevent = await _fileReader('$prefix/uevent') ?? '';
      final address = RegExp(
        r'^PCI_SLOT_NAME=(\S+)',
        multiLine: true,
      ).firstMatch(uevent)?[1];
      final bytes = int.tryParse(
        (await _fileReader('$prefix/mem_info_vram_total') ?? '').trim(),
      );
      final total = bytes != null && bytes > 0 ? bytes ~/ (1024 * 1024) : null;
      final brand =
          const {
            '0x10de': 'NVIDIA',
            '0x1002': 'AMD',
            '0x8086': 'Intel',
            '0x106b': 'Apple',
          }[vendor.toLowerCase()] ??
          'GPU';
      sysfs[address ?? path] = {
        'name': '$brand GPU (PCI ${id.replaceFirst('0x', '')})',
        'backend': 'drm',
        if (total != null && total > 0) 'totalMemoryMiB': total,
      };
      if (sysfs.length >= 16) break;
    }
    if (_disposed) return _cancelled();
    try {
      final pci = await _run('lspci', const ['-Dmm', '-nn']);
      if (pci.exitCode == 0) {
        final devices = <Map<String, dynamic>>[];
        var recognizedLines = 0;
        for (final line in const LineSplitter().convert(pci.stdout)) {
          final fields = RegExp(
            r'"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)',
          ).allMatches(line).map((match) => match[1] ?? match[2]!).toList();
          if (fields.length < 4 ||
              !RegExp(
                r'^[\da-f]{4}:[\da-f]{2}:[\da-f]{2}\.\d$',
                caseSensitive: false,
              ).hasMatch(fields[0])) {
            continue;
          }
          recognizedLines++;
          if (!RegExp(
            r'VGA|3D controller|Display controller|\[03[\da-f]{2}\]|^(?:Class\s+)?03[\da-f]{2}(?:\s|$)',
            caseSensitive: false,
          ).hasMatch(fields[1])) {
            continue;
          }
          final fromSysfs = sysfs.remove(fields[0]);
          devices.add({
            ...?fromSysfs,
            'name': _pciName(fields[2], fields[3]),
            'backend': 'pci',
          });
        }
        devices.addAll(sysfs.values);
        if (devices.isNotEmpty || recognizedLines > 0) {
          return {
            'devices': devices,
            'status': devices.isEmpty ? 'cpu_only' : 'detected',
            'source': 'linux-sysfs+lspci',
          };
        }
      }
    } on Object {
      // sysfs still supplies hardware identity when pciutils is not installed.
    }
    return {
      'devices': sysfs.values.toList(),
      'status': sysfs.isEmpty ? 'unknown' : 'detected',
      'source': 'linux-sysfs',
    };
  }

  static String _pciName(String vendor, String product) {
    final idPattern = RegExp(r'\[([\da-f]{4})\]', caseSensitive: false);
    final vendorId =
        idPattern.firstMatch(vendor)?[1] ??
        (RegExp(r'^[\da-f]{4}$', caseSensitive: false).hasMatch(vendor)
            ? vendor
            : null);
    final deviceId =
        idPattern.firstMatch(product)?[1] ??
        (RegExp(r'^[\da-f]{4}$', caseSensitive: false).hasMatch(product)
            ? product
            : null);
    final cleanIds = RegExp(
      r'\s*\[[\da-f]{4}(?::[\da-f]{4})?\]',
      caseSensitive: false,
    );
    final cleanProduct = product.replaceAll(cleanIds, '').trim();
    if (deviceId != null &&
        RegExp(
          r'^(?:Device|[\da-f]{4})$',
          caseSensitive: false,
        ).hasMatch(cleanProduct)) {
      final brand = const {
        '10de': 'NVIDIA',
        '1002': 'AMD',
        '8086': 'Intel',
        '106b': 'Apple',
      }[vendorId?.toLowerCase()];
      if (brand != null) return '$brand GPU (PCI $deviceId)';
    }
    return '${vendor.replaceAll(cleanIds, '').trim()} $cleanProduct'.trim();
  }

  Future<Map<String, dynamic>> _macDevices() async {
    final result = await _run('system_profiler', const [
      'SPDisplaysDataType',
      '-json',
    ]);
    if (result.exitCode != 0) throw StateError('System display query failed');
    final decoded = jsonDecode(result.stdout);
    if (decoded is! Map || decoded['SPDisplaysDataType'] is! List) {
      throw const FormatException('Missing system display inventory');
    }
    final devices = <Map<String, dynamic>>[];
    for (final entry in decoded['SPDisplaysDataType'] as List) {
      if (entry is! Map) continue;
      final name = entry['sppci_model'] ?? entry['_name'];
      if (name is! String || name.trim().isEmpty) continue;
      // Apple silicon uses shared unified memory, never dedicated GPU VRAM.
      final total = name.toLowerCase().startsWith('apple ')
          ? null
          : _macMemory(entry['spdisplays_vram']);
      devices.add({
        'name': name,
        'backend': 'system',
        if (total != null) 'totalMemoryMiB': total,
      });
    }
    return {
      'devices': devices,
      'status': devices.isNotEmpty
          ? 'detected'
          : ((decoded['SPDisplaysDataType'] as List).isEmpty
                ? 'cpu_only'
                : 'unknown'),
      'source': 'macos-system-profiler',
    };
  }

  static int? _macMemory(Object? value) {
    if (value is! String) return null;
    final match = RegExp(
      r'^([\d.]+)\s*(MB|GB|TB|MiB|GiB|TiB)$',
      caseSensitive: false,
    ).firstMatch(value.trim());
    if (match == null) return null;
    final amount = double.tryParse(match[1]!);
    final unit = match[2]!.toLowerCase();
    if (amount == null || !amount.isFinite || amount <= 0) return null;
    return (amount *
            (unit.startsWith('t')
                ? 1024 * 1024
                : (unit.startsWith('g') ? 1024 : 1)))
        .round();
  }

  static List<Map<String, dynamic>> _devices(Object? raw) {
    if (raw is! List) return [];
    final devices = <Map<String, dynamic>>[];
    for (final entry in raw) {
      if (entry is! Map || entry['name'] is! String) continue;
      final name = (entry['name'] as String).trim();
      if (name.isEmpty || name.length > 240) continue;
      final total = entry['totalMemoryMiB'];
      final free = entry['freeMemoryMiB'];
      final validTotal = total is int && total > 0 && total <= 16 * 1024 * 1024;
      devices.add({
        'name': name,
        'backend': entry['backend'] is String ? entry['backend'] : 'system',
        if (validTotal) 'totalMemoryMiB': total,
        if (validTotal && free is int && free >= 0 && free <= total)
          'freeMemoryMiB': free,
      });
      if (devices.length >= 16) break;
    }
    return devices;
  }

  static String _nameKey(String name) {
    final bracketed = RegExp(r'\[([^\]]+)\]').firstMatch(name)?[1];
    return (bracketed ?? name)
        .toLowerCase()
        .replaceAll(RegExp(r'nvidia|corporation|geforce|graphics|adapter'), '')
        .replaceAll(RegExp(r'[^a-z0-9]'), '');
  }

  static List<Map<String, dynamic>> _mergeNvidia(
    List<Map<String, dynamic>> system,
    List<Map<String, dynamic>> nvidia,
  ) {
    final remaining = List<Map<String, dynamic>>.from(nvidia);
    final matches = List<Map<String, dynamic>?>.filled(system.length, null);
    // Resolve all concrete names first so a generic system adapter cannot
    // consume the readings that belong to a later, specifically named GPU.
    for (var i = 0; i < system.length; i++) {
      final index = remaining.indexWhere(
        (entry) =>
            _nameKey(entry['name'] as String) ==
            _nameKey(system[i]['name'] as String),
      );
      if (index >= 0) matches[i] = remaining.removeAt(index);
    }
    final combined = <Map<String, dynamic>>[];
    for (var i = 0; i < system.length; i++) {
      final device = system[i];
      var match = matches[i];
      if (match == null &&
          remaining.isNotEmpty &&
          RegExp(
            r'^NVIDIA (?:Corporation )?(?:GPU \(PCI [\da-f]+\)|(?:Graphics )?Device)$',
            caseSensitive: false,
          ).hasMatch(device['name'] as String)) {
        match = remaining.removeAt(0);
      }
      if (match == null) {
        combined.add(device);
      } else {
        combined.add({...device, ...match, 'backend': device['backend']});
      }
    }
    combined.addAll(remaining);
    return combined;
  }

  Map<String, dynamic> _cancelled() =>
      _snapshot([], 'unavailable', 'unknown', error: '设备探测已取消。');

  Map<String, dynamic> _snapshot(
    List<Map<String, dynamic>> devices,
    String source,
    String status, {
    String? error,
  }) {
    final included = <Map<String, dynamic>>[];
    final snapshot = <String, dynamic>{
      'os': _os,
      'arch': _arch,
      'devices': included,
      'status': status,
      'detectedAt': _now().toUtc().toIso8601String(),
      'source': source,
      if (error != null) 'error': error,
    };
    for (final device in devices.take(16)) {
      included.add(device);
      if (utf8.encode(jsonEncode(snapshot)).length > 4000) {
        included.removeLast();
        break;
      }
    }
    return snapshot;
  }

  static List<Map<String, dynamic>> _nvidiaDevices(String output) {
    final raw = <Map<String, dynamic>>[];
    for (final line in const LineSplitter().convert(output)) {
      final columns = line.split(',');
      if (columns.length < 3) continue;
      final name = columns
          .sublist(0, columns.length - 2)
          .join(',')
          .trim()
          .replaceAll(RegExp(r'^"|"$'), '');
      if (name.isEmpty || name == 'N/A') continue;
      raw.add({
        'name': name,
        'backend': 'cuda',
        'totalMemoryMiB': int.tryParse(columns[columns.length - 2].trim()),
        'freeMemoryMiB': int.tryParse(columns.last.trim()),
      });
      if (raw.length >= 16) break;
    }
    return _devices(raw);
  }

  Future<HardwareProcessResult> _run(
    String executable,
    List<String> arguments, {
    String? workingDirectory,
  }) async {
    if (_disposed) throw StateError('Hardware probe has been disposed');
    final runner = _runner;
    if (runner != null) {
      final result = await runner(
        executable,
        arguments,
        workingDirectory: workingDirectory,
      ).timeout(probeTimeout);
      if (utf8.encode('${result.stdout}${result.stderr}').length >
          maxOutputBytes) {
        throw StateError('Hardware probe exceeded the output limit');
      }
      return result;
    }
    final process = await Process.start(
      executable,
      arguments,
      runInShell: false,
      workingDirectory: workingDirectory,
    );
    if (_disposed) {
      process.kill();
      unawaited(process.stdout.drain<void>());
      unawaited(process.stderr.drain<void>());
      throw StateError('Hardware probe has been disposed');
    }
    _activeProcesses.add(process);
    var bytes = 0;
    var exceeded = false;
    Future<String> collect(Stream<List<int>> stream) async {
      final buffer = <int>[];
      await for (final chunk in stream) {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) {
          exceeded = true;
          process.kill();
        } else {
          buffer.addAll(chunk);
        }
      }
      return utf8.decode(buffer, allowMalformed: true);
    }

    final stdout = collect(process.stdout);
    final stderr = collect(process.stderr);
    try {
      final code = await process.exitCode.timeout(probeTimeout);
      final outputs = await Future.wait([stdout, stderr]).timeout(probeTimeout);
      if (exceeded)
        throw StateError('Hardware probe exceeded the output limit');
      return HardwareProcessResult(code, outputs[0], outputs[1]);
    } on Object {
      process.kill();
      unawaited(stdout.catchError((Object _) => ''));
      unawaited(stderr.catchError((Object _) => ''));
      rethrow;
    } finally {
      _activeProcesses.remove(process);
    }
  }
}
