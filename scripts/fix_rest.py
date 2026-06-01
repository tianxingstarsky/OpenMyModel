with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\home_page.dart", "r", encoding="utf-8") as f:
    home = f.read()

# 1. Remove hardcoded model folder
home = home.replace(
    'final tcFolder = TextEditingController(text: r"F:\\llama_cpp\\llama-b9253\\models");',
    'final tcFolder = TextEditingController();'
)

# 2. Add _loadPrefs in initState
home = home.replace(
    "void initState() {\n    super.initState();\n    _refresh();\n    _startBridge();\n    _loadP();\n  }",
    "void initState() {\n    super.initState();\n    _loadPrefs();\n    _refresh();\n    _startBridge();\n    _loadP();\n  }"
)

# 3. Add _loadPrefs before _savePrefs
old = "  Future<void> _savePrefs() async {"
new = """  Future<void> _loadPrefs() async {
    final prefs = await SharedPreferences.getInstance();
    final sp = prefs.getString("server_path");
    final mf = prefs.getString("model_folder");
    if (mounted) setState(() {
      if (sp != null && sp.isNotEmpty) tcServer.text = sp;
      if (mf != null && mf.isNotEmpty) tcFolder.text = mf;
    });
  }

  Future<void> _savePrefs() async {"""
home = home.replace(old, new)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\home_page.dart", "w", encoding="utf-8") as f:
    f.write(home)
print("home_page done")

# 4. Fix cloud_page
with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "r", encoding="utf-8") as f:
    cloud = f.read()

# Sanitize URL
cloud = cloud.replace(
    "final tcUrl = TextEditingController(text: 'aiapi.topofmoon.com:3000');",
    "final tcUrl = TextEditingController();"
)

# Change placeholder
cloud = cloud.replace(
    "placeholder: 'aiapi.topofmoon.com:3000'",
    "placeholder: 'your-server.com:3000'"
)

# Add success feedback to _createKey
cloud = cloud.replace(
    "    tcKeyName.clear(); tcKeyLimit.clear();\n    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));\n  }",
    "    tcKeyName.clear(); tcKeyLimit.clear();\n    _wsService.syncKeys(List<Map<String, dynamic>>.from(_apiKeys));\n    if (mounted) ft.displayInfoBar(context, builder: (c, cl) => ft.InfoBar(title: Text(\"Key generated: \" + n), severity: ft.InfoBarSeverity.success));\n  }"
)

with open(r"F:\llama_cpp\output_my_model\frontend\lib\pages\cloud_page.dart", "w", encoding="utf-8") as f:
    f.write(cloud)
print("cloud_page done")

print("all remaining fixes applied")
