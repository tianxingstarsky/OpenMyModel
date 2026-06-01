# OutMyModel

将本地 llama.cpp 算力共享到云端的全栈方案。
通过 OpenAI 兼容 API，让其他用户访问你的私有模型。

## 架构

- `frontend/` — Flutter 桌面端 (Windows/macOS/Linux)，简约 UI
- `python/` — Python 业务逻辑层，控制 llama-server 进程
- `backend/` — TypeScript 云后端，OpenAI 兼容 API + WebSocket 隧道

## 快速开始

### 前端 (Windows)
```
cd frontend
flutter pub get
flutter run -d windows
```

### Python 业务层
```
cd python
pip install -r requirements.txt
python bridge_server.py
```

### 云后端
```
cd backend
npm install
npm run dev
```