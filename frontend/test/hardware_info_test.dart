import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/services/hardware_info.dart';

Map<String, dynamic> system(List<Map<String, dynamic>> devices) => {
  'devices': devices,
  'status': devices.isEmpty ? 'cpu_only' : 'detected',
  'source': 'windows-dxgi',
};

HardwareInfoService windows(
  List<Map<String, dynamic>> devices, {
  HardwareProcessRunner? runner,
}) => HardwareInfoService(
  operatingSystem: 'windows',
  architecture: 'x64',
  systemProbe: () async => system(devices),
  processRunner:
      runner ??
      (exe, args, {workingDirectory}) async =>
          const HardwareProcessResult(1, ''),
  now: () => DateTime.utc(2026, 10, 7),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'Partial NVIDIA statistics cannot overwrite another concrete GPU model',
    () async {
      final info = await windows(
        [
          {
            'name': 'NVIDIA GeForce RTX 4080',
            'backend': 'dxgi',
            'totalMemoryMiB': 16000,
          },
          {
            'name': 'NVIDIA GeForce RTX 4090',
            'backend': 'dxgi',
            'totalMemoryMiB': 24000,
          },
        ],
        runner: (exe, args, {workingDirectory}) async =>
            const HardwareProcessResult(
              0,
              'NVIDIA GeForce RTX 4090, 24564, 21000\n',
            ),
      ).detect();
      expect(info['devices'], [
        {
          'name': 'NVIDIA GeForce RTX 4080',
          'backend': 'dxgi',
          'totalMemoryMiB': 16000,
        },
        {
          'name': 'NVIDIA GeForce RTX 4090',
          'backend': 'dxgi',
          'totalMemoryMiB': 24564,
          'freeMemoryMiB': 21000,
        },
      ]);
    },
  );

  test(
    'Concrete NVIDIA models match before generic PCI device fallback',
    () async {
      final info = await windows(
        [
          {'name': 'NVIDIA GPU (PCI 2704)', 'backend': 'drm'},
          {'name': 'NVIDIA GeForce RTX 4090', 'backend': 'dxgi'},
        ],
        runner: (exe, args, {workingDirectory}) async =>
            const HardwareProcessResult(
              0,
              'NVIDIA GeForce RTX 4090, 24564, 21000\nNVIDIA GeForce RTX 4080, 16384, 12000\n',
            ),
      ).detect();
      final devices = info['devices'] as List;
      expect(devices.length, 2);
      expect(devices.first['name'], 'NVIDIA GeForce RTX 4080');
      expect(devices.last['name'], 'NVIDIA GeForce RTX 4090');
    },
  );

  test(
    'Linux numeric display class remains a GPU when PCI names are unavailable',
    () async {
      for (final numericVendor in [false, true]) {
        for (final driverAvailable in [false, true]) {
          final info = await HardwareInfoService(
            operatingSystem: 'linux',
            directoryReader: (path) async => null,
            fileReader: (path) async => null,
            processRunner: (exe, args, {workingDirectory}) async =>
                exe == 'lspci'
                ? HardwareProcessResult(
                    0,
                    '0000:03:00.0 "Class 0302 [0302]" "${numericVendor ? '10de' : 'NVIDIA Corporation'} [10de]" "${numericVendor ? '2684' : 'Device'} [2684]"\n',
                  )
                : (driverAvailable
                      ? const HardwareProcessResult(
                          0,
                          'NVIDIA GeForce RTX 4090, 24564, 21000\n',
                        )
                      : const HardwareProcessResult(1, '')),
          ).detect();
          expect(info['status'], 'detected');
          expect(info['devices'], [
            driverAvailable
                ? {
                    'name': 'NVIDIA GeForce RTX 4090',
                    'backend': 'pci',
                    'totalMemoryMiB': 24564,
                    'freeMemoryMiB': 21000,
                  }
                : {'name': 'NVIDIA GPU (PCI 2684)', 'backend': 'pci'},
          ]);
        }
      }
    },
  );

  test(
    'Windows enumerates through the native system channel without an engine',
    () async {
      const channel = MethodChannel('openmymodel/hardware');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            expect(call.method, 'getGpuInfo');
            return system([
              {
                'name': 'AMD Radeon RX 7900 XTX',
                'backend': 'dxgi',
                'totalMemoryMiB': 24560,
              },
              {'name': 'Intel UHD Graphics', 'backend': 'dxgi'},
            ]);
          });
      addTearDown(
        () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null),
      );
      final info = await HardwareInfoService(
        operatingSystem: 'windows',
        processRunner: (exe, args, {workingDirectory}) async {
          expect(exe, 'nvidia-smi');
          return const HardwareProcessResult(1, '');
        },
      ).detect();
      expect(info['source'], 'windows-dxgi');
      expect(info['status'], 'detected');
      expect(info['devices'], [
        {
          'name': 'AMD Radeon RX 7900 XTX',
          'backend': 'dxgi',
          'totalMemoryMiB': 24560,
        },
        {'name': 'Intel UHD Graphics', 'backend': 'dxgi'},
      ]);
    },
  );

  test(
    'NVIDIA adds actual memory while mixed and identical system GPUs remain distinct',
    () async {
      final info = await windows(
        [
          {
            'name': 'NVIDIA GeForce RTX 4090',
            'backend': 'dxgi',
            'totalMemoryMiB': 24000,
          },
          {
            'name': 'NVIDIA GeForce RTX 4090',
            'backend': 'dxgi',
            'totalMemoryMiB': 24000,
          },
          {
            'name': 'AMD Radeon RX 7900 XTX',
            'backend': 'dxgi',
            'totalMemoryMiB': 24560,
          },
          {
            'name': 'AMD Radeon RX 7900 XTX',
            'backend': 'dxgi',
            'totalMemoryMiB': 24560,
          },
          {
            'name': 'Intel Arc A770',
            'backend': 'dxgi',
            'totalMemoryMiB': 16384,
          },
        ],
        runner: (exe, args, {workingDirectory}) async {
          expect(exe, 'nvidia-smi');
          expect(args, contains('--query-gpu=name,memory.total,memory.free'));
          return const HardwareProcessResult(
            0,
            'NVIDIA GeForce RTX 4090, 24564, 21000\nNVIDIA GeForce RTX 4090, 24564, 0\n',
          );
        },
      ).detect();
      expect(info['source'], 'windows-dxgi+nvidia-smi');
      expect(info['detectedAt'], '2026-10-07T00:00:00.000Z');
      final devices = info['devices'] as List;
      expect(devices.length, 5);
      expect(devices.first, {
        'name': 'NVIDIA GeForce RTX 4090',
        'backend': 'dxgi',
        'totalMemoryMiB': 24564,
        'freeMemoryMiB': 21000,
      });
      expect(devices[1]['freeMemoryMiB'], 0);
      expect(
        devices.where((d) => d['name'] == 'AMD Radeon RX 7900 XTX').length,
        2,
      );
      expect(devices.last['name'], 'Intel Arc A770');
    },
  );

  test(
    'NVIDIA remains a fallback when operating system enumeration fails',
    () async {
      final info = await HardwareInfoService(
        operatingSystem: 'windows',
        systemProbe: () async => throw StateError('not available'),
        processRunner: (exe, args, {workingDirectory}) async =>
            const HardwareProcessResult(0, 'NVIDIA GPU, 16311, 14000'),
      ).detect();
      expect(info['status'], 'detected');
      expect(info['source'], 'nvidia-smi');
      expect(info['devices'], [
        {
          'name': 'NVIDIA GPU',
          'backend': 'cuda',
          'totalMemoryMiB': 16311,
          'freeMemoryMiB': 14000,
        },
      ]);
    },
  );

  test(
    'Unknown memory is omitted while a successful empty system inventory is CPU-only',
    () async {
      final info = await windows([
        {
          'name': 'Intel Integrated GPU',
          'backend': 'dxgi',
          'totalMemoryMiB': 0,
        },
      ]).detect();
      expect(info['devices'], [
        {'name': 'Intel Integrated GPU', 'backend': 'dxgi'},
      ]);
      expect((await windows([]).detect())['status'], 'cpu_only');
      final unknown = await HardwareInfoService(
        operatingSystem: 'windows',
        systemProbe: () async => throw StateError('failed'),
        processRunner: (exe, args, {workingDirectory}) async =>
            const HardwareProcessResult(1, ''),
      ).detect();
      expect(unknown['status'], 'unknown');
      expect(unknown['devices'], isEmpty);
    },
  );

  test(
    'Linux uses sysfs dedicated memory and PCI names without an inference binary',
    () async {
      final files = {
        '/sys/class/drm/card0/device/vendor': '0x1002\n',
        '/sys/class/drm/card0/device/device': '0x744c\n',
        '/sys/class/drm/card0/device/uevent': 'PCI_SLOT_NAME=0000:03:00.0\n',
        '/sys/class/drm/card0/device/mem_info_vram_total':
            '${24 * 1024 * 1024 * 1024}\n',
        '/sys/class/drm/card1/device/vendor': '0x8086\n',
        '/sys/class/drm/card1/device/device': '0x56a0\n',
        '/sys/class/drm/card1/device/uevent': 'PCI_SLOT_NAME=0000:04:00.0\n',
      };
      final commands = <String>[];
      final info = await HardwareInfoService(
        operatingSystem: 'linux',
        directoryReader: (path) async => [
          '/sys/class/drm/card0',
          '/sys/class/drm/card1',
          '/sys/class/drm/card0-DP-1',
        ],
        fileReader: (path) async => files[path],
        processRunner: (exe, args, {workingDirectory}) async {
          commands.add(exe);
          if (exe != 'lspci') return const HardwareProcessResult(1, '');
          expect(args, ['-Dmm', '-nn']);
          return const HardwareProcessResult(
            0,
            '0000:03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 31 [Radeon RX 7900 XTX]"\n0000:04:00.0 "Display controller" "Intel Corporation" "Arc A770"\n',
          );
        },
      ).detect();
      expect(commands, ['lspci', 'nvidia-smi']);
      expect(info['status'], 'detected');
      expect(info['source'], 'linux-sysfs+lspci');
      final devices = info['devices'] as List;
      expect(devices.length, 2);
      expect(devices.first['name'], contains('Radeon RX 7900 XTX'));
      expect(devices.first['totalMemoryMiB'], 24576);
      expect(devices.last.containsKey('totalMemoryMiB'), false);
    },
  );

  test(
    'Linux without pciutils still reports sysfs GPUs and unknown VRAM',
    () async {
      final info = await HardwareInfoService(
        operatingSystem: 'linux',
        directoryReader: (path) async => ['/sys/class/drm/card0'],
        fileReader: (path) async => path.endsWith('/vendor')
            ? '0x1002'
            : (path.endsWith('/device') ? '0x744c' : null),
        processRunner: (exe, args, {workingDirectory}) async =>
            throw StateError('not installed'),
      ).detect();
      expect(info['status'], 'detected');
      expect(info['source'], 'linux-sysfs');
      expect(info['devices'], [
        {'name': 'AMD GPU (PCI 744c)', 'backend': 'drm'},
      ]);
    },
  );

  test(
    'Linux absent sysfs and pciutils is unknown; a successful PCI inventory can prove CPU-only',
    () async {
      for (final available in [false, true]) {
        final info = await HardwareInfoService(
          operatingSystem: 'linux',
          directoryReader: (path) async => null,
          fileReader: (path) async => null,
          processRunner: (exe, args, {workingDirectory}) async =>
              exe == 'lspci' && available
              ? const HardwareProcessResult(
                  0,
                  '0000:00:00.0 "Host bridge" "Intel Corporation" "Host bridge"\n',
                )
              : const HardwareProcessResult(1, ''),
        ).detect();
        expect(info['status'], available ? 'cpu_only' : 'unknown');
        expect(info['devices'], isEmpty);
      }
    },
  );

  test(
    'Linux normalizes NVIDIA PCI names to driver names without double counting',
    () async {
      final info = await HardwareInfoService(
        operatingSystem: 'linux',
        directoryReader: (path) async => [],
        fileReader: (path) async => null,
        processRunner: (exe, args, {workingDirectory}) async => exe == 'lspci'
            ? const HardwareProcessResult(
                0,
                '0000:03:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "AD106 [GeForce RTX 4060 Ti] [2820]"\n',
              )
            : const HardwareProcessResult(
                0,
                'NVIDIA GeForce RTX 4060 Ti, 16311, 14000\n',
              ),
      ).detect();
      expect(info['devices'], [
        {
          'name': 'NVIDIA GeForce RTX 4060 Ti',
          'backend': 'pci',
          'totalMemoryMiB': 16311,
          'freeMemoryMiB': 14000,
        },
      ]);
    },
  );

  test(
    'macOS uses system GPU data without reporting shared unified memory as VRAM',
    () async {
      final info = await HardwareInfoService(
        operatingSystem: 'macos',
        processRunner: (exe, args, {workingDirectory}) async {
          expect(exe, 'system_profiler');
          expect(args, ['SPDisplaysDataType', '-json']);
          return HardwareProcessResult(
            0,
            jsonEncode({
              'SPDisplaysDataType': [
                {
                  'sppci_model': 'Apple M4 Max',
                  'spdisplays_vram_shared': '48 GB',
                  'spdisplays_vram': '48 GB',
                },
                {
                  'sppci_model': 'AMD Radeon Pro 580',
                  'spdisplays_vram': '8 GB',
                },
              ],
            }),
          );
        },
      ).detect();
      expect(info['source'], 'macos-system-profiler');
      expect(info['devices'], [
        {'name': 'Apple M4 Max', 'backend': 'system'},
        {
          'name': 'AMD Radeon Pro 580',
          'backend': 'system',
          'totalMemoryMiB': 8192,
        },
      ]);
    },
  );

  test(
    'Hung driver tools and oversized output are bounded without losing system GPUs',
    () async {
      final hung = HardwareInfoService(
        operatingSystem: 'windows',
        systemProbe: () async => system([
          {'name': 'Intel GPU', 'backend': 'dxgi'},
        ]),
        processRunner: (exe, args, {workingDirectory}) =>
            Completer<HardwareProcessResult>().future,
        probeTimeout: const Duration(milliseconds: 15),
      );
      final watch = Stopwatch()..start();
      expect((await hung.detect())['status'], 'detected');
      expect(watch.elapsed, lessThan(const Duration(seconds: 2)));
      final oversized = HardwareInfoService(
        operatingSystem: 'windows',
        systemProbe: () async => {'status': 'unknown', 'devices': []},
        processRunner: (exe, args, {workingDirectory}) async =>
            HardwareProcessResult(0, 'A' * 80),
        maxOutputBytes: 32,
      );
      expect((await oversized.detect())['status'], 'unknown');
    },
  );

  test(
    'Disposal stops subsequent probes and rejects late system data',
    () async {
      final pending = Completer<Map<String, dynamic>>();
      var commands = 0;
      final hardware = HardwareInfoService(
        operatingSystem: 'windows',
        systemProbe: () => pending.future,
        processRunner: (exe, args, {workingDirectory}) async {
          commands++;
          return const HardwareProcessResult(0, 'GPU, 16311, 10000');
        },
      );
      final detection = hardware.detect();
      hardware.dispose();
      pending.complete(
        system([
          {'name': 'Late GPU', 'backend': 'dxgi'},
        ]),
      );
      expect((await detection)['status'], 'unknown');
      expect(commands, 0);
      expect((await hardware.detect())['status'], 'unknown');
      expect(commands, 0);
    },
  );

  test('Many GPU reports respect the server inventory size limit', () async {
    final info = await windows(
      List.generate(
        32,
        (index) => {'name': '${'测' * 230} $index', 'backend': 'dxgi'},
      ),
    ).detect();
    expect(info['status'], 'detected');
    expect(info['devices'], isNotEmpty);
    expect((info['devices'] as List).length, lessThanOrEqualTo(16));
    expect(utf8.encode(jsonEncode(info)).length, lessThanOrEqualTo(4000));
  });
}
