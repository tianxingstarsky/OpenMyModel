"""
桥接服务
提供 HTTP API 供 Flutter 前端调用，作为 UI 与 llama.cpp 之间的桥梁
"""

import os
import sys
import json
import asyncio
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field

from server_manager import ServerConfig, server_manager
from config_manager import config_manager
from chat_handler import chat_handler

# 日志
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("bridge")

app = FastAPI(title="OpenMyModel Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================== 数据模型 ====================

class ConfigModel(BaseModel):
    """前端传来的完整配置"""
    server_path: str = ""
    model_path: str = ""
    mmproj_path: str = ""
    n_gpu_layers: int = 99
    context_size: int = 128000
    batch_size: int = 2048
    ubatch_size: int = 512
    threads: int = 0
    flash_attn: bool = True
    cache_type_k: str = "q8_0"
    cache_type_v: str = "q8_0"
    host: str = "127.0.0.1"
    port: int = 8080
    api_key: str = ""
    slots: int = 1
    embeddings: bool = False
    rope_freq_base: float = 0.0
    rope_freq_scale: float = 0.0
    yarn_ext_factor: float = 0.0
    yarn_attn_factor: float = 0.0
    no_kv_offload: bool = False
    cont_batching: bool = False
    ml_lock: bool = False
    no_mmap: bool = False
    extra_args: str = ""

    def to_server_config(self) -> ServerConfig:
        return ServerConfig(**self.model_dump())


class ChatRequest(BaseModel):
    """聊天请求"""
    messages: list[dict]
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 4096
    stream: bool = True


class ProfileRequest(BaseModel):
    """配置档案请求"""
    name: str


class SaveProfileRequest(BaseModel):
    """保存配置档案请求"""
    name: str
    config: ConfigModel


class CloudConfig(BaseModel):
    """云端连接配置"""
    server_url: str = ""        # 如 api.your-domain.com
    password: str = ""          # 云端设置的密码


# ==================== 服务管理 API ====================

@app.get("/api/status")
async def get_status():
    """获取 llama-server 状态"""
    return server_manager.get_status()


@app.post("/api/server/start")
async def start_server(config: ConfigModel):
    """启动 llama-server"""
    try:
        server_config = config.to_server_config()
        work_dir = os.path.dirname(config.server_path) if config.server_path else ""
        server_manager.start(server_config, work_dir)
        return {"ok": True, "message": "llama-server 已启动"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/server/stop")
async def stop_server():
    """停止 llama-server"""
    server_manager.stop()
    return {"ok": True, "message": "llama-server 已停止"}


@app.get("/api/server/check")
async def check_server():
    """检查 llama-server 是否可达"""
    ok = await chat_handler.health_check()
    return {"healthy": ok}


# ==================== 配置档案 API ====================

@app.get("/api/profiles")
async def list_profiles():
    """列出所有配置档案"""
    return config_manager.list_profiles()


@app.post("/api/profiles/save")
async def save_profile(req: SaveProfileRequest):
    """保存配置档案"""
    ok = config_manager.save(req.name, req.config.to_server_config())
    return {"ok": ok}


@app.post("/api/profiles/load")
async def load_profile(req: ProfileRequest):
    """加载配置档案"""
    config = config_manager.load(req.name)
    if config is None:
        raise HTTPException(status_code=404, detail=f"配置档案 '{req.name}' 不存在")
    return config_manager._profile_path(req.name).read_text("utf-8")


@app.delete("/api/profiles/delete")
async def delete_profile(name: str = Query(...)):
    """删除配置档案"""
    ok = config_manager.delete(name)
    return {"ok": ok}


@app.get("/api/profiles/default")
async def get_default_config():
    """获取默认配置"""
    config = config_manager.get_default_config()
    return {k: v for k, v in config.__dict__.items()}


# ==================== 聊天 API ====================

@app.post("/api/chat")
async def local_chat(req: ChatRequest):
    """本地聊天（流式）"""
    if not server_manager.is_running():
        raise HTTPException(status_code=503, detail="llama-server 未运行")

    async def generate():
        async for chunk in chat_handler.chat_completion_stream(
            messages=req.messages,
            temperature=req.temperature,
            top_p=req.top_p,
            max_tokens=req.max_tokens,
        ):
            yield chunk + "\n"
        yield "data: [DONE]\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/chat/sync")
async def local_chat_sync(req: ChatRequest):
    """本地聊天（同步）"""
    if not server_manager.is_running():
        raise HTTPException(status_code=503, detail="llama-server 未运行")

    result = await chat_handler.chat_completion(
        messages=req.messages,
        temperature=req.temperature,
        top_p=req.top_p,
        max_tokens=req.max_tokens,
        stream=False,
    )
    return result


# ==================== 文件浏览 API ====================

@app.get("/api/files/list")
async def list_files(path: str = Query(...), pattern: str = "*.gguf"):
    """列出目录下的文件"""
    try:
        p = Path(path)
        if not p.exists():
            return {"files": [], "error": f"路径不存在: {path}"}
        files = []
        for f in sorted(p.glob(pattern)):
            files.append({
                "name": f.name,
                "path": str(f),
                "size": f.stat().st_size,
                "is_dir": f.is_dir(),
            })
        return {"files": files, "path": str(p)}
    except Exception as e:
        return {"files": [], "error": str(e)}


@app.get("/api/files/drives")
async def list_drives():
    """获取可用驱动器列表（Windows）"""
    import string
    drives = []
    for letter in string.ascii_uppercase:
        p = f"{letter}:\\"
        if os.path.exists(p):
            drives.append(p)
    return {"drives": drives}


# ==================== 云端配置 API ====================

_cloud_config: dict = {"server_url": "", "password": ""}


@app.get("/api/cloud/config")
async def get_cloud_config():
    """获取云端配置"""
    return _cloud_config


@app.post("/api/cloud/config")
async def set_cloud_config(config: CloudConfig):
    """设置云端配置"""
    global _cloud_config
    _cloud_config = {"server_url": config.server_url, "password": config.password}
    return {"ok": True}


# ==================== 启动 ====================

def main():
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")


if __name__ == "__main__":
    main()