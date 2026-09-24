# 验证记录

## 第三阶段：节点级 llama-server Key 与全栈回归（分支 `feat/llama-b10909-native-bridge`，2026-09-24）

### 通过的检查

| 检查 | 结果 |
| --- | --- |
| `npm --prefix backend run build` | TypeScript 编译通过 |
| `npm --prefix backend test` | 40 项通过；覆盖服务商账户隔离、公共仪表盘隐藏财务字段、管理员凭据轮换时刷新配置并撤销会话、支付宝回调身份/金额精确匹配与幂等处理、Token 结算与长流式请求续期的余额/Token 预留保护、节点 Key 加密/轮换与管理员验证、在线或仍被任意路由引用的节点拒绝删除、无请求体的管理端 DELETE 请求，以及无凭据路由不公开/不转发 |
| `npm --prefix scripts test` | 13 项通过；覆盖节点上游 Key 验证与本地用户 Key 的隔离 |
| `npm --prefix scripts run check:release` | 发布 Bridge 与源码一致 |
| `flutter analyze` | No issues found |
| `flutter test` | 30 项通过 |
| 管理端 Playwright 冒烟 | 使用临时模拟 API 验证节点 Key 配置、拒绝清除仍被路由依赖的 Key、解除依赖后清除和状态刷新；请求体正确，页面无脚本异常 |
| `git diff --check` | 无空白错误 |

### 覆盖边界

- Playwright 使用本地临时 HTTP 服务和模拟 API，没有连接真实 SMTP、支付宝或远程 llama-server。
- 上游节点 Key 的调度与轮换由后端真实 HTTP/WebSocket 夹具验证；没有在本轮连接生产节点或真实 GPU。
- Flutter 源码未修改；本轮执行了静态分析与单元测试，没有重复构建 Windows Release 安装包。

---

## 第二阶段：内置 llama.cpp b10909 引擎（分支 feat/llama-b10909-native-bridge，提交 89fc35b）

环境：Windows 10 x64，RTX 5060 Ti 16GB，Visual Studio 2022 BuildTools 17.14 + VS18.6，CMake 3.28.1，CUDA 13.2，Node.js 24，Flutter 3.44.1 / Dart 3.12.1。

### 通过的检查

| 检查 | 结果 |
| --- | --- |
| 引擎源码构建（`build_llama_windows.py --backends cpu,cuda`） | CPU（16 文件）与 CUDA（17 文件，含全部 GPU 变体）均构建成功并写入 engine.json；`--version` 报告 `0.4.0-dev (build 1, commit a2878d3)` |
| CUDA `--list-devices` | 识别 RTX 5060 Ti（16310 MiB）；CUDA 构建静态链接 cudart/cublas，无外部运行时依赖 |
| Vulkan 官方预编译（`fetch_official_engine.py --backend vulkan`） | SHA-256 与 lock 文件一致（`96b2efab…`）；`--list-devices` 经 NVIDIA Vulkan 驱动识别同一 GPU |
| 真实 GGUF 冒烟（CUDA 与 Vulkan 各一轮，Qwen3.5-4B） | 非流式与流式 `/v1/chat/completions` 均成功：中文 UTF-8 完整、`reasoning_content` 自动分离、`[DONE]` 与 usage 正常；CUDA 约 84 tok/s，Vulkan 约 15 tok/s（含首次着色器编译）。测试后按命令行别名精确结束进程，未影响其他 llama-server，模型文件未修改 |
| `flutter analyze` | No issues found |
| `flutter test` | 31 项通过（服务状态机、健康轮询、日志脱敏、崩溃检测、聊天 SSE/鉴权/取消、档案新字段与旧 Python 档案兼容、引擎设备探测自动选择 N/A 卡/无 GPU/探测失败/手动优先、页签保活与停止生成） |
| `npm --prefix backend test` / `npm --prefix scripts test` | 21 项 / 10 项通过，云端链路未受本次改动影响 |
| `flutter build windows --release` | 退出码 0 |
| 打包（`package_windows.py`） | `OpenMyModel-win-x64-89fc35b`（127 文件）：内置 CPU+CUDA+Vulkan 三引擎、零 Python；build-manifest.json 含 Git revision、引擎元数据与逐文件 SHA-256；打包目录内 llama-server 逐个通过 `--version` |
| 四套引擎/进程清理 | 冒烟进程按唯一别名精确清理，端口关闭确认 |

### 未执行与边界（本阶段新增）

- **旧 Python Bridge 已应用户要求从仓库移除**（含其 31 项历史测试与 venv）；档案文件格式兼容由 Dart `ProfileStore` 测试独立覆盖。第一节中的 Python 检查项为当时的历史记录。
- **Vulkan 后端未在本机源码构建**（缺 Vulkan SDK/glslc），采用官方预编译包并在 lock 文件记录 SHA-256；构建脚本对缺失 SDK 的场景明确报错。
- **AMD/Intel 显卡驱动下的 Vulkan 实际表现未验证**（本机只有 N 卡）；设备探测逻辑有 Widget 级测试覆盖，但真实 A 卡/I 卡行为不在通过项中。
- **打包后的 GUI 完整交互未做桌面自动化验收**（沿用第一阶段限制：Flutter 自绘导航的前台激活被环境拒绝）；组件与服务层分别由测试覆盖。
- **Docker 实际构建仍未执行**（Docker Desktop 未运行）。
- 引擎不会自动更新；升级需重跑构建脚本或 `fetch_official_engine.py`。

---

## 第一阶段：全栈稳定性（分支 optimize/full-stack-stability，提交 15302de）

环境：Windows 10 x64，Node.js 24.16.0，Flutter 3.44.1 / Dart 3.12.1，Python 3.11.9（隔离虚拟环境）及便携 Python 3.13.9。

### 通过的检查

| 检查 | 结果 |
| --- | --- |
| `npm --prefix backend run build` | TypeScript 编译通过 |
| `npm --prefix backend test` | 21 项通过，包括真实 HTTP/WS 和生产 Node Bridge 联调 |
| `npm --prefix scripts test` | 10 项通过 |
| `npm --prefix scripts run check:release` | 源码与发布桥接一致 |
| Python `unittest discover -s python/tests` | 31 项通过，3.11 与 3.13 均验证 |
| `flutter analyze` | No issues found |
| `flutter test` | 10 项通过，包括真实首页页签保活、停止生成及 Flutter→Node 协议测试 |
| `flutter build windows --release` | 退出码 0，成功生成 Windows exe |
| `docker compose config --quiet`（临时测试密码环境变量） | 配置合法 |
| `git diff --check` | 无空白错误 |

共 72 项自动化测试。测试中的端口、Key 和密码均为临时夹具，不调用公网模型，也不读取生产管理员配置。

### 桌面启动检查（当时架构，现已被第二阶段取代）

- 首页读取已有 llama-server 路径和模型目录，GGUF 列表恢复。
- Python Bridge 启动并显示"已就绪，选择模型后启动"；窗口关闭时桥接进程退出、8765 端口不再监听。
- Widget 回归验证真实 HomePage 的 IndexedStack 保留 ChatPage/CloudPage 实例、部分回复和停止生成行为；修复其检测到的参数卡片横向溢出。

### 未执行与边界

- Docker 引擎未运行（`dockerDesktopLinuxEngine` 管道不存在），因此没有执行容器构建、启动或 nginx 运行时测试；没有擅自启动/重启用户 Docker 环境。
- 桌面自动化对 Flutter 自绘导航控件的前台激活被环境拒绝。首页视觉观察、原生窗口按钮操作可用，但未完成整套真实鼠标操作验收。
- 未启动真实 GGUF/GPU 推理，也未测试用户公网云服务器（第二阶段已在本机补做真实推理冒烟）。
- Git 同步只发布源码分支，不等同于部署到已有云服务器或覆盖现有桌面 release 目录。
- GitHub OAuth 缺少 `workflow` 权限，CI 激活文件被远端拒绝；已拆分为本地 `ci/full-stack-verification` 分支提交 `47b3049`，源码分支提供 `docs/ci-workflow.example.yml` 模板。没有更改账号授权。
- 已有用户日志、压缩包、临时脚本和本机配置均保留；未重写 Git 历史或轮换用户密码。
