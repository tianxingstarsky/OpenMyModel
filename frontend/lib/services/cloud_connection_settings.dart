import 'dart:convert';
import 'package:shared_preferences/shared_preferences.dart';
import 'cloud_url.dart';

class CloudConnectionProfile {
  final String serverUrl;
  final String mode;
  final String credential;
  final String nodeName;
  final String? nodeId;

  const CloudConnectionProfile({
    required this.serverUrl,
    required this.mode,
    required this.credential,
    this.nodeName = 'OpenMyModel-本地节点',
    this.nodeId,
  });

  static CloudConnectionProfile fromClipboard(String text) {
    if (text.length > 16384) throw const FormatException('连接信息过长，请重新从网页复制');
    final dynamic value;
    try {
      value = jsonDecode(text);
    } catch (_) {
      throw const FormatException('请在网页节点接入窗口点击“一键复制连接信息”');
    }
    if (value is! Map<String, dynamic> ||
        value['version'] != 1 ||
        value['serverUrl'] is! String ||
        value['nodeToken'] is! String ||
        !['provider', 'relay'].contains(value['mode'])) {
      throw const FormatException('连接信息格式无效，请重新从网页复制');
    }
    final credential = (value['nodeToken'] as String).trim();
    if (!RegExp(
      r'^omm-relay-node-[A-Za-z0-9_-]{32,128}$',
    ).hasMatch(credential)) {
      throw const FormatException('连接信息中的节点 Token 无效，请重新复制');
    }
    final name = value['nodeName'] is String
        ? (value['nodeName'] as String).trim()
        : '';
    return CloudConnectionProfile(
      serverUrl: normalizeCloudUri(value['serverUrl'] as String).toString(),
      mode: value['mode'] as String,
      credential: credential,
      nodeName: name.isEmpty
          ? 'OpenMyModel-本地节点'
          : name.substring(0, name.length > 80 ? 80 : name.length),
    );
  }
}

/// Credentials are scoped to the normalized server and its current mode.
/// Legacy credentials are read only for the server they were saved against.
class CloudConnectionSettings {
  final SharedPreferences preferences;
  static const _profilesKey = 'cloud_connection_profiles_v1';
  CloudConnectionSettings(this.preferences);

  Map<String, dynamic> _profiles() {
    try {
      final value = jsonDecode(preferences.getString(_profilesKey) ?? '{}');
      if (value is Map<String, dynamic>) return value;
    } catch (_) {
      /* An explicitly successful connection can repair the store. */
    }
    return {};
  }

  CloudConnectionProfile? find(String serverUrl, String mode) {
    final url = normalizeCloudUri(serverUrl).toString();
    final value = _profiles()[url];
    if (value is Map && value['mode'] == 'legacy') {
      final credential =
          value[mode == 'personal'
              ? 'personalCredential'
              : 'accountCredential'];
      if (credential is String && credential.isNotEmpty) {
        return CloudConnectionProfile(
          serverUrl: url,
          mode: mode,
          credential: credential,
        );
      }
    }
    if (value is Map &&
        value['mode'] == mode &&
        value['credential'] is String) {
      return CloudConnectionProfile(
        serverUrl: url,
        mode: mode,
        credential: value['credential'] as String,
        nodeName: value['nodeName'] is String
            ? value['nodeName'] as String
            : 'OpenMyModel-本地节点',
        nodeId: value['nodeId'] is String ? value['nodeId'] as String : null,
      );
    }
    try {
      if (normalizeCloudUri(
            preferences.getString('cloud_url') ?? '',
          ).toString() ==
          url) {
        final credential = preferences.getString(
          mode == 'personal' ? 'cloud_password' : 'cloud_relay_node_token',
        );
        if (credential != null && credential.isNotEmpty && value == null) {
          return CloudConnectionProfile(
            serverUrl: url,
            mode: mode,
            credential: credential,
          );
        }
      }
    } on FormatException {
      /* No valid legacy server. */
    }
    return null;
  }

  Future<void> save(CloudConnectionProfile profile) async {
    final url = normalizeCloudUri(profile.serverUrl).toString();
    final profiles = _profiles();
    try {
      final legacyUrl = normalizeCloudUri(
        preferences.getString('cloud_url') ?? '',
      ).toString();
      if (!profiles.containsKey(legacyUrl)) {
        final personal = preferences.getString('cloud_password');
        final account = preferences.getString('cloud_relay_node_token');
        if (personal != null || account != null) {
          profiles[legacyUrl] = {
            'mode': 'legacy',
            'personalCredential': personal,
            'accountCredential': account,
          };
        }
      }
    } on FormatException {
      /* No valid legacy server to migrate. */
    }
    profiles[url] = {
      'mode': profile.mode,
      'credential': profile.credential,
      'nodeName': profile.nodeName,
      if (profile.mode == 'personal' && profile.nodeId != null)
        'nodeId': profile.nodeId,
    };
    await preferences.setString(_profilesKey, jsonEncode(profiles));
    await preferences.setString('cloud_url', url);
    // Once migrated, a global credential must never be rebound to another server.
    await preferences.remove('cloud_password');
    await preferences.remove('cloud_relay_node_token');
  }
}
