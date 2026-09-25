/// llama-server 运行时配置数据模型（llama.cpp b10909）。
///
/// 兼容旧 Python Bridge 写入的 .openmymodel/profiles JSON：
/// 旧字段全部保留读取；新增的三态字段优先于旧布尔字段。
class ServerConfig {
  // 必需参数
  String serverPath;
  String modelPath;

  /// Optional public model alias advertised to local clients and the cloud router.
  String servedModelName;

  /// Hugging Face token used by the vLLM container to download gated models.
  String hfToken;

  /// Docker image for the Linux vLLM runtime.
  String vllmImage;

  // 多模态
  String mmprojPath;

  // 模型加载
  /// -1 = 全部层, 0 = auto（引擎默认，配合 --fit 自动适配显存）, >0 = 精确层数。
  int nGpuLayers;

  /// 0 = 从模型元数据读取（引擎默认）。
  int contextSize;
  int batchSize;
  int ubatchSize;
  int threads;

  /// Flash Attention: auto / on / off（引擎默认 auto）。
  String flashAttnMode;
  String cacheTypeK;
  String cacheTypeV;

  // 服务
  String host;
  int port;
  String apiKey;
  int slots;
  bool embeddings;
  bool reranking;
  bool enableMetrics;

  /// 连续批处理: auto（引擎默认 enabled）/ on / off。
  String contBatchingMode;

  // 高级（对应 -lm 加载模式）
  bool noKvOffload;
  bool mlLock;
  bool noMmap;
  double ropeFreqBase;
  double ropeFreqScale;
  double yarnExtFactor;
  double yarnAttnFactor;
  String extraArgs;

  ServerConfig({
    this.serverPath = "",
    this.modelPath = "",
    this.servedModelName = "",
    this.hfToken = "",
    this.vllmImage = "vllm/vllm-openai:v0.30.0",
    this.mmprojPath = "",
    this.nGpuLayers = 0,
    this.contextSize = 0,
    this.batchSize = 2048,
    this.ubatchSize = 512,
    this.threads = 0,
    this.flashAttnMode = "auto",
    this.cacheTypeK = "f16",
    this.cacheTypeV = "f16",
    this.host = "127.0.0.1",
    this.port = 8080,
    this.apiKey = "",
    this.slots = 1,
    this.embeddings = false,
    this.reranking = false,
    this.enableMetrics = false,
    this.contBatchingMode = "auto",
    this.noKvOffload = false,
    this.mlLock = false,
    this.noMmap = false,
    this.ropeFreqBase = 0.0,
    this.ropeFreqScale = 0.0,
    this.yarnExtFactor = 0.0,
    this.yarnAttnFactor = 0.0,
    this.extraArgs = "",
  });

  static String _triState(dynamic value, bool? legacy, String fallback) {
    if (value is String && ["auto", "on", "off"].contains(value)) return value;
    if (legacy != null) return legacy ? "on" : "off";
    return fallback;
  }

  Map<String, dynamic> toJson() => {
    "server_path": serverPath,
    "model_path": modelPath,
    "served_model_name": servedModelName,
    "hf_token": hfToken,
    "vllm_image": vllmImage,
    "mmproj_path": mmprojPath,
    "n_gpu_layers": nGpuLayers,
    "context_size": contextSize,
    "batch_size": batchSize,
    "ubatch_size": ubatchSize,
    "threads": threads,
    "flash_attn_mode": flashAttnMode,
    "flash_attn": flashAttnMode == "on",
    "cache_type_k": cacheTypeK,
    "cache_type_v": cacheTypeV,
    "host": host,
    "port": port,
    "api_key": apiKey,
    "slots": slots,
    "embeddings": embeddings,
    "reranking": reranking,
    "enable_metrics": enableMetrics,
    "cont_batching_mode": contBatchingMode,
    "cont_batching": contBatchingMode == "on",
    "no_kv_offload": noKvOffload,
    "ml_lock": mlLock,
    "no_mmap": noMmap,
    "rope_freq_base": ropeFreqBase,
    "rope_freq_scale": ropeFreqScale,
    "yarn_ext_factor": yarnExtFactor,
    "yarn_attn_factor": yarnAttnFactor,
    "extra_args": extraArgs,
  };

  factory ServerConfig.fromJson(Map<String, dynamic> json) => ServerConfig(
    serverPath: json["server_path"] ?? "",
    modelPath: json["model_path"] ?? "",
    servedModelName: json["served_model_name"] ?? "",
    hfToken: json["hf_token"] ?? "",
    vllmImage: json["vllm_image"] ?? "vllm/vllm-openai:v0.30.0",
    mmprojPath: json["mmproj_path"] ?? "",
    nGpuLayers: json["n_gpu_layers"] ?? 0,
    contextSize: json["context_size"] ?? 0,
    batchSize: json["batch_size"] ?? 2048,
    ubatchSize: json["ubatch_size"] ?? 512,
    threads: json["threads"] ?? 0,
    flashAttnMode: _triState(
      json["flash_attn_mode"],
      json["flash_attn"] is bool ? json["flash_attn"] as bool : null,
      "auto",
    ),
    cacheTypeK: json["cache_type_k"] ?? "f16",
    cacheTypeV: json["cache_type_v"] ?? "f16",
    host: json["host"] ?? "127.0.0.1",
    port: json["port"] ?? 8080,
    apiKey: json["api_key"] ?? "",
    slots: json["slots"] ?? 1,
    embeddings: json["embeddings"] ?? false,
    reranking: json["reranking"] ?? false,
    enableMetrics: json["enable_metrics"] ?? false,
    contBatchingMode: _triState(
      json["cont_batching_mode"],
      json["cont_batching"] is bool ? json["cont_batching"] as bool : null,
      "auto",
    ),
    noKvOffload: json["no_kv_offload"] ?? false,
    mlLock: json["ml_lock"] ?? false,
    noMmap: json["no_mmap"] ?? false,
    ropeFreqBase: (json["rope_freq_base"] ?? 0.0).toDouble(),
    ropeFreqScale: (json["rope_freq_scale"] ?? 0.0).toDouble(),
    yarnExtFactor: (json["yarn_ext_factor"] ?? 0.0).toDouble(),
    yarnAttnFactor: (json["yarn_attn_factor"] ?? 0.0).toDouble(),
    extraArgs: json["extra_args"] ?? "",
  );

  ServerConfig copy() => ServerConfig.fromJson(toJson());
}

/// 云端连接配置
class CloudConfig {
  String serverUrl;
  String password;

  CloudConfig({this.serverUrl = "", this.password = ""});
}

/// API Key 信息
class ApiKeyInfo {
  String id;
  String name;
  String key;
  String createdAt;
  String? lastUsedAt;
  bool isActive;
  int totalTokens;
  int totalRequests;
  int monthlyTokens;
  int monthlyRequests;
  int tokenLimit;

  ApiKeyInfo({
    required this.id,
    required this.name,
    required this.key,
    required this.createdAt,
    this.lastUsedAt,
    required this.isActive,
    required this.totalTokens,
    required this.totalRequests,
    required this.monthlyTokens,
    required this.monthlyRequests,
    required this.tokenLimit,
  });

  factory ApiKeyInfo.fromJson(Map<String, dynamic> json) => ApiKeyInfo(
    id: json["id"] ?? "",
    name: json["name"] ?? "",
    key: json["key"] ?? "",
    createdAt: json["createdAt"] ?? "",
    lastUsedAt: json["lastUsedAt"],
    isActive: json["isActive"] ?? false,
    totalTokens: json["totalTokens"] ?? 0,
    totalRequests: json["totalRequests"] ?? 0,
    monthlyTokens: json["monthlyTokens"] ?? 0,
    monthlyRequests: json["monthlyRequests"] ?? 0,
    tokenLimit: json["tokenLimit"] ?? 0,
  );
}
