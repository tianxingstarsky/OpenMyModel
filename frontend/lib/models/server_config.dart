/// llama-server 运行时配置数据模型

class ServerConfig {
  // 必需参数
  String serverPath;
  String modelPath;

  // 多模态
  String mmprojPath;

  // 模型加载
  int nGpuLayers;
  int contextSize;
  int batchSize;
  int ubatchSize;
  int threads;
  bool flashAttn;
  String cacheTypeK;
  String cacheTypeV;

  // 服务
  String host;
  int port;
  String apiKey;
  int slots;
  bool embeddings;

  // 高级
  double ropeFreqBase;
  double ropeFreqScale;
  double yarnExtFactor;
  double yarnAttnFactor;
  bool noKvOffload;
  bool contBatching;
  bool mlLock;
  bool noMmap;
  String extraArgs;

  ServerConfig({
    this.serverPath = "",
    this.modelPath = "",
    this.mmprojPath = "",
    this.nGpuLayers = 99,
    this.contextSize = 128000,
    this.batchSize = 2048,
    this.ubatchSize = 512,
    this.threads = 0,
    this.flashAttn = true,
    this.cacheTypeK = "q8_0",
    this.cacheTypeV = "q8_0",
    this.host = "127.0.0.1",
    this.port = 8080,
    this.apiKey = "",
    this.slots = 1,
    this.embeddings = false,
    this.ropeFreqBase = 0.0,
    this.ropeFreqScale = 0.0,
    this.yarnExtFactor = 0.0,
    this.yarnAttnFactor = 0.0,
    this.noKvOffload = false,
    this.contBatching = false,
    this.mlLock = false,
    this.noMmap = false,
    this.extraArgs = "",
  });

  Map<String, dynamic> toJson() => {
    "server_path": serverPath,
    "model_path": modelPath,
    "mmproj_path": mmprojPath,
    "n_gpu_layers": nGpuLayers,
    "context_size": contextSize,
    "batch_size": batchSize,
    "ubatch_size": ubatchSize,
    "threads": threads,
    "flash_attn": flashAttn,
    "cache_type_k": cacheTypeK,
    "cache_type_v": cacheTypeV,
    "host": host,
    "port": port,
    "api_key": apiKey,
    "slots": slots,
    "embeddings": embeddings,
    "rope_freq_base": ropeFreqBase,
    "rope_freq_scale": ropeFreqScale,
    "yarn_ext_factor": yarnExtFactor,
    "yarn_attn_factor": yarnAttnFactor,
    "no_kv_offload": noKvOffload,
    "cont_batching": contBatching,
    "ml_lock": mlLock,
    "no_mmap": noMmap,
    "extra_args": extraArgs,
  };

  factory ServerConfig.fromJson(Map<String, dynamic> json) => ServerConfig(
    serverPath: json["server_path"] ?? "",
    modelPath: json["model_path"] ?? "",
    mmprojPath: json["mmproj_path"] ?? "",
    nGpuLayers: json["n_gpu_layers"] ?? 99,
    contextSize: json["context_size"] ?? 128000,
    batchSize: json["batch_size"] ?? 2048,
    ubatchSize: json["ubatch_size"] ?? 512,
    threads: json["threads"] ?? 0,
    flashAttn: json["flash_attn"] ?? true,
    cacheTypeK: json["cache_type_k"] ?? "q8_0",
    cacheTypeV: json["cache_type_v"] ?? "q8_0",
    host: json["host"] ?? "127.0.0.1",
    port: json["port"] ?? 8080,
    apiKey: json["api_key"] ?? "",
    slots: json["slots"] ?? 1,
    embeddings: json["embeddings"] ?? false,
    ropeFreqBase: (json["rope_freq_base"] ?? 0.0).toDouble(),
    ropeFreqScale: (json["rope_freq_scale"] ?? 0.0).toDouble(),
    yarnExtFactor: (json["yarn_ext_factor"] ?? 0.0).toDouble(),
    yarnAttnFactor: (json["yarn_attn_factor"] ?? 0.0).toDouble(),
    noKvOffload: json["no_kv_offload"] ?? false,
    contBatching: json["cont_batching"] ?? false,
    mlLock: json["ml_lock"] ?? false,
    noMmap: json["no_mmap"] ?? false,
    extraArgs: json["extra_args"] ?? "",
  );
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