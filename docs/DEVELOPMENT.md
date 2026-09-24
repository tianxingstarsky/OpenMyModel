# 开发、验证与发布

## 架构与行为约定

- Flutter 通过 `InferenceService`（`frontend/lib/services/inference_service.dart`）直接管理内置 llama-server 子进程：启动、日志采集（有界、脱敏）、`/health` 轮询、`/props` 能力读取、崩溃检测和停止。只终止自己启动的进程，不按端口或进程名杀进程。
- 引擎来源固定：`third_party/llama.cpp` Git submodule 锁定 b10909（提交 `a2878d30df0130dde503a7d9ba30d3d21bd71b9f`），元数据在 `third_party/llama.cpp.lock.json`（含官方预编译包 SHA-256 备选）。
- 本地聊天由 Flutter 直连引擎官方 OpenAI 兼容 API（`/v1/chat/completions` SSE），不再经过任何本地 HTTP 代理；停止生成即关闭底层连接。
- 配置档案由 Dart `ProfileStore` 直接读写 `%USERPROFILE%\.openmymodel\profiles`，兼容旧版本导出的档案文件（旧布尔字段自动映射为三态 `auto/on/off`）。
- Node Bridge 从 Flutter 接收桌面端调用密钥和连接配置，通过 WebSocket 连接云后端。桌面端 Key 仍由本机桥接校验；认证请求中的 Key 会经过云端内存。
- 管理端按节点保存与 `llama-server --api-key` 一致的节点 Key，并以服务器数据目录中的 AES 密钥加密；同一节点的所有模型路由共用此 Key，旧版逐路由 Key 继续作为回退。统一网关 Key 只保存 HMAC 哈希，原始 Key 创建时仅显示一次。
- 管理端可移除已断开的历史节点；节点仍在线，或仍被启用/停用模型路由引用时，服务器会拒绝删除。节点表显示全部路由引用数，提示管理员先清理路由。
- 云后端使用 Fastify；统一网关调用按公开模型别名选择在线节点路由，将该路由的上游模型名和节点级 Key 经隧道转发；没有节点级 Key 时兼容使用历史路由级 Key。不会把用户对话广播到其他节点。
- `/admin` 是管理员面板；个人模式的 `/dashboard` 无需登录并只展示聚合数据；服务商模式的 `/console` 需要邮箱验证码登录，用户可设置自己 API Key 的每分钟请求和 Token 总量限额。
- 云端只承诺 `/v1/models` 和 `/v1/chat/completions`，不是完整 OpenAI API 实现。引擎本地的其他端点（`/props`、`/slots`、`/metrics` 等）属于引擎原生能力，未全部透出云端。
- 服务端网关会记录上游返回的输入/输出 Token、费用、请求次数和每分钟频率；服务商模式按输入/输出每百万 Token 计价并从账户余额扣除，流式请求会启用 `stream_options.include_usage` 获取 usage。活动推理有余额或 Token 预留时，服务端每 5 分钟独立续期，上游数据块到达时也会尝试续期；无输出时仍由 2 分钟空闲超时结束请求，服务重启后未结算的预留会在租期后释放。若上游未返回输出 usage，会调用同一节点的 `/tokenize` 计量已生成的文本（包括客户端断开前已收到的部分）；该补偿也不可用时会记录错误并按节点已报告的 Token 结算。个人模式的公开聚合仪表盘也统计经云端网关转发的节点 Key 调用；这类调用使用服务器密钥生成的 HMAC 标识归档并按上游报告计量，不扣余额。完全绕过云端网关直连 `llama-server` 的请求无法纳入云端统计。
- 服务商模式需要管理员先配置 HTTPS 公网地址、SMTP、支付宝应用 ID、商户 ID、应用私钥和支付宝公钥；充值回跳和异步通知只使用这项规范地址，不信任请求 Host。支付宝充值、推理扣费和人工余额调整在同一事务中写入账户余额流水，人工调整必须填写原因；客服调低余额时不能低于正在执行推理请求的余额预留。支付宝异步通知校验 RSA2 签名、应用/商户身份，并要求回调金额为两位小数且按分与订单金额精确匹配，再按订单状态幂等入账。完整会话历史仍只保留在当前桌面应用会话中。
- 旧 Python Bridge 代码已从仓库移除（历史实现见 Git 历史）；桌面运行链路不使用 Python。

## 中继协议 v2

后端和桌面 Node Bridge 必须一起更新。`scripts/cloud_bridge.js` 是事实源，`release/scripts/cloud_bridge.js` 是受一致性测试保护的发布副本。

1. Bridge 发送 `auth`（包含 `protocolVersion: 2`、节点信息和可选 `serverRunning`），云端回复 `auth_ok`。
2. 网关调用者认证使用 `validate_key` / `key_valid`；它可匹配本地用户 Key 或节点自己的 llama-server Key。管理员验证已保存的节点上游凭据时使用 `validate_upstream_key` / `upstream_key_valid`，只检查当前节点配置的 llama-server Key，不接受本地用户 Key，且 API 响应不返回密钥。
3. 转发使用 `http_relay { requestId, path, method, body, upstreamApiKey? }`。个人模式的桌面 Key 调用不发送覆盖值，Bridge 沿用本机配置的 llama-server Key；管理端路由则传入该节点加密保存的上游 Key；历史版本逐路由保存的 Key 仍可用作回退。
4. 上游响应先发送 `http_headers { requestId, statusCode, headers }`，再发送任意数量的 `http_chunk { requestId, data }`，最后发送 `http_done`。
5. 转发错误使用 `http_error { requestId, statusCode, message }`。响应头尚未发送时返回对应 HTTP 错误；响应开始后发生错误，中断连接，不伪造成功结束。
6. 客户端取消、空闲超时或节点断线都会关闭上游请求。取消消息为 `cancel_request { requestId }`。

`http_chunk.data` 是连续 UTF-8 文本，不能按换行过滤空行，不能改写 `reasoning_content`，不能加入默认 `max_tokens`。Node 的 UTF-8 解码器会缓存多字节字符的半字节片段。上游请求使用 `Accept-Encoding: identity`；不接受未经解码的压缩响应。流式路径不累积完整生成文本；慢连接有有界缓冲保护。

`auth` 与 `status_update` 支持可选整数字段 `slots`（引擎 `-np` 并发槽位，0-1024）。旧桌面端不上报时后端视为"容量未知"，状态页显示"未上报"；字段非法按未上报处理，不会断开连接。

## 公共状态页

后端 `/` 返回自包含的深色状态页（无外链资源），`/status.json` 为机器可读数据，原接口清单 JSON 移至 `/api`。展示内容仅限公开聚合：在线节点数、并发容量/使用中与使用率、排队数、近期吞吐（完成请求输出流量的 EWMA，字节/秒）、累计请求与转发量、每个模型的节点数/并发/就绪状态。不包含节点 ID、名称、地址、密钥或对话内容。语义：并发容量 = 该模型**就绪节点**（`serverRunning`）上报的 `-np` 槽位总和，加载中的节点不计；进行中请求由后端中继计数实时统计；超过槽位的在途请求会被 llama-server 排进自身队列，状态页将其显示为"排队"（`max(0, 进行中 - 容量)`），使用率条过载时转为橙色渐变。

## 内置引擎构建

```bash
# 初始化 submodule（浅克隆足够构建）
git submodule update --init third_party/llama.cpp

# CPU 必建；CUDA 需要 nvcc；Vulkan 需要 Vulkan SDK（glslc），缺失会明确报错而不是静默跳过
python scripts/build_llama_windows.py --backends cpu,cuda
# 可选: --cuda-architectures native|all-major|86;89;120  --jobs N  --out artifacts/engine
```

- 构建使用 `GGML_BACKEND_DL=ON` + `GGML_CPU_ALL_VARIANTS=ON`（与官方发布一致的运行时选优布局），产物为 `artifacts/engine/llama-<tag>-<backend>-x64/`（llama-server.exe 与全部 ggml DLL 同目录）。
- 每个引擎目录写入 `engine.json`：tag、commit、后端、CMake 配置、工具链版本、`--version` 输出与逐文件 SHA-256。桌面端启动时读取该文件显示真实引擎版本/后端。
- 生成器优先使用 Visual Studio 2022（CMake VS 生成器，无需 vcvars）；找不到时退回 Ninja + vcvars64，并用净化过的 PATH 规避机器 PATH 中含括号条目导致的 cmd 批处理解析错误。
- CUDA 构建静态链接 cudart/cublas，产物自包含，不需要额外复制 CUDA 运行时 DLL。
- 打包也可使用官方预编译引擎备选：`third_party/llama.cpp.lock.json` 记录了 b10909 Windows x64 CPU/CUDA/Vulkan 包的 SHA-256；运行时不会自动下载或更新引擎。

无法从源码构建某个后端时（例如本机没有 Vulkan SDK），可显式获取官方预编译引擎——脚本会下载、按 lock 文件校验 SHA-256、解压并写入 `builtFrom: official-prebuilt` 的 `engine.json`：

```bash
python scripts/fetch_official_engine.py --backend vulkan
# 可选: --backend cpu|cuda-12.4|cuda-13.3  --force 替换已存在目录
```

桌面端自动选择引擎时先用 CPU 兜底，再按优先级（CUDA > Vulkan）逐个运行 `--list-devices` 探测真实硬件：只有报告了对应 GPU 设备的后端才会被选中，避免 A 卡/I 卡机器误选 CUDA 引擎静默跌回 CPU。用户在首页手动切换或恢复上次选择后，探测不再覆盖。

## 本地开发

要求 Node.js 22+，以及满足 `frontend/pubspec.yaml` 中 Dart SDK 范围的 Flutter stable。Windows 桌面构建另需 Visual Studio 2022 的 Desktop development with C++；引擎源码构建另需 CMake 3.28+（CUDA/Vulkan 后端见上文）。

```bash
npm --prefix scripts ci
npm --prefix backend ci
```

在 `backend/` 运行 `npm run setup` 初始化管理员密码，然后 `npm run dev`。也可以在第一次启动前设置 `ADMIN_PASSWORD`；已有配置不会被环境变量覆盖。数据目录默认是后端当前工作目录的 `data/`，可用 `OPENMYMODEL_DATA_DIR` 指向隔离测试目录。

在 `frontend/` 运行 `flutter pub get` 和 `flutter run -d windows`。桌面端自动发现引擎：exe 旁 `runtime/llama/`（打包布局）与开发布局 `artifacts/engine/`，启动时按真实硬件自动选择后端（CUDA > Vulkan > CPU）。开发机上无需 Python；如需运行历史 Python 兼容测试，见下文自动化门禁。

### 生命周期与安全

- `InferenceService` 串行化启动/停止；相同配置重复启动幂等，不同配置需先停止。进程在启动或就绪后退出会进入 `error` 状态并保留日志尾部。
- 引擎命令行在 Dart 侧构建（`InferenceService.buildArgs`）：`-ngl` 支持 `all/auto/精确层数`，`-lm` 承载 mlock/no-mmap，`extra_args` 禁止覆盖 `--host/--port/--api-key`。
- 日志环形缓冲有界（500 行 × 2000 字符），API Key 在日志中脱敏。
- 云端断线由桌面页执行有界指数退避重连（2/4/8/16/32 秒，最多 5 次）；用户主动断开后不自动重连。
- 管理员通过 CLI 重置密码或重新初始化凭据时，先撤销全部管理员会话；服务商用户会话保持不变。
- 云端 `/api/` 响应统一设置 `Cache-Control: private, no-store`，避免共享设备或 HTTP 缓存保留管理员和用户账户数据。
- 网关每次鉴权都会在 SQLite 立即事务中重新读取 Key、账户启用状态、Token 限额和 RPM 限额，再记录访问事件；不使用请求开始时的旧 Key 快照执行限额判断。
- 密码和 API Key 仍属于本地敏感用户数据，不是操作系统密钥库加密存储；应保护 Windows 用户目录。

## 自动化门禁

从仓库根目录执行：

```bash
npm --prefix scripts test
npm --prefix scripts run check:release
npm --prefix backend run build
npm --prefix backend test
```

从 `frontend/` 执行：

```bash
flutter analyze
flutter test
flutter build windows --release
```

Flutter 测试覆盖：`inference_service_test.dart`（命令行构建、状态机、健康轮询、日志脱敏、崩溃检测、停止、聊天 SSE/鉴权/取消、幂等启动）、`profile_store_test.dart`（新字段 round-trip、旧 Python 档案兼容、名称校验）、`navigation_test.dart`（页签保活、部分回复保留、停止生成断开连接）、`bridge_services_test.dart`（SSE 解码、云 URL 规范化、旧桥接回归）、`websocket_service_test.dart`。

[CI 工作流模板](ci-workflow.example.yml) 可放入 `.github/workflows/verify.yml`，在 push/PR 上验证三层代码，并在 Windows runner 上编译桌面端。当前 GitHub OAuth 凭据缺少 `workflow` 权限，源码分支未包含激活的工作流；完整工作流保留在本地 `ci/full-stack-verification` 分支（提交 `47b3049`）。后端和 Bridge 测试使用临时端口及假上游，不需要真实模型/GPU，也不使用现有管理员密码或数据目录。

手工 WS 探针可以使用环境变量 `ADMIN_PASSWORD` 和 `CLOUD_WS_URL` 运行根目录 `test_ws.dart`。`scripts/mock_node.js` 使用生产桥接实现，要求 `ADMIN_PASSWORD`、`TEST_API_KEY`，可选 `CLOUD_URL`、`LLAMA_URL`、`LLAMA_API_KEY`、`MODEL_NAME`，不再内置任何可用密码。

## Windows 发布

1. 完成所有测试，并确认 `flutter build windows --release` 以退出码 0 成功。旧 exe 存在不能证明本次构建成功，CMake INSTALL 失败也不能被忽略。
2. 构建/更新内置引擎：`python scripts/build_llama_windows.py --backends cpu,cuda`，确认 `artifacts/engine/llama-<tag>-<backend>-x64/engine.json` 中的版本与 SHA-256。
3. 执行 `npm --prefix scripts run sync:release`，然后 `check:release`；勿手工只修改 release 下的 JS。
4. 准备便携 `node.exe`（云端桥接用，默认 `release/scripts/node.exe`，可用 `--node` 覆盖）。新包**不再包含 Python 运行时**。
5. 创建一个全新输出目录：

```bash
python scripts/package_windows.py --output artifacts/OpenMyModel-win-x64-native
# 可选: --engines cpu,cuda 按目录名筛选；--flutter/--node 指定路径
```

打包器会先重新执行 Flutter Release 构建并检查退出码，将**本次 Flutter 构建、指定引擎目录、Node Bridge 和 ws 依赖**放入新目录（引擎位于 `runtime/llama/`）；拒绝覆盖任何现有输出，且不会修改用户的 release 树。它排除日志、缓存和 PDB，并记录 `build-manifest.json`（Git revision、工作区是否有改动、引擎元数据、逐文件 SHA-256）。打包后仍需启动该目录的 exe 验证。

6. **发布**：GitHub Release 只发布签名安装包，不再上传便携 ZIP。生成后用 gh 发布：

```bash
python scripts/make_installer.py --payload artifacts/OpenMyModel-win-x64-<rev>   --sign-pfx artifacts/codesign/openmymodel-selfsign.pfx   --sign-password-file artifacts/codesign/pfx-password.txt
gh release create v<版本> artifacts/OpenMyModel-Setup-1.0.0-<rev>.exe   --title "OpenMyModel v<版本>" --notes-file notes.md
```

```bash
python scripts/make_installer.py --payload artifacts/OpenMyModel-win-x64-<rev>
# 需要 ISCC.exe（winget install --id JRSoftware.InnoSetup -e），或 --iscc 指定路径
```

安装包按用户级安装（无需管理员），默认目录 `%LOCALAPPDATA%\Programs\OpenMyModel`，含开始菜单/桌面快捷方式与卸载器；卸载不触碰用户数据（配置档案在 `%USERPROFILE%\.openmymodel`，偏好在 `%APPDATA%`）。

**代码签名（自签名）**：两个脚本都支持 `--sign-pfx <pfx> --sign-password-file <file>`。生成自签名证书并导入本机信任（仅本机显示"已验证"，SmartScreen 仍按文件声誉提示，私签不能消除）：

```powershell
New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=OpenMyModel Self-Signed, O=OpenMyModel' `
  -KeyUsage DigitalSignature -KeyExportPolicy Exportable -KeyLength 3072 `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5)
# 导出 PFX/CER 后，在本机信任：
Import-Certificate -FilePath openmymodel-selfsign.cer -CertStoreLocation Cert:\CurrentUser\Root
Import-Certificate -FilePath openmymodel-selfsign.cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
```

当前本机证书指纹 `14BDE1CB7F61CABA83B8640B7B9963C51C3C1C52`，PFX/密码保存在 `artifacts/codesign/`（不入库）。签名默认不带 RFC3161 时间戳（本机网络到各时间戳服务器的 POST 被拦）；私签场景时间戳非必需——需要时传 `--timestamp-url`。正式分发请购买 CA 证书后用同样的参数替换。

## 部署注意事项

- Docker 从 `.env` 读取明确配置的 `ADMIN_PASSWORD`，不再内置通用默认密码。将 `.env.example` 复制后填写，不要提交 `.env`。
- 旧 SHA-256 密码在成功认证时升级为 scrypt。格式不合法的哈希会认证失败而非抛出异常。
- 公网必须配置 TLS，在桌面填写 `https://域名`，桥接会使用 WSS。仓库 nginx 示例只提供 HTTP 反向代理，不自动签发证书。
- 后端请求体上限为 32 MiB；图片经 base64 后会变大，桌面有更小的附件上限。
- 代码更新与运行中的服务器部署是两件事。Git push 不会自动更新宝塔、Docker 实例或已经下载的桌面包。
- 历史版本可能已把 Key 前缀或默认密码写入日志/Git 历史。本次不会擅自删除用户日志或重写历史；实际使用过的旧凭据应由管理员轮换。

## 故障排查

| 现象 | 检查方向 |
| --- | --- |
| 首页显示"未发现引擎" | 检查安装目录 `runtime/llama/` 是否完整（各引擎目录含 llama-server.exe 与 engine.json），修复后重启应用即可重新发现 |
| 模型正在加载但聊天不可用 | 等待 `ready`，查看运行日志；加载超时有明确报错，不要重复点击启动 |
| CUDA 引擎启动失败 | 查看 `error` 状态的日志尾部；可在首页切换回 CPU 引擎再启动 |
| 云端 401 | 检查 Key 启用状态及所属节点在线状态 |
| 云端 502 / protocol error | 检查后端和 Node Bridge 是否同时升级 |
| 云端 504 | 检查上游是否长时间没有响应，以及模型加载/推理状态 |
| 云端反复自动重连 | 退避 2→32 秒共 5 次；主动"断开"后不会再自动重连 |
| Windows 构建 CMake 失败 | 阅读失败步骤并修复，不能用历史 Release 目录冒充成功构建 |
