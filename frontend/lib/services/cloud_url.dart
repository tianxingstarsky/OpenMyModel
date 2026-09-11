Uri normalizeCloudUri(String input) {
  final text = input.trim();
  if (text.isEmpty) throw const FormatException('请输入服务器地址');
  final uri = Uri.tryParse(text.contains('://') ? text : 'http://$text');
  if (uri == null ||
      !['http', 'https', 'ws', 'wss'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const FormatException('请输入不含账号、查询参数的 HTTP(S) 服务器地址');
  }
  final path = uri.path
      .replaceFirst(RegExp(r'/ws/node/?$'), '')
      .replaceFirst(RegExp(r'/$'), '');
  return uri.replace(
    scheme: ['https', 'wss'].contains(uri.scheme) ? 'https' : 'http',
    path: path,
  );
}

Uri cloudEndpoint(String input, String path) {
  final base = normalizeCloudUri(input);
  return base.replace(path: '${base.path}$path');
}
