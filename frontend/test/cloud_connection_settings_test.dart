import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:openmymodel/services/cloud_connection_settings.dart';

void main() {
  test(
    'connecting to a new server first preserves the previous legacy server credentials',
    () async {
      SharedPreferences.setMockInitialValues({
        'cloud_url': 'https://old.test',
        'cloud_password': 'old-password',
      });
      final prefs = await SharedPreferences.getInstance();
      final settings = CloudConnectionSettings(prefs);
      await settings.save(
        const CloudConnectionProfile(
          serverUrl: 'https://new.test',
          mode: 'personal',
          credential: 'new-password',
        ),
      );
      expect(
        settings.find('https://old.test', 'personal')?.credential,
        'old-password',
      );
      expect(
        settings.find('https://new.test', 'personal')?.credential,
        'new-password',
      );
      expect(settings.find('https://unrelated.test', 'personal'), isNull);
      expect(prefs.getString('cloud_password'), isNull);
    },
  );

  test(
    'legacy credentials migrate only for their original server and remain isolated by mode',
    () async {
      SharedPreferences.setMockInitialValues({
        'cloud_url': 'https://a.test/',
        'cloud_password': 'old-password',
      });
      final prefs = await SharedPreferences.getInstance();
      final settings = CloudConnectionSettings(prefs);
      expect(
        settings.find('https://a.test', 'personal')?.credential,
        'old-password',
      );
      expect(settings.find('https://b.test', 'personal'), isNull);
      await settings.save(
        const CloudConnectionProfile(
          serverUrl: 'https://a.test',
          mode: 'personal',
          credential: 'new-password',
          nodeId: 'node-a',
        ),
      );
      await settings.save(
        const CloudConnectionProfile(
          serverUrl: 'https://b.test',
          mode: 'relay',
          credential: 'token-b',
        ),
      );
      expect(
        settings.find('https://a.test/', 'personal')?.credential,
        'new-password',
      );
      expect(settings.find('https://a.test/', 'personal')?.nodeId, 'node-a');
      expect(settings.find('https://b.test', 'relay')?.credential, 'token-b');
      expect(settings.find('https://a.test', 'relay'), isNull);
      expect(settings.find('https://b.test', 'personal'), isNull);
      expect(prefs.getString('cloud_password'), isNull);
    },
  );

  test(
    'web connection information accepts valid tokens and rejects incompatible or unsafe data',
    () {
      final packet = {
        'version': 1,
        'serverUrl': 'gateway.test',
        'mode': 'provider',
        'nodeName': 'GPU A',
        'nodeToken': 'omm-relay-node-${List.filled(43, 'a').join()}',
      };
      final profile = CloudConnectionProfile.fromClipboard(jsonEncode(packet));
      expect(profile.serverUrl, 'https://gateway.test');
      expect(profile.nodeName, 'GPU A');
      for (final invalid in [
        {...packet, 'mode': 'personal'},
        {...packet, 'nodeToken': 'administrator-password'},
        {...packet, 'version': 2},
        {...packet, 'serverUrl': 'http://remote.test'},
        {...packet, 'serverUrl': 'https://user:password@gateway.test'},
      ]) {
        expect(
          () => CloudConnectionProfile.fromClipboard(jsonEncode(invalid)),
          throwsFormatException,
        );
      }
      expect(
        () => CloudConnectionProfile.fromClipboard('plain-token'),
        throwsFormatException,
      );
    },
  );
}
