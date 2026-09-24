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
  final host = uri.host.toLowerCase();
  final loopback =
      host == 'localhost' ||
      host.endsWith('.localhost') ||
      host == '::1' ||
      RegExp(r'^127(?:\.\d{1,3}){3}$').hasMatch(host);
  if (['http', 'ws'].contains(uri.scheme) && !loopback) {
    throw const FormatException('远程服务器必须使用 HTTPS 地址；明文连接只允许本机回环地址');
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
