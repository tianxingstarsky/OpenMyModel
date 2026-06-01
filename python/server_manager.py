"""
llama-server 进程管理器
负责启动、停止、监控 llama.cpp 的 server 进程
"""

import subprocess
import os
import sys
import signal
import time
import asyncio
from pathlib import Path
from dataclasses import dataclass, field
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
        self._running = False
        self._start_time: float = 0

    def build_command(self, config: ServerConfig) -> list[str]:
        """根据配置构建启动命令"""
        if not config.server_path:
            raise ValueError("[ERROR] 未指定 llama-server.exe 路径")
        if not config.model_path:
            raise ValueError("[ERROR] 未指定模型文件路径")
        if not os.path.exists(config.server_path):
            raise FileNotFoundError(f"[ERROR] llama-server.exe 不存在: {config.server_path}")
        if not os.path.exists(config.model_path):
            raise FileNotFoundError(f"[ERROR] 模型文件不存在: {config.model_path}")

        cmd = [config.server_path]

        # 模型
        cmd.extend(["-m", config.model_path])

        # 多模态
        if config.mmproj_path and os.path.exists(config.mmproj_path):
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

        # 额外参数
        if config.extra_args:
            cmd.extend(config.extra_args.split())

        return cmd

    def start(self, config: ServerConfig, working_dir: str = "") -> subprocess.Popen:
        """启动 llama-server 进程"""
        if self._running:
            self.stop()

        self.config = config
        cmd = self.build_command(config)
        cwd = working_dir or os.path.dirname(config.server_path)

        print(f"[START] 启动 llama-server...")
        print(f"   命令: {' '.join(cmd)}")
        print(f"   工作目录: {cwd}")

        self.process = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
        self._running = True
        self._start_time = time.time()

        return self.process

    def stop(self):
        """停止 llama-server 进程"""
        if self.process:
            print("[STOP] 停止 llama-server...")
            try:
                if sys.platform == "win32":
                    self.process.terminate()
                else:
                    self.process.send_signal(signal.SIGTERM)

                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            except Exception as e:
                print(f"[WARN] 停止进程时出错: {e}")

            self.process = None
            self._running = False

    def is_running(self) -> bool:
        """检查进程是否正在运行"""
        if self.process:
            poll = self.process.poll()
            return poll is None
        return False

    @property
    def uptime(self) -> float:
        """运行时长（秒）"""
        if self._running and self._start_time > 0:
            return time.time() - self._start_time
        return 0

    def get_status(self) -> dict:
        """获取当前状态"""
        return {
            "running": self.is_running(),
            "uptime": self.uptime,
            "port": self.config.port if self.config else 0,
            "model": os.path.basename(self.config.model_path) if self.config else "",
            "mmproj": os.path.basename(self.config.mmproj_path) if self.config and self.config.mmproj_path else "",
        }

    def read_stdout(self) -> Optional[str]:
        """非阻塞读取一行输出"""
        if self.process and self.process.stdout:
            import select
            if select.select([self.process.stdout], [], [], 0)[0]:
                return self.process.stdout.readline().strip()
        return None


# 全局实例
server_manager = ServerManager()