"""
桥接服务
提供 HTTP API 供 Flutter 前端调用，作为 UI 与 llama.cpp 之间的桥梁
"""

import os
import asyncio
import hmac
import ipaddress
import logging
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, JSONResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field

from server_manager import ServerConfig, server_manager
from config_manager import ProfileNameError, config_manager
from chat_handler import UpstreamError, chat_handler

# 日志
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("bridge")

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.lifecycle_lock = asyncio.Lock()
    app.state.shutting_down = False
    try:
        yield
    finally:
        app.state.shutting_down = True
        # Abort active generations before waiting for the owned subprocess.
        try:
            await chat_handler.close()
        finally:
            async with app.state.lifecycle_lock:
                await _lifecycle_thread(server_manager.stop)


app = FastAPI(title="OpenMyModel Bridge", version="1.0.0", lifespan=lifespan)
app.state.bridge_id = os.environ.get("OPENMYMODEL_BRIDGE_ID") or uuid.uuid4().hex
app.state.bridge_token = os.environ.get("OPENMYMODEL_BRIDGE_TOKEN", "")
app.state.shutdown_callback = None
app.state.shutting_down = False
app.state.lifecycle_lock = asyncio.Lock()


def _loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class LocalOnlyMiddleware:
    """Native loopback API, not a cross-origin website API (including simple POSTs)."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = {key.lower(): value for key, value in scope["headers"]}
            client = scope.get("client")
            try:
                host = urlsplit("//" + headers.get(b"host", b"").decode("ascii")).hostname or ""
            except (ValueError, UnicodeError):
                host = ""
            # Host validation also blocks browser DNS rebinding. Do not trust
            # X-Forwarded-For; main() disables uvicorn proxy-header handling.
            if (not client or not _loopback(client[0]) or not _loopback(host)
                    or b"origin" in headers
                    or headers.get(b"sec-fetch-site", b"none") != b"none"):
                await JSONResponse({"detail": "仅允许本机原生客户端访问"}, status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(LocalOnlyMiddleware)


@app.exception_handler(UpstreamError)
async def upstream_error_handler(request: Request, exc: UpstreamError):
    return JSONResponse(status_code=exc.status, content=exc.body)


async def _profile_operation(operation, *args):
    try:
        return await asyncio.to_thread(operation, *args)
    except ProfileNameError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except Exception as exc:
        logger.error("配置档案操作失败 (%s)", type(exc).__name__)
        raise HTTPException(status_code=500, detail="配置档案读写失败，请检查文件内容及目录权限") from None


async def _until_disconnect(request: Request, operation, close_result=None):
    """FastAPI does not cancel a handler merely because its client disconnected."""
    async def wait_for_disconnect():
        while True:
            if (await request.receive())["type"] == "http.disconnect":
                return

    work = asyncio.create_task(operation)
    disconnected = asyncio.create_task(wait_for_disconnect())
    delivered = False
    try:
        done, _ = await asyncio.wait((work, disconnected), return_when=asyncio.FIRST_COMPLETED)
        if disconnected in done:
            raise HTTPException(status_code=499, detail="客户端已断开连接")
        result = work.result()
        delivered = True
        return result
    finally:
        work.cancel()
        disconnected.cancel()
        await asyncio.gather(work, disconnected, return_exceptions=True)
        if not delivered and close_result and not work.cancelled() and work.exception() is None:
            close_result(work.result())


class UpstreamStreamingResponse(StreamingResponse):
    def __init__(self, upstream):
        self.upstream = upstream
        super().__init__(
            chat_handler.iter_stream(upstream), status_code=upstream.status,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    async def __call__(self, scope, receive, send):
        # Watch disconnects even on ASGI 2.4+, where StreamingResponse otherwise
        # waits for a send() failure (which may be minutes away during generation).
        streaming = asyncio.create_task(self.stream_response(send))
        disconnected = asyncio.create_task(self.listen_for_disconnect(receive))
        try:
            done, _ = await asyncio.wait((streaming, disconnected), return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            # Covers disconnect during headers/before first iteration, too.
            chat_handler.close_response(self.upstream)
            streaming.cancel()
            disconnected.cancel()
            await asyncio.gather(streaming, disconnected, return_exceptions=True)


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
    port: int = Field(default=8080, ge=1, le=65535)
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
    max_tokens: Optional[int] = Field(default=None, ge=1)
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

async def _lifecycle_thread(operation, *args):
    # Cancelling to_thread() does not stop its worker. Keep the async lifecycle
    # lock until it finishes, so restart/shutdown cannot race a detached Popen.
    task = asyncio.create_task(asyncio.to_thread(operation, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


def _start_managed(config: ServerConfig, work_dir: str):
    server_manager.start(config, work_dir)
    chat_handler.configure(config.host, config.port, config.api_key)


async def _refresh_status():
    process, config = await asyncio.to_thread(server_manager.runtime_snapshot)
    if process is not None:
        healthy = await chat_handler.health_check(chat_handler.endpoint(config.host, config.port), config.api_key)
        await asyncio.to_thread(server_manager.set_ready, process, healthy)
    status = await asyncio.to_thread(server_manager.get_status)
    status.update(bridge_id=app.state.bridge_id, bridge_pid=os.getpid(), bridge_parent_pid=os.getppid())
    return status


@app.get("/api/status")
async def get_status():
    return await _refresh_status()


@app.post("/api/server/start")
async def start_server(config: ConfigModel):
    async with app.state.lifecycle_lock:
        if app.state.shutting_down:
            raise HTTPException(status_code=503, detail="桥接服务正在关闭")
        try:
            server_config = config.to_server_config()
            work_dir = os.path.dirname(config.server_path) if config.server_path else ""
            # Configure only after successful start, even if the caller is cancelled.
            await _lifecycle_thread(_start_managed, server_config, work_dir)
            return {"ok": True, "message": "llama-server 已启动，正在等待模型就绪",
                    **await asyncio.to_thread(server_manager.get_status)}
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except RuntimeError as exc:
            raise HTTPException(status_code=409 if await asyncio.to_thread(server_manager.is_running) else 500,
                                detail=str(exc)) from None


@app.post("/api/server/stop")
async def stop_server():
    async with app.state.lifecycle_lock:
        try:
            await chat_handler.close()
            await _lifecycle_thread(server_manager.stop)
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from None
    return {"ok": True, "message": "llama-server 已停止"}


@app.get("/api/server/check")
async def check_server():
    status = await _refresh_status()
    return {"healthy": status["ready"], **status}


@app.post("/api/shutdown")
async def shutdown_bridge(request: Request):
    expected = app.state.bridge_token
    supplied = request.headers.get("X-Bridge-Token", "")
    if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(status_code=403, detail="桥接所有权验证失败")
    callback = app.state.shutdown_callback
    if callback is None:
        raise HTTPException(status_code=503, detail="当前启动方式不支持关闭桥接")
    app.state.shutting_down = True
    # Respond before stopping uvicorn. Its lifespan then closes sessions/process.
    return JSONResponse({"ok": True}, background=BackgroundTask(callback))


# ==================== 配置档案 API ====================

@app.get("/api/profiles")
async def list_profiles():
    """列出所有配置档案"""
    return await _profile_operation(config_manager.list_profiles)


@app.post("/api/profiles/save")
async def save_profile(req: SaveProfileRequest):
    """保存配置档案"""
    ok = await _profile_operation(config_manager.save, req.name, req.config.to_server_config())
    return {"ok": ok}


@app.post("/api/profiles/load")
async def load_profile(req: ProfileRequest):
    """加载配置档案"""
    config = await _profile_operation(config_manager.load, req.name)
    if config is None:
        raise HTTPException(status_code=404, detail=f"配置档案 '{req.name}' 不存在")
    return asdict(config)


@app.delete("/api/profiles/delete")
async def delete_profile(name: str = Query(...)):
    """删除配置档案"""
    ok = await _profile_operation(config_manager.delete, name)
    return {"ok": ok}


@app.get("/api/profiles/default")
async def get_default_config():
    """获取默认配置"""
    config = config_manager.get_default_config()
    return asdict(config)


# ==================== 聊天 API ====================

@app.post("/api/chat")
async def local_chat(req: ChatRequest, request: Request):
    """本地聊天（流式）"""
    if not req.stream:
        return await local_chat_sync(req, request)
    if app.state.shutting_down or not await asyncio.to_thread(server_manager.is_running):
        raise HTTPException(status_code=503, detail="llama-server 未运行或正在关闭")
    upstream = await _until_disconnect(request, chat_handler.open_stream(
        messages=req.messages, temperature=req.temperature,
        top_p=req.top_p, max_tokens=req.max_tokens,
    ), close_result=chat_handler.close_response)
    return UpstreamStreamingResponse(upstream)


@app.post("/api/chat/sync")
async def local_chat_sync(req: ChatRequest, request: Request):
    """本地聊天（同步）"""
    if app.state.shutting_down or not await asyncio.to_thread(server_manager.is_running):
        raise HTTPException(status_code=503, detail="llama-server 未运行或正在关闭")

    result = await _until_disconnect(request, chat_handler.chat_completion(
        messages=req.messages,
        temperature=req.temperature,
        top_p=req.top_p,
        max_tokens=req.max_tokens,
        stream=False,
    ))
    return result


# ==================== 文件浏览 API ====================

@app.get("/api/files/list")
def list_files(path: str = Query(...), pattern: str = "*.gguf"):
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
def list_drives():
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
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=8765, log_level="info",
        proxy_headers=False, timeout_graceful_shutdown=2,
    ))

    async def request_exit():
        # Close in-flight streams before uvicorn waits for active connections.
        await chat_handler.close()
        server.should_exit = True

    app.state.shutdown_callback = request_exit
    server.run()


if __name__ == "__main__":
    main()