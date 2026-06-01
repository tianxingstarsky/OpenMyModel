"""
配置档案管理器
支持保存、加载、删除多份 llama-server 配置档案
"""

import json
import os
from pathlib import Path
from datetime import datetime
from typing import Optional

from server_manager import ServerConfig


class ConfigProfile:
    """一份完整的配置档案"""
    def __init__(self, name: str, config: ServerConfig):
        self.name = name
        self.config = config
        self.created_at: str = datetime.now().isoformat()
        self.updated_at: str = datetime.now().isoformat()


class ConfigManager:
    """配置档案管理器"""

    def __init__(self, config_dir: str = ""):
        if config_dir:
            self.config_dir = Path(config_dir)
        else:
            self.config_dir = Path.home() / ".OpenMyModel" / "profiles"
        self.config_dir.mkdir(parents=True, exist_ok=True)

    def _profile_path(self, name: str) -> Path:
        """获取配置文件路径"""
        safe_name = "".join(c for c in name if c.isalnum() or c in "._- ")
        return self.config_dir / f"{safe_name}.json"

    def list_profiles(self) -> list[dict]:
        """列出所有配置档案"""
        profiles = []
        if self.config_dir.exists():
            for f in sorted(self.config_dir.glob("*.json")):
                try:
                    with open(f, "r", encoding="utf-8") as fp:
                        data = json.load(fp)
                    profiles.append({
                        "name": data.get("name", f.stem),
                        "model": os.path.basename(data.get("model_path", "")),
                        "mmproj": os.path.basename(data.get("mmproj_path", "")),
                        "context_size": data.get("context_size", 0),
                        "updated_at": data.get("updated_at", ""),
                    })
                except Exception:
                    pass
        return profiles

    def save(self, name: str, config: ServerConfig) -> bool:
        """保存配置档案（不存在则新建，存在则覆盖）"""
        try:
            profile_path = self._profile_path(name)
            data = {
                "name": name,
                "server_path": config.server_path,
                "model_path": config.model_path,
                "mmproj_path": config.mmproj_path,
                "n_gpu_layers": config.n_gpu_layers,
                "context_size": config.context_size,
                "batch_size": config.batch_size,
                "ubatch_size": config.ubatch_size,
                "threads": config.threads,
                "flash_attn": config.flash_attn,
                "cache_type_k": config.cache_type_k,
                "cache_type_v": config.cache_type_v,
                "host": config.host,
                "port": config.port,
                "api_key": config.api_key,
                "slots": config.slots,
                "embeddings": config.embeddings,
                "rope_freq_base": config.rope_freq_base,
                "rope_freq_scale": config.rope_freq_scale,
                "yarn_ext_factor": config.yarn_ext_factor,
                "yarn_attn_factor": config.yarn_attn_factor,
                "no_kv_offload": config.no_kv_offload,
                "cont_batching": config.cont_batching,
                "ml_lock": config.ml_lock,
                "no_mmap": config.no_mmap,
                "extra_args": config.extra_args,
                "updated_at": datetime.now().isoformat(),
            }

            # 如果是新建，添加创建时间
            if not profile_path.exists():
                data["created_at"] = datetime.now().isoformat()
            else:
                existing = json.loads(profile_path.read_text("utf-8"))
                data["created_at"] = existing.get("created_at", data["updated_at"])

            profile_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            return True
        except Exception as e:
            print(f"[ERROR] 保存配置失败: {e}")
            return False

    def load(self, name: str) -> Optional[ServerConfig]:
        """加载配置档案"""
        profile_path = self._profile_path(name)
        if not profile_path.exists():
            return None

        try:
            with open(profile_path, "r", encoding="utf-8") as fp:
                data = json.load(fp)

            config = ServerConfig()
            for key in [
                "server_path", "model_path", "mmproj_path",
                "n_gpu_layers", "context_size", "batch_size", "ubatch_size",
                "threads", "flash_attn", "cache_type_k", "cache_type_v",
                "host", "port", "api_key", "slots", "embeddings",
                "rope_freq_base", "rope_freq_scale",
                "yarn_ext_factor", "yarn_attn_factor",
                "no_kv_offload", "cont_batching", "ml_lock", "no_mmap",
                "extra_args",
            ]:
                if key in data:
                    setattr(config, key, data[key])
            return config
        except Exception as e:
            print(f"[ERROR] 加载配置失败: {e}")
            return None

    def delete(self, name: str) -> bool:
        """删除配置档案"""
        profile_path = self._profile_path(name)
        if profile_path.exists():
            profile_path.unlink()
            return True
        return False

    def get_default_config(self) -> ServerConfig:
        """返回默认配置"""
        return ServerConfig(
            n_gpu_layers=99,
            context_size=128000,
            batch_size=2048,
            ubatch_size=512,
            threads=0,
            flash_attn=True,
            cache_type_k="q8_0",
            cache_type_v="q8_0",
            host="127.0.0.1",
            port=8080,
            slots=1,
        )


# 全局实例
config_manager = ConfigManager()