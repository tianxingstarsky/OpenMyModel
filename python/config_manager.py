"""Validated, atomic storage for named llama-server configuration profiles."""

import json
import logging
import os
import tempfile
import threading
from dataclasses import asdict, fields
from datetime import datetime
from pathlib import Path
from typing import Optional

from server_manager import ServerConfig

logger = logging.getLogger("bridge.profiles")


class ProfileNameError(ValueError):
    """A name is unsafe or aliases another existing profile."""


class ConfigManager:
    def __init__(self, config_dir: str = ""):
        self.config_dir = Path(config_dir) if config_dir else Path.home() / ".openmymodel" / "profiles"
        self._lock = threading.RLock()

    def _profile_path(self, name: str) -> Path:
        # Keep the previous valid alphabet, including Chinese and literal spaces,
        # but never silently drop characters or trim a name into another name.
        if not isinstance(name, str) or not name.strip() or name in {".", ".."}:
            raise ProfileNameError("配置档案名称不能为空或仅包含空白")
        if len(name) > 200 or any(not (c.isalnum() or c in "._- ") for c in name):
            raise ProfileNameError("配置档案名称仅支持文字、数字、空格及 ._-，且不能超过 200 字符")
        reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
        reserved.update(f"{prefix}{i}" for prefix in ("COM", "LPT") for i in "123456789¹²³")
        if name.split(".", 1)[0].rstrip().upper() in reserved:
            raise ProfileNameError("配置档案名称不能使用 Windows 保留设备名称")
        path = self.config_dir / f"{name}.json"
        if path.is_symlink():
            raise ProfileNameError("配置档案不能是符号链接")
        # Windows is case-insensitive. Reject case aliases rather than overwriting
        # a differently named profile (also reproducible on other platforms).
        for existing in self.config_dir.glob("*.json"):
            if existing.stem != name and existing.stem.casefold() == name.casefold():
                raise ProfileNameError(f"配置档案名称与已有档案 '{existing.stem}' 冲突")
        return path

    def list_profiles(self) -> list[dict]:
        profiles = []
        with self._lock:
            for path in sorted(self.config_dir.glob("*.json")):
                try:
                    self._profile_path(path.stem)
                    data = json.loads(path.read_text(encoding="utf-8"))
                    profiles.append({
                        "name": path.stem,
                        "model": os.path.basename(data.get("model_path", "")),
                        "mmproj": os.path.basename(data.get("mmproj_path", "")),
                        "context_size": data.get("context_size", 0),
                        "updated_at": data.get("updated_at", ""),
                    })
                except (OSError, ValueError, TypeError, AttributeError) as exc:
                    # Do not include file contents or config secrets in diagnostics.
                    logger.warning("无法列出配置档案 %s (%s)", path.name, type(exc).__name__)
        return profiles

    def save(self, name: str, config: ServerConfig) -> bool:
        """Replace atomically; callers receive validation, read and write failures."""
        with self._lock:
            path = self._profile_path(name)
            self.config_dir.mkdir(parents=True, exist_ok=True)
            now = datetime.now().isoformat()
            data = {**asdict(config), "name": name, "created_at": now, "updated_at": now}
            if path.exists():
                existing = json.loads(path.read_text(encoding="utf-8"))
                data["created_at"] = existing.get("created_at", now)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", dir=self.config_dir,
                    prefix=".profile-", suffix=".tmp", delete=False,
                ) as handle:
                    temporary = Path(handle.name)
                    json.dump(data, handle, ensure_ascii=False, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, path)
            finally:
                if temporary is not None and temporary.exists():
                    temporary.unlink()
            return True

    def load(self, name: str) -> Optional[ServerConfig]:
        with self._lock:
            path = self._profile_path(name)
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return None
            if not isinstance(data, dict):
                raise ValueError("配置档案必须是 JSON 对象")
            names = {field.name for field in fields(ServerConfig)}
            return ServerConfig(**{key: value for key, value in data.items() if key in names})

    def delete(self, name: str) -> bool:
        with self._lock:
            path = self._profile_path(name)
            try:
                path.unlink()
            except FileNotFoundError:
                return False
            return True

    def get_default_config(self) -> ServerConfig:
        return ServerConfig()


config_manager = ConfigManager()
