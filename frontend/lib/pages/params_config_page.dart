import 'package:flutter/material.dart';
import 'package:fluent_ui/fluent_ui.dart' as ft;
import '../models/server_config.dart';
import '../services/python_bridge.dart';

/// 参数配置档案页 - 所有 llama.cpp 参数可视化编辑，多配置档管理

class ParamsConfigPage extends StatefulWidget {
  final PythonBridge bridge;
  const ParamsConfigPage({super.key, required this.bridge});

  @override
  State<ParamsConfigPage> createState() => _ParamsConfigPageState();
}

class _ParamsConfigPageState extends State<ParamsConfigPage> {
  ServerConfig _config = ServerConfig();
  List<dynamic> _profiles = [];
  String _selectedProfile = "";
  final TextEditingController _newProfileCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadProfiles();
  }

  Future<void> _loadProfiles() async {
    try {
      final profiles = await widget.bridge.listProfiles();
      setState(() => _profiles = profiles);
    } catch (_) {}
  }

  Future<void> _saveProfile() async {
    final name = _newProfileCtrl.text.trim();
    if (name.isEmpty) {
      if (_selectedProfile.isNotEmpty) {
        await widget.bridge.saveProfile(_selectedProfile, _config);
      }
    } else {
      await widget.bridge.saveProfile(name, _config);
      _newProfileCtrl.clear();
    }
    _loadProfiles();
  }

  Future<void> _loadProfile(String name) async {
    final config = await widget.bridge.loadProfile(name);
    if (config != null) {
      setState(() {
        _config = config;
        _selectedProfile = name;
      });
    }
  }

  Future<void> _deleteProfile(String name) async {
    await widget.bridge.deleteProfile(name);
    _loadProfiles();
    if (_selectedProfile == name) setState(() => _selectedProfile = "");
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text("参数配置档案", style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 16),

        // 配置档案管理
        _buildProfileManager(),
        const SizedBox(height: 24),

        // GPU & 内存
        _buildSection("GPU / 显存"),
        _intField("ngl — GPU 层数 (-1=全部, 99=尽可能)", "将模型多少层卸载到 GPU。值越大显存占用越大速度越快", _config.nGpuLayers, (v) => _config.nGpuLayers = v),
        _intField("c — 上下文大小", "模型最大上下文窗口（令牌数）。如 4096/8192/128000", _config.contextSize, (v) => _config.contextSize = v),
        _boolField("mlock — 锁定内存", "将模型锁定在 RAM 中，防止被系统换出到磁盘", _config.mlLock, (v) => _config.mlLock = v),
        _boolField("no-mmap — 禁用内存映射", "不使用 mmap 加载模型，可能降低内存占用但更慢", _config.noMmap, (v) => _config.noMmap = v),
        const SizedBox(height: 16),

        // 批处理
        _buildSection("批处理 / 线程"),
        _intField("b — 批处理大小", "同时处理的令牌数。越大推理越快但显存消耗更多", _config.batchSize, (v) => _config.batchSize = v),
        _intField("ub — 微批处理大小", "更细粒度的批处理。通常设为 batch/4", _config.ubatchSize, (v) => _config.ubatchSize = v),
        _intField("t — CPU 线程数", "推理使用的 CPU 线程数。0 = 自动检测物理核心", _config.threads, (v) => _config.threads = v),
        _intField("np — 并行槽位", "同时处理的最大请求数。默认 1", _config.slots, (v) => _config.slots = v),
        const SizedBox(height: 16),

        // 注意力机制
        _buildSection("注意力机制"),
        _boolField("fa — Flash Attention", "使用 Flash Attention 加速推理，减少显存占用", _config.flashAttn, (v) => _config.flashAttn = v),
        _boolField("no-kv-offload — 禁用 KV 卸载", "将 KV 缓存保留在 GPU 上而非卸载到 CPU", _config.noKvOffload, (v) => _config.noKvOffload = v),
        _boolField("cb — 连续批处理", "启用连续批处理，提高并发效率", _config.contBatching, (v) => _config.contBatching = v),
        const SizedBox(height: 16),

        // 缓存量化
        _buildSection("缓存量化（节省显存）"),
        _dropdownField("ctk — K 缓存类型", "Key 缓存的量化精度：f16 最高精度，q8_0 推荐，q4_0 更低", _config.cacheTypeK, ["f16", "q8_0", "q4_0"], (v) => _config.cacheTypeK = v),
        _dropdownField("ctv — V 缓存类型", "Value 缓存的量化精度，同上", _config.cacheTypeV, ["f16", "q8_0", "q4_0"], (v) => _config.cacheTypeV = v),
        const SizedBox(height: 16),

        // RoPE & YaRN
        _buildSection("位置编码 (RoPE / YaRN)"),
        _doubleField("rope-freq-base — RoPE 基础频率", "位置编码基础频率。0=使用模型默认值。如 1000000", _config.ropeFreqBase, (v) => _config.ropeFreqBase = v),
        _doubleField("rope-freq-scale — RoPE 缩放", "位置编码线性缩放因子。0=不缩放。如 0.5 缩小一半", _config.ropeFreqScale, (v) => _config.ropeFreqScale = v),
        _doubleField("yarn-ext-factor — YaRN 扩展因子", "YaRN 外推因子。大于 1 可扩展上下文。0=不启用", _config.yarnExtFactor, (v) => _config.yarnExtFactor = v),
        _doubleField("yarn-attn-factor — YaRN 注意力因子", "YaRN 注意力缩放。通常 1.0", _config.yarnAttnFactor, (v) => _config.yarnAttnFactor = v),
        const SizedBox(height: 16),

        // 服务
        _buildSection("服务配置"),
        _intField("port — 监听端口", "llama-server 的 HTTP 端口", _config.port, (v) => _config.port = v),
        _boolField("embeddings — 启用嵌入", "启用 /v1/embeddings 端点", _config.embeddings, (v) => _config.embeddings = v),
        const SizedBox(height: 24),

        // 保存按钮
        ft.FilledButton(
          onPressed: _saveProfile,
          child: const Text("💾 保存配置"),
        ),
        const SizedBox(height: 32),
      ]),
    );
  }

  Widget _buildProfileManager() {
    return ft.Card(
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text("配置档案", style: TextStyle(fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        if (_profiles.isEmpty)
          Text("暂无保存的配置档案", style: TextStyle(color: Colors.grey[500])),
        ...(_profiles.map((p) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(children: [
            Icon(_selectedProfile == p["name"] ? Icons.folder_open : Icons.folder, size: 18),
            const SizedBox(width: 8),
            Text(p["name"], style: TextStyle(fontWeight: _selectedProfile == p["name"] ? FontWeight.bold : FontWeight.normal)),
            const SizedBox(width: 8),
            Text(p["model"] ?? "", style: TextStyle(fontSize: 11, color: Colors.grey[500])),
            const Spacer(),
            ft.HyperlinkButton(onPressed: () => _loadProfile(p["name"]), child: const Text("加载")),
            ft.HyperlinkButton(onPressed: () => _deleteProfile(p["name"]), child: const Text("删除", style: TextStyle(color: Colors.red))),
          ]),
        ))),
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: ft.TextBox(controller: _newProfileCtrl, placeholder: "新建配置档案名称")),
          const SizedBox(width: 8),
          ft.Button(onPressed: _saveProfile, child: const Text("保存为")),
        ]),
      ]),
    );
  }

  // ==================== 表单辅助方法 ====================

  Widget _buildSection(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: const Color(0xFF00B7C3))),
    );
  }

  Widget _intField(String label, String hint, int value, Function(int) onChanged) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
        Text(hint, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
        const SizedBox(height: 4),
        SizedBox(width: 200, child: ft.TextBox(controller: TextEditingController(text: value.toString()),
            onChanged: (v) {
              final n = int.tryParse(v);
              if (n != null) { onChanged(n); setState(() {}); }
            },
          ),
        ),
      ]),
    );
  }

  Widget _doubleField(String label, String hint, double value, Function(double) onChanged) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
        Text(hint, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
        const SizedBox(height: 4),
        SizedBox(width: 200, child: ft.TextBox(controller: TextEditingController(text: value.toString()),
            onChanged: (v) {
              final n = double.tryParse(v);
              if (n != null) { onChanged(n); setState(() {}); }
            },
          ),
        ),
      ]),
    );
  }

  Widget _boolField(String label, String hint, bool value, Function(bool) onChanged) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(children: [
        SizedBox(
          width: 40,
          child: ft.ToggleSwitch(checked: value, onChanged: (v) { onChanged(v); setState(() {}); }),
        ),
        const SizedBox(width: 8),
        Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
          Text(hint, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
        ]),
      ]),
    );
  }

  Widget _dropdownField(String label, String hint, String value, List<String> options, Function(String) onChanged) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
        Text(hint, style: TextStyle(fontSize: 11, color: Colors.grey[500])),
        const SizedBox(height: 4),
        SizedBox(
          width: 150,
          child: ft.ComboBox<String>(
            value: value,
            items: options.map((o) => ft.ComboBoxItem(value: o, child: Text(o))).toList(),
            onChanged: (v) { if (v != null) { onChanged(v); setState(() {}); } },
          ),
        ),
      ]),
    );
  }
}