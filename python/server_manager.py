"""
llama-server 进程管理器
负责启动、停止、监控 llama.cpp 的 server 进程
"""

import subprocess
import os
import sys
import time
import shlex
import re
import threading
from collections import deque
from dataclasses import dataclass, replace
from typing import Optional


@dataclass
class ServerConfig:
    """llama-server 运行时配置"""
    # 必需参数
    server_path: str = ""                    # llama-server.exe 绝对路径
    model_path: str = ""                     # 模型 .gguf 文件路径

    # 多模态参数
    mmproj_path: str = ""                    # mmproj .gguf 文件路径（可选，用于多模态）

    # 模型加载参数
    n_gpu_layers: int = 99                   # -ngl: GPU offload 层数，-1=全部
    context_size: int = 128000               # -c: 上下文窗口大小（令牌数）
    batch_size: int = 2048                   # -b: 批处理大小
    ubatch_size: int = 512                   # -ub: 微批处理大小
    threads: int = 0                         # -t: CPU 线程数，0=自动检测
    flash_attn: bool = True                  # -fa: Flash Attention 加速
    cache_type_k: str = "q8_0"               # -ctk: K 缓存量化类型 (f16/q8_0/q4_0)
    cache_type_v: str = "q8_0"               # -ctv: V 缓存量化类型

    # 服务参数
    host: str = "127.0.0.1"                  # --host: 监听地址
    port: int = 8080                         # --port: 监听端口
    api_key: str = ""                        # --api-key: 本地 API 密钥（可选）
    slots: int = 1                           # -np: 并行处理槽位数
    embeddings: bool = False                 # --embeddings: 启用嵌入

    # 高级参数
    rope_freq_base: float = 0.0              # --rope-freq-base: RoPE 基础频率
    rope_freq_scale: float = 0.0             # --rope-freq-scale: RoPE 缩放因子
    yarn_ext_factor: float = 0.0             # --yarn-ext-factor: YaRN 扩展因子
    yarn_attn_factor: float = 0.0            # --yarn-attn-factor: YaRN 注意力因子
    no_kv_offload: bool = False              # --no-kv-offload: 禁用 KV 卸载
    cont_batching: bool = False              # -cb: 连续批处理
    ml_lock: bool = False                    # --mlock: 锁定内存
    no_mmap: bool = False                    # --no-mmap: 禁用内存映射

    # 额外参数
    extra_args: str = ""                     # 其他自定义命令行参数


class ServerManager:
    """llama-server 进程管理器"""

    def __init__(self):
        self.process: Optional[subprocess.Popen] = None
        self.config: Optional[ServerConfig] = None
        self._start_time: float = 0
        self._lock = threading.RLock()
        self._log_lock = threading.Lock()
        self._logs: deque[str] = deque(maxlen=100)
        self._reader: Optional[threading.Thread] = None
        self._ready = False
        self._last_error = ""

    def build_command(self, config: ServerConfig) -> list[str]:
        """根据配置构建启动命令"""
        if not config.server_path:
            raise ValueError("[ERROR] 未指定 llama-server.exe 路径")
        if not config.model_path:
            raise ValueError("[ERROR] 未指定模型文件路径")
        if (not config.host or any(c.isspace() or c in "/?#@" for c in config.host)
                or not 1 <= config.port <= 65535):
            raise ValueError("[ERROR] host 必须是不含协议的主机名或 IP 地址，端口必须在 1-65535 之间")
        if "\r" in config.api_key or "\n" in config.api_key:
            raise ValueError("[ERROR] API 密钥不能包含换行符")
        if not os.path.isfile(config.server_path):
            raise FileNotFoundError(f"[ERROR] llama-server.exe 不存在: {config.server_path}")
        if not os.path.isfile(config.model_path):
            raise FileNotFoundError(f"[ERROR] 模型文件不存在: {config.model_path}")

        cmd = [config.server_path]

        # 模型
        cmd.extend(["-m", config.model_path])

        # 多模态
        if config.mmproj_path:
            if not os.path.isfile(config.mmproj_path):
                raise FileNotFoundError(f"[ERROR] mmproj 文件不存在: {config.mmproj_path}")
            cmd.extend(["--mmproj", config.mmproj_path])

        # GPU
        cmd.extend(["-ngl", str(config.n_gpu_layers)])

        # 上下文
        cmd.extend(["-c", str(config.context_size)])

        # 批处理
        cmd.extend(["-b", str(config.batch_size)])
        cmd.extend(["-ub", str(config.ubatch_size)])

        # 线程（CPU 线程数，0=自动检测为物理核心数）
        if config.threads > 0:
            cmd.extend(["-t", str(config.threads)])

        # Flash Attention
        if config.flash_attn:
            cmd.extend(["-fa", "on"])

        # 缓存量化类型：使用量化缓存可大幅节省显存
        if config.cache_type_k:
            cmd.extend(["-ctk", config.cache_type_k])
        if config.cache_type_v:
            cmd.extend(["-ctv", config.cache_type_v])

        # 服务配置
        cmd.extend(["--host", config.host])
        cmd.extend(["--port", str(config.port)])

        if config.api_key:
            cmd.extend(["--api-key", config.api_key])

        cmd.extend(["-np", str(config.slots)])

        if config.embeddings:
            cmd.append("--embeddings")

        # RoPE
        if config.rope_freq_base > 0:
            cmd.extend(["--rope-freq-base", str(config.rope_freq_base)])
        if config.rope_freq_scale > 0:
            cmd.extend(["--rope-freq-scale", str(config.rope_freq_scale)])

        # YaRN
        if config.yarn_ext_factor > 0:
            cmd.extend(["--yarn-ext-factor", str(config.yarn_ext_factor)])
        if config.yarn_attn_factor > 0:
            cmd.extend(["--yarn-attn-factor", str(config.yarn_attn_factor)])

        # 高级选项
        if config.no_kv_offload:
            cmd.append("--no-kv-offload")
        if config.cont_batching:
            cmd.append("-cb")
        if config.ml_lock:
            cmd.append("--mlock")
        if config.no_mmap:
            cmd.append("--no-mmap")

        # Preserve quoted Windows paths, but do not allow runtime endpoint overrides.
        if config.extra_args:
            args = shlex.split(config.extra_args, posix=False)
            args = [arg[1:-1] if len(arg) > 1 and arg[0] == arg[-1] and arg[0] in "\"'" else arg for arg in args]
            if any(arg.split("=", 1)[0] in {"--host", "--port", "--api-key", "--api-key-file"} for arg in args):
                raise ValueError("请使用 host/port/api_key 配置字段，不要在 extra_args 中覆盖服务地址或密钥")
            cmd.extend(args)

        return cmd

    @staticmethod
    def _redact(text: str, api_key: str = "") -> str:
        if api_key:
            text = text.replace(api_key, "[REDACTED]")
        return re.sub(r"(?i)(--api-key(?:=|\s+)|authorization:\s*bearer\s+)(\S+)", r"\1[REDACTED]", text)

    def _drain_stdout(self, process: subprocess.Popen, api_key: str):
        """Continuously drain the owned pipe; bound both line size and retained history."""
        if process.stdout is None:
            return
        try:
            # Unlike select(), a reader thread works for Windows subprocess pipes.
            truncated = False
            for line in iter(lambda: process.stdout.readline(4096), ""):
                # Discard oversized logical lines rather than exposing a key split
                # at a read boundary or retaining arbitrarily large model output.
                if truncated:
                    truncated = not line.endswith("\n")
                    continue
                if len(line) == 4096 and not line.endswith("\n"):
                    truncated = True
                    line = "[oversized log line omitted]"
                line = self._redact(line.rstrip(), api_key)
                if line:
                    with self._log_lock:
                        self._logs.append(line)
        except (OSError, ValueError):
            pass  # Pipe was closed during shutdown.
        finally:
            process.stdout.close()

    def start(self, config: ServerConfig, working_dir: str = "") -> subprocess.Popen:
        """Serialize lifecycle changes; identical repeated starts are idempotent."""
        with self._lock:
            if self.is_running():
                if self.config == config:
                    return self.process
                raise RuntimeError("llama-server 已运行；请先停止，再使用新配置启动")
            cmd = self.build_command(config)
            self.stop()  # Reap any previous, already-exited owned process.
            with self._log_lock:
                self._logs.clear()
            self._ready = False
            self._last_error = ""
            try:
                process = subprocess.Popen(
                    cmd,
                    cwd=working_dir or os.path.dirname(config.server_path) or None,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                )
            except Exception as exc:
                self._last_error = self._redact(str(exc), config.api_key)
                raise RuntimeError(f"启动 llama-server 失败: {self._last_error}") from None
            self.process = process
            self.config = replace(config)
            self._start_time = time.monotonic()
            self._reader = threading.Thread(
                target=self._drain_stdout, args=(process, config.api_key), daemon=True,
                name="llama-stdout",
            )
            self._reader.start()
            if process.poll() is not None:
                self._reader.join(timeout=1)
                self._last_error = f"llama-server 启动后退出 (exit code {process.returncode})"
                raise RuntimeError(self._last_error)
            return process

    def stop(self):
        """Only terminate the process created by this manager, never a port/name match."""
        with self._lock:
            process = self.process
            self._ready = False
            if process is None:
                return
            try:
                if process.poll() is None:
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                else:
                    process.wait(timeout=0)
            except Exception as exc:
                self._last_error = self._redact(str(exc), self.config.api_key if self.config else "")
                # Retain ownership when stop fails so a later stop can retry.
                raise RuntimeError(f"停止 llama-server 失败: {self._last_error}") from None
            if self._reader:
                self._reader.join(timeout=1)
            self.process = None
            self._reader = None
            self._start_time = 0

    def is_running(self) -> bool:
        with self._lock:
            running = self.process is not None and self.process.poll() is None
            if not running:
                self._ready = False
            return running

    def runtime_snapshot(self):
        """Return a process identity and copied config for an out-of-lock health probe."""
        with self._lock:
            if not self.is_running() or self.config is None:
                return None, None
            return self.process, replace(self.config)

    def set_ready(self, process, ready: bool):
        with self._lock:
            if self.process is process:
                self._ready = bool(ready and self.is_running())

    @property
    def uptime(self) -> float:
        with self._lock:
            return max(0, time.monotonic() - self._start_time) if self.is_running() else 0

    def get_status(self) -> dict:
        with self._lock:
            running = self.is_running()
            exit_code = self.process.poll() if self.process is not None else None
            if exit_code is not None and not self._last_error:
                self._last_error = f"llama-server 已退出 (exit code {exit_code})"
            with self._log_lock:
                logs = list(self._logs)
            return {
                "running": running,
                "ready": running and self._ready,
                "uptime": self.uptime,
                "port": self.config.port if self.config else 0,
                "host": self.config.host if self.config else "",
                "model": os.path.basename(self.config.model_path) if self.config else "",
                "mmproj": os.path.basename(self.config.mmproj_path) if self.config and self.config.mmproj_path else "",
                "pid": self.process.pid if running else None,
                "exit_code": exit_code,
                "last_error": self._last_error,
                "log_tail": logs,
            }

    def read_stdout(self) -> Optional[str]:
        """Read retained output without touching the pipe or blocking the event loop."""
        with self._log_lock:
            return self._logs.popleft() if self._logs else None


# 全局实例
server_manager = ServerManager()