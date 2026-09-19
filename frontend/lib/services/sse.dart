/// 共用的 text/event-stream 解码。
///
/// 保留跨 chunk UTF-8、CRLF、多行 data: 和事件边界；遇到 [DONE] 结束。
import 'dart:convert';

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
