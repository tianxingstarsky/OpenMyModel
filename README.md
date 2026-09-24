# OpenMyModel


> [**English**](README_EN.md) | **中文**
![OpenMyModel](OpenMyModel.png)

> **让本地 GPU 算力走出局域网，以标准 OpenAI API 触达世界。**
>
> OpenMyModel 帮助你将本地运行的 llama.cpp 大模型无缝推送到自有云服务器，通过业界通用的 OpenAI 兼容接口对外提供服务。无论你是有闲置 GPU 的个人开发者、想折腾自部署模型的技术爱好者，还是需要为小团队搭建私有推理节点的运维者，这里都有你所需的一切——无需公网 IP，无需复杂运维，一条 WebSocket 隧道即可将本机模型变为云端 API。
>
> #### 为什么自己部署？
> 免费在线大模型虽触手可及，却几乎都经过过度量化——提供给你的是智力"降级版"。我实测对比：一台消费级显卡上跑 **Qwen 3.5 9B INT8**，在逻辑推理和数学推导上明显优于所谓"旗舰级"的免费在线服务。免费 API 为了成本极致压缩，你拿到的其实只是同名模型的一张影子。而当你自己掌控精度和参数，每一轮推理都在真实权重上完成，体验的差距会超出你的预期。
>
> #### 不止自用，更可共享与变现
> OpenMyModel 同时支持个人节点共享与服务商运营：管理员可配置模型路由、节点凭据和统一 API Key；服务商模式提供邮箱验证码登录、支付宝充值、余额扣费以及按输入/输出 Token 统计。

**将本地 llama.cpp 算力通过 WebSocket 隧道暴露到云端，以 OpenAI 兼容 API 供外部调用。**

> 你的 GPU，你的模型，你自己的 API 服务 —— 无需公网 IP。

---

## 🏗 架构总览

```mermaid
flowchart LR
    subgraph 本地机器
        A[Flutter 桌面端<br/>InferenceService 直接管理进程] --> C[llama-server<br/>内置 llama.cpp b10909<br/>本地 GPU 推理]
        A --> N[Node Bridge<br/>本地密钥校验]
        N --> C
    end

    subgraph 云端服务器
        D[云后端<br/>Fastify + WebSocket] --> E[OpenAI 兼容 API<br/>管理员 / 用户]
    end

    subgraph 外部调用者
        E --> F[Open WebUI]
        E --> G[ChatGPT 客户端]
        E --> H[任意 OpenAI SDK]
    end

    D <== WebSocket 隧道 ==> N
```

### 组件职责

| 组件 | 技术栈 | 角色 |
|------|--------|------|
| **Flutter 桌面端** | Flutter + Dart | UI 界面 / 内置 llama-server 进程管理（启动、健康检查、停止）/ API Key 管理（本地存储+本地验证）/ 模型对话（直连引擎 OpenAI API） |
| **内置引擎** | llama.cpp b10909（Git submodule 固定版本） | 官方 OpenAI 兼容 HTTP API；CPU/CUDA 后端源码构建，Vulkan 后端官方预编译（均经 SHA-256 校验），按显卡自动选择，无需安装 Python 或任何运行环境 |
| **Node Bridge** | Node.js + ws | Flutter stdin/stdout 控制 / 本地 Key 验证 / WebSocket HTTP 隧道 |
| **云后端** | TypeScript + Node.js | WebSocket 服务端 / 节点密钥加密托管与模型调度 / OpenAI 兼容网关 / 管理面板 |

> 历史说明：早期版本通过一个本地 Python HTTP 桥管理 llama-server；当前版本已由 Dart 的
> `InferenceService` 直接管理引擎进程，无需安装 Python，旧桥代码已从仓库移除
> （需要查阅历史实现请翻看 Git 历史）。

---

## ✨ 核心特性

- **📦 内置推理引擎**：llama.cpp b10909 随应用分发（CPU/CUDA 源码构建 + Vulkan 官方预编译，均经 SHA-256 校验），启动即用，无需安装 Python；按真实硬件自动选择后端，N 卡/A 卡/I 卡都能用上 GPU
- **🖥 本地 GPU 推理**：完整 llama.cpp 参数（GPU 层数 auto/all、`--fit` 显存自适应、KV 量化、Flash Attention 三态开关）
- **🌐 WebSocket 隧道**：无需公网 IP，家庭主机也能上云；断线自动有界退避重连，主动断开不重连
- **🔑 本地密钥管理**：API Key 持久化在本机，云端不持久化；验证时仍经过云后端和隧道，生产环境必须使用 HTTPS/WSS，并保护本机用户数据。
- **🔄 OpenAI 兼容 API**：`/v1/chat/completions`、`/v1/models`，支持流式 (SSE)；思考型模型的 `reasoning_content` 在对话界面单独展示
- **🖼 多模态支持**：mmproj 视觉投影，图片识别能力
- **💬 内置对话界面**：多图上传 + 文字，流式响应，停止生成即断开底层连接
- **📦 参数档案**：配置档案本地保存（兼容旧版本导出的档案文件），一键切换
- **📊 公共状态页**：访问云后端首页即见在线节点、并发容量/使用率、吞吐速度和各模型并发，仅公开聚合信息
- **🧭 管理与调度**：`/admin` 配置节点、模型别名、上游模型名、必填的 `llama-server --api-key`、调度权重、统一 API Key、调用统计和用户订单；节点 Key 在服务器加密保存并只经隧道发送给对应节点
- **📈 个人模式**：不开放用户注册；管理员创建统一 API Key，`/dashboard` 无需登录即可查看聚合状态；也可继续用桌面端节点 Key 直接访问节点
- **💼 服务商模式**：管理员完成 HTTPS 公网地址、SMTP 邮箱及支付宝应用 ID、商户 ID、RSA2 私钥/支付宝公钥配置后才能启用；用户通过邮箱验证码注册/登录，在 `/console` 管理自己的 API Key、用量和订单并充值。按输入/输出 Token 单价计费，不包含缓存 Token 单独定价
- **🔐 分层 API Key**：节点 Key 由 `llama-server --api-key` 保护本机 HTTP；网关 Key 用来识别外部调用者、限流和计量。网关 Key 只显示一次，服务器保存其哈希。服务商模式只接受绑定用户账户的网关 Key；切换运营模式后，个人模式下创建的无归属 Key 会被拒绝调用
- **🛠 中文 CLI**：云后端通过向导式命令行完成初始化和管理
- **⚡ 实时状态**：引擎启动/加载/就绪/错误状态、云端连接状态实时跟踪


## 📸 界面截图

### 首页 — 模型配置与启动
![首页](首页.png)

### 云端连接 — API Key 管理与节点状态
![云端连接](云端连接.png)

---
## 📂 目录结构

```
output_my_model/
├── frontend/                 # Flutter 桌面应用
│   ├── lib/
│   │   ├── main.dart         # 入口
│   │   ├── models/           # 数据模型
│   │   ├── pages/            # 页面（首页/配置/对话/云端）
│   │   ├── services/         # InferenceService / WebSocket / 配置档案
│   │   └── widgets/          # UI 组件
│   ├── windows/              # Windows 平台文件
│   ├── pubspec.yaml
│   └── pubspec.lock
├── third_party/llama.cpp/    # llama.cpp b10909（Git submodule，固定版本）
├── third_party/llama.cpp.lock.json  # 版本锁定与官方预编译包 SHA-256
├── backend/                  # TypeScript 云后端
│   ├── src/
│   │   ├── index.ts          # Fastify + WebSocket 入口
│   │   ├── cli.ts            # 中文 CLI 交互
│   │   ├── config.ts         # 配置文件管理
│   │   ├── db/               # 数据库层 (SQLite)
│   │   ├── routes/           # API 路由
│   │   │   ├── openai.ts     # OpenAI 兼容代理
│   │   │   └── admin.ts      # 管理接口
│   │   └── services/         # 业务服务
│   │       ├── websocket.ts  # WebSocket 连接池
│   │       └── auth.ts       # 认证
│   ├── data/                 # 运行时数据（不提交）
│   ├── package.json
│   └── tsconfig.json
├── scripts/                  # 工具脚本（引擎构建 / 打包 / 云端桥接）
│   ├── build_llama_windows.py
│   ├── package_windows.py
│   ├── cloud_bridge.js
│   └── mock_node.js          # 模拟节点（测试用）
├── docs/                     # 文档与截图
├── OpenMyModel.png                 # README 头图
├── logo.png                  # 应用图标
├── LICENSE
└── README.md
```

---

## 🚀 快速开始

### 环境要求

- **桌面端（发布包）**：Windows 10+，无需安装 Python；CPU/CUDA/Vulkan 引擎随包内置，自动按显卡选择后端
- **从源码构建桌面端**：Flutter 3.x+、CMake 3.28+、Visual Studio 2022 C++ 工具集（CUDA 后端另需 CUDA toolkit；Vulkan 后端另需 Vulkan SDK）
- **Node.js** 22+（云后端与本地云端桥接）
- **模型文件**（GGUF 格式，如 Qwen 3.5 9B Q8）+ 可选 mmproj 文件

### 1. 桌面端 (Windows)

```bash
npm --prefix scripts ci            # 云端 Node 桥接依赖
cd frontend
flutter pub get
flutter run -d windows
```

引擎可从源码构建并放置到 `artifacts/engine/`（打包脚本会自动收集）：

```bash
python scripts/build_llama_windows.py --backends cpu,cuda
python scripts/fetch_official_engine.py --backend vulkan   # 无 Vulkan SDK 时用官方预编译包
```

### 2. 云后端

```bash
cd backend
npm ci
npm run setup                      # 首次配置管理员密码
npm run dev                        # 默认端口 3000
```

### 3. CLI 管理（云后端）

```bash
cd backend
npm run setup
```

向导式设置域名、密码、查看节点状态。

---



## ☁️ 云后端部署指南（宝塔面板）

> 在云服务器上通过宝塔面板部署 OpenMyModel 后端，三步完成。

### 前置条件

- 云服务器（1核2G起步）+ 已备案域名 DNS 已解析
- 宝塔面板已安装
- 安全组已开放 80/443 端口
- 软件商店已安装：**Nginx**、**Node.js版本管理器**、**PM2管理器**

---

### 第一步：服务器编译部署

```bash
ssh root@你的服务器
cd /aiapi
git clone https://github.com/tianxingstarsky/OpenMyModel.git backend
cd backend/backend

# 安装依赖并编译
npm install
npm run build
```

> ⚠️ `npm install` 必须在服务器上执行（`better-sqlite3` 是原生模块，需 Linux 编译）。
> 如果报 `NODE_MODULE_VERSION` 错误：`rm -rf node_modules && npm install`

---

### 第二步：宝塔 Node 项目启动

「网站」→「Node项目」→ 添加项目：

| 设置项 | 值 |
|--------|-----|
| 项目目录 | `/aiapi/backend/backend` |
| 启动文件 | `dist/index.js` |
| 项目名称 | `openmymodel` |
| 运行端口 | `3000` |

**关键**：Node版本选择栏里选你安装的 **v22.x**（不是系统默认的旧版本）。

首次启动前设置项目环境变量 `ADMIN_PASSWORD`，或在 `backend/` 运行 `npm run setup` 创建管理员密码。服务不会把密码打印到日志。

> 已存在的 `data/config.json` 会保留；修改环境变量不会覆盖原密码。重置密码请使用 `npm run setup`，不要删除数据库。

---

### 第三步：反向代理配置

「网站」→顶部「反向代理」页 → 添加反向代理：

| 设置项 | 值 |
|--------|-----|
| 域名 | `api.your-domain.com` |
| 目标URL | `http://127.0.0.1:3000` |
| 发送域名 | `$host` |

然后编辑该站点的 Nginx 配置文件，在 `location /` 块中确保包含：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 600s;
proxy_buffering off;
```

并在文件最外层（`server` 块之前）添加：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

---

### 验证

浏览器访问 `http://你的域名/`，返回 JSON 即成功。

---

### 更新代码

```bash
cd /aiapi/backend/backend
git pull && npm install && npm run build
```
然后在宝塔 Node 项目中点击「重启」。

---

### 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 启动闪退 | 源码未编译或 Node 版本不对 | `npm run build`，Node 选 v22 |
| `NODE_MODULE_VERSION` | 本机带了 node_modules | 服务器上 `rm -rf node_modules && npm install` |
| WebSocket 闪断 | Nginx 缺 Upgrade 头 | 加上 `proxy_set_header Upgrade $http_upgrade;` |
| 域名不通 | 反向代理目标 IP 错误 | 确保是 `http://127.0.0.1:3000` 不是 `172.0.0.1` |
| API Key 401 | 密钥未启用或不属于在线节点 | 检查密钥所属桌面节点在线且已启用该 Key，无需盲目重建 |
| 首次启动拒绝运行 | 尚未配置管理员密码 | 设置 `ADMIN_PASSWORD` 或运行 `npm run setup` |
| 桥接协议错误 | 桌面与云端版本不匹配 | 同时更新云后端和桌面的 Node 桥接 |


---

## 🔐 安全设计

```
个人模式直连：桌面端 API Key 或节点 `--api-key` → 对应节点桥接校验 → llama-server
统一网关调用：网关 API Key → 云后端鉴权/限流/计量 → 选择公开模型路由
  → 解密该路由的节点 Key → 隧道转发 → 节点桥接以 Bearer Key 调用 llama-server

节点 Key 是保护节点 HTTP 服务的凭据，与调用者的网关 Key 分开管理。节点 Key 使用服务器本地密钥加密后保存在数据库；网关 Key 只保存哈希。生产环境应使用 HTTPS/WSS，并保护服务器数据目录和密钥文件。
```

管理入口：`/admin`；个人模式公开仪表盘：`/dashboard`；服务商用户控制台：`/console`。服务商模式须先在管理端配置 HTTPS 公网地址、SMTP 和支付宝应用参数，配置完整后才能启用；支付宝回调地址使用该规范公网地址，不依赖请求 Host。

服务商模式会在推理前调用所选节点的 `/apply-template` 与 `/tokenize` 计算文本输入 Token，并原子预留输入费用和输出上限费用；结算时按节点返回的实际用量扣款并释放未使用余额。调用未指定 `max_tokens` 时，输出上限会按可用余额自动缩小，单个候选默认最多 4096 Token；用户显式指定时最多允许 65,536 个总输出 Token。服务商预扣目前支持纯文本聊天消息，多模态消息会在推理前被拒绝。节点需使用支持这两个接口的 llama-server。

---

## 🔗 使用示例

### 配置 Open WebUI

在 Open WebUI 中添加 OpenAI 兼容连接：

- **API URL**: `https://你的域名/v1`
- **API Key**: 前端生成的 `sk-` 开头密钥

### curl 测试

```bash
curl https://你的域名/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-你的密钥" \
  -d '{"model":"qwen","messages":[{"role":"user","content":"你好"}]}'
```

---

## 开发验证与发布

请参阅 [开发、测试与发布说明](docs/DEVELOPMENT.md)，包括中继协议、内置引擎构建、故障排查、自动化测试和 Windows 可追溯打包。更新时应同时部署后端和桌面桥接，旧桥接不会提供正确的上游状态码。

```bash
npm --prefix scripts ci
npm --prefix scripts test
npm --prefix scripts run check:release
npm --prefix backend ci
npm --prefix backend run build
npm --prefix backend test
cd frontend && flutter analyze && flutter test && flutter build windows --release
python scripts/build_llama_windows.py --backends cpu,cuda   # 内置引擎源码构建
python scripts/package_windows.py --output artifacts/OpenMyModel-win-x64-<rev>
python scripts/make_installer.py --payload artifacts/OpenMyModel-win-x64-<rev>   # 可选：生成安装包
```

Docker 首次启动前将 `.env.example` 复制为 `.env` 并填写强密码，再运行 `docker compose up -d --build`。公网部署请在反向代理终止 TLS，并使用 `https://` 地址连接桌面端；节点桥接只允许本机回环地址使用明文连接，远程连接必须使用 TLS，以保护节点认证信息、llama-server API key 和推理数据。仓库内 nginx 示例本身不提供证书。

## 📝 许可证

MIT License — 详见 [LICENSE](LICENSE)

---

## 🙏 鸣谢

- [llama.cpp](https://github.com/ggerganov/llama.cpp) — GGUF 推理引擎
- [Open WebUI](https://github.com/open-webui/open-webui) — 对话前端参考
- [unsloth](https://github.com/unslothai/unsloth) — 参数设计灵感

