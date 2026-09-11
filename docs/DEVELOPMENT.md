# 开发、验证与发布

## 架构与行为约定

- Flutter 管理自己的 Python Bridge 子进程和 Node Bridge 子进程。切换首页、对话、云端页不会重建业务状态。
- Python Bridge 只监听 `127.0.0.1:8765`，管理自己的 llama-server，并代理本地聊天。进程存在不代表模型已经加载完成；`running` 与 `ready` 是不同状态。
- Node Bridge 从 Flutter 接收配置和密钥，通过 WebSocket 连接云后端。云端不持久化 API Key，但认证请求中的 Key 会经过云端内存。
- 云后端使用 Fastify，并按 Key 所属在线节点选择转发目标。不会把用户对话广播到其他节点。
- 云端只承诺 `/v1/models` 和 `/v1/chat/completions`，不是完整 OpenAI API 实现。
- Token 配额、用量计费、持久聊天历史尚未实现。聊天记录只在当前应用会话中保留。

## 中继协议 v2

后端和桌面 Node Bridge 必须一起更新。`scripts/cloud_bridge.js` 是事实源，`release/scripts/cloud_bridge.js` 是受一致性测试保护的发布副本。

1. Bridge 发送 `auth`（包含 `protocolVersion: 2`、节点信息和可选 `serverRunning`），云端回复 `auth_ok`。
2. 请求认证使用 `validate_key` / `key_valid`；密钥由本机校验。
3. 转发使用 `http_relay { requestId, path, method, body }`。
4. 上游响应先发送 `http_headers { requestId, statusCode, headers }`，再发送任意数量的 `http_chunk { requestId, data }`，最后发送 `http_done`。
5. 转发错误使用 `http_error { requestId, statusCode, message }`。响应头尚未发送时返回对应 HTTP 错误；响应开始后发生错误，中断连接，不伪造成功结束。
6. 客户端取消、空闲超时或节点断线都会关闭上游请求。取消消息为 `cancel_request { requestId }`。

`http_chunk.data` 是连续 UTF-8 文本，不能按换行过滤空行，不能改写 `reasoning_content`，不能加入默认 `max_tokens`。Node 的 UTF-8 解码器会缓存多字节字符的半字节片段。上游请求使用 `Accept-Encoding: identity`；不接受未经解码的压缩响应。流式路径不累积完整生成文本；慢连接有有界缓冲保护。

## 本地开发

要求 Node.js 22+、Python 3.11+，以及满足 `frontend/pubspec.yaml` 中 Dart SDK 范围的 Flutter stable。Windows 桌面构建另需 Visual Studio 的 Desktop development with C++。

```bash
npm --prefix scripts ci
npm --prefix backend ci
python -m venv python/venv
# Windows:
python/venv/Scripts/python -m pip install -r python/requirements.txt
# Linux/macOS: 使用 python/venv/bin/python
```

在 `backend/` 运行 `npm run setup` 初始化管理员密码，然后 `npm run dev`。也可以在第一次启动前设置 `ADMIN_PASSWORD`；已有配置不会被环境变量覆盖。数据目录默认是后端当前工作目录的 `data/`，可用 `OPENMYMODEL_DATA_DIR` 指向隔离测试目录。

在 `frontend/` 运行 `flutter pub get` 和 `flutter run -d windows`。桌面使用便携 Python（如果存在）或 PATH 中的 Python；开发环境应将上述虚拟环境加入 PATH。不要同时运行另一份 Bridge 占用 8765。

### 生命周期与安全

桌面启动 Bridge 时传入随机 `OPENMYMODEL_BRIDGE_ID` 和 `OPENMYMODEL_BRIDGE_TOKEN`。状态只返回标识、PID 和直接父进程 PID，不返回 Token。Windows 虚拟环境启动器会创建一个 Python 子进程，因此允许返回 PID 或直接父 PID 匹配启动进程，同时必须匹配随机标识。关闭自己的 Bridge 使用带 `X-Bridge-Token` 的 `/api/shutdown`，并核对启动标识；不得依据端口号杀掉其他用户进程。

本地接口拒绝浏览器跨站请求；它不是面向公网的管理服务。不要把 8765 暴露到局域网或公网。密码和 API Key 仍属于本地敏感用户数据，不是操作系统密钥库加密存储；应保护 Windows 用户目录。

## 自动化门禁

从仓库根目录执行：

```bash
npm --prefix scripts test
npm --prefix scripts run check:release
npm --prefix backend run build
npm --prefix backend test
python/venv/Scripts/python -m unittest discover -s python/tests -v
python/venv/Scripts/python -m compileall -q python
```

从 `frontend/` 执行：

```bash
flutter analyze
flutter test
flutter build windows --release
```

[CI 工作流模板](ci-workflow.example.yml) 可放入 `.github/workflows/verify.yml`，在 push/PR 上验证三层代码，并在 Windows runner 上编译桌面端。当前 GitHub OAuth 凭据缺少 `workflow` 权限，源码分支未包含激活的工作流；完整工作流保留在本地 `ci/full-stack-verification` 分支（提交 `47b3049`）。后端和 Bridge 测试使用临时端口及假上游，不需要真实模型/GPU，也不使用现有管理员密码或数据目录。

`npm --prefix scripts test` 覆盖：状态码、UTF-8 跨块、SSE 空行、响应头前取消、云断线清理、超时、Key 删除、压缩拒绝和重连竞争。后端包含自身路由/隧道回归和实际 Bridge 联调测试。

手工 WS 探针可以使用环境变量 `ADMIN_PASSWORD` 和 `CLOUD_WS_URL` 运行根目录 `test_ws.dart`。`scripts/mock_node.js` 使用生产桥接实现，要求 `ADMIN_PASSWORD`、`TEST_API_KEY`，可选 `CLOUD_URL`、`LLAMA_URL`、`LLAMA_API_KEY`、`MODEL_NAME`，不再内置任何可用密码。

## Windows 发布

1. 完成所有测试，并确认 `flutter build windows --release` 以退出码 0 成功。旧 exe 存在不能证明本次构建成功，CMake INSTALL 失败也不能被忽略。
2. 执行 `npm --prefix scripts run sync:release`，然后 `check:release`；勿手工只修改 release 下的 JS。
3. 确保便携运行时来源目录（默认 `release/`）包含 `python/python.exe` 与 `scripts/node.exe`，Python 依赖与源码要求匹配。
4. 创建一个全新输出目录：

```bash
python scripts/package_windows.py --output artifacts/OpenMyModel-win-x64-stability
# Flutter 未在 PATH 时，加 --flutter "C:/path/to/flutter/bin/flutter.bat"
```

打包器会先重新执行 Flutter Release 构建并检查退出码，随后只读取已有便携运行时，将**本次 Flutter 构建、当前 Python 源码、当前 Node Bridge 和 ws 依赖**放入新目录；拒绝覆盖任何现有输出，且不会修改用户的 release 树。它排除日志和缓存，并记录 `build-manifest.json`（Git revision、工作区是否有改动、逐文件 SHA-256）。打包后仍需启动该目录的 exe 验证。

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
| 模型正在加载但聊天不可用 | 等待 `ready`，查看界面返回的模型日志/错误；不要重复点击启动 |
| 云端 401 | 检查 Key 启用状态及所属节点在线状态 |
| 云端 502 / protocol error | 检查后端和 Node Bridge 是否同时升级 |
| 云端 504 | 检查上游是否长时间没有响应，以及模型加载/推理状态 |
| 本地桥接端口被占用 | 确认是否运行另一份 OpenMyModel/Bridge；应用不会杀掉未知进程 |
| Windows 构建 CMake 失败 | 阅读失败步骤并修复，不能用历史 Release 目录冒充成功构建 |
