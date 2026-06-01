import re

# ============ 1. FIX home_page.dart: add _loadPrefs + sanitize defaults ============
with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\home_page.dart", "r", encoding="utf-8") as f:
    home = f.read()

# Remove hardcoded model folder default
home = home.replace(
    'final tcFolder = TextEditingController(text: r"F:\\llama_cpp\\llama-b9253\\models");',
    'final tcFolder = TextEditingController();'
)

# Add _loadPrefs call in initState
home = home.replace(
    "void initState() {\n    super.initState();\n    _refresh();\n    _startBridge();\n    _loadP();\n  }",
    "void initState() {\n    super.initState();\n    _loadPrefs();\n    _refresh();\n    _startBridge();\n    _loadP();\n  }"
)

# Add _loadPrefs method after _savePrefs
old_save = """  Future<void> _savePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString("server_path", tcServer.text);
    await prefs.setString("model_folder", tcFolder.text);
  }"""

new_save_load = """  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final sp = prefs.getString("server_path");
    final mf = prefs.getString("model_folder");
    if (mounted) setState(() {
      if (sp != null && sp.isNotEmpty) tcServer.text = sp;
      if (mf != null && mf.isNotEmpty) tcFolder.text = mf;
    });
  }

  Future<void> _savePrefs() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString("server_path", tcServer.text);
    await prefs.setString("model_folder", tcFolder.text);
  }"""

home = home.replace(old_save, new_save_load)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\home_page.dart", "w", encoding="utf-8") as f:
    f.write(home)
print("home_page.dart: persistence + sanitized defaults")

# ============ 2. FIX cloud_page.dart: sanitize URL + key feedback + fix display ============
with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    cloud = f.read()

# Sanitize default URL
cloud = cloud.replace(
    "final tcUrl = TextEditingController(text: 'aiapi.topofmoon.com:3000');",
    "final tcUrl = TextEditingController();"
)

# Add success message to _createKey
old_create_key = """    tcKeyName.clear(); tcKeyLimit.clear();
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
  }"""
new_create_key = """    tcKeyName.clear(); tcKeyLimit.clear();
    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));
    if (mounted) ft.displayInfoBar(context, builder: (c, cl) => ft.InfoBar(title: Text("API Key 已生成: " + n), severity: ft.InfoBarSeverity.success));
  }"""
cloud = cloud.replace(old_create_key, new_create_key)

# Fix key display (tokens showing empty)
cloud = cloud.replace(
    "Text('月:  tokens /  累计'",
    "Text('月: " + '${k["monthlyTokens"]}' + " tokens / " + '${k["totalTokens"]}' + ' 累计'"
)

# Change placeholder
cloud = cloud.replace(
    "placeholder: 'aiapi.topofmoon.com:3000'",
    "placeholder: 'your-server.com:3000'"
)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(cloud)
print("cloud_page.dart: sanitized URL + key feedback + display fix")

# ============ 3. FIX backend CLI: add node status ============
with open(r"F:\llama_cpp\output_my_model\backend\src\cli.ts", "r", encoding="utf-8") as f:
    cli = f.read()

# Add node status display after config summary
old_cli_end = """  console.log("║  运行 npm start 启动服务                      ║");
  console.log("║  在前端输入域名和密码即可连接                  ║");
  console.log("╚══════════════════════════════════════════════╝");"""

new_cli_end = """  console.log("║  运行 npm start 启动服务                      ║");
  console.log("║  在前端输入域名和密码即可连接                  ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("启动服务后，可运行 npm run status 查看节点在线状态");
  console.log("本地算力节点通过 WebSocket 连接后会自动上线");
  console.log("");"""

cli = cli.replace(old_cli_end, new_cli_end)

with open(r"F:\llama_cpp\output_my_model\backend\src\cli.ts", "w", encoding="utf-8") as f:
    f.write(cli)
print("cli.ts: node status hints added")

print("\nAll fixes applied")
