import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:openmymodel/services/cloud_url.dart';
import 'package:openmymodel/services/sse.dart';

void main() {
  test(
    'SSE preserves split UTF8, CRLF, multiline data and final half line',
    () async {
      final bytes = utf8.encode(
        'data: {"text":"你好"}\r\n\r\ndata:first\ndata: second\n\ndata: last',
      );
      final events = await decodeSse(
        Stream.fromIterable(bytes.map((byte) => [byte])),
      ).toList();
      expect(events, ['{"text":"你好"}', 'first\nsecond', 'last']);
    },
  );

  test('SSE stops at DONE and ignores comment events', () async {
    final events = await decodeSse(
      Stream.value(utf8.encode(': ping\n\ndata: [DONE]\n\ndata: ignored\n\n')),
    ).toList();
    expect(events, isEmpty);
  });

  test('Cloud URL handles HTTPS and existing websocket paths', () {
    expect(
      normalizeCloudUri('host.test:3000').toString(),
      'http://host.test:3000',
    );
    expect(
      cloudEndpoint(
        'wss://host.test/prefix/ws/node',
        '/admin/nodes',
      ).toString(),
      'https://host.test/prefix/admin/nodes',
    );
    for (final url in [
      'ftp://host.test',
      'http://user:pass@host.test',
      'http://host.test?secret=yes',
      '',
    ]) {
      expect(() => normalizeCloudUri(url), throwsFormatException);
    }
  });
}
