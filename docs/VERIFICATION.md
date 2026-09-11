# 本轮稳定性验证记录

环境：Windows 10 x64，Node.js 24.16.0，Flutter 3.44.1 / Dart 3.12.1，Python 3.11.9（隔离虚拟环境）及便携 Python 3.13.9。

## 通过的检查

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

## 桌面启动检查

启动本次 Release 构建后确认：
- 首页读取已有 llama-server 路径和模型目录，GGUF 列表恢复。
- Python Bridge 启动并显示“已就绪，选择模型后启动”。
- 修复虚拟环境 Python 启动器产生子进程导致的 PID 误判，仍要求随机标识与 PID/直接父 PID 同时满足归属关系。
- 窗口关闭动作被执行，桌面及本次桥接进程退出，8765 端口不再监听。
- Widget 回归验证真实 HomePage 的 IndexedStack 保留 ChatPage/CloudPage 实例、部分回复和停止生成行为；修复其检测到的参数卡片横向溢出。

## 未执行与边界

- Docker 引擎未运行（`dockerDesktopLinuxEngine` 管道不存在），因此没有执行容器构建、启动或 nginx 运行时测试；没有擅自启动/重启用户 Docker 环境。
- 桌面自动化对 Flutter 自绘导航控件的前台激活被环境拒绝。首页视觉观察、原生窗口按钮操作可用，但未完成整套真实鼠标操作验收。
- 未启动真实 GGUF/GPU 推理，也未测试用户公网云服务器。模型实际兼容性、性能和生产 TLS 配置不在本次通过项中。
- Git 同步只发布源码分支，不等同于部署到已有云服务器或覆盖现有桌面 release 目录。
- GitHub OAuth 缺少 `workflow` 权限，CI 激活文件被远端拒绝；已拆分为本地 `ci/full-stack-verification` 分支提交 `47b3049`，源码分支提供 `docs/ci-workflow.example.yml` 模板。没有更改账号授权。
- 已有用户日志、压缩包、临时脚本和本机配置均保留；未重写 Git 历史或轮换用户密码。
