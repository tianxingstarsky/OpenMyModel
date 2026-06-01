"""
聊天处理器 - 使用 aiohttp 替代 httpx
"""

import aiohttp
import json
import asyncio
from typing import AsyncGenerator, Optional


class ChatHandler:
    def __init__(self, api_base: str = "http://127.0.0.1:8080"):
        self.api_base = api_base.rstrip("/")
        self._session: Optional[aiohttp.ClientSession] = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=300)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self):
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None

    def _fix(self, data: dict) -> dict:
        if data.get("choices"):
            for c in data["choices"]:
                for key in ("message", "delta"):
                    msg = c.get(key, {})
                    if msg and not msg.get("content") and msg.get("reasoning_content"):
                        msg["content"] = msg["reasoning_content"]
        return data

    async def health_check(self) -> bool:
        try:
            s = await self._get_session()
            async with s.get(f"{self.api_base}/health") as r:
                return r.status == 200
        except Exception:
            return False

    async def chat_completion(self, messages: list, temperature: float = 0.7, top_p: float = 0.9, max_tokens: int = 4096, stream: bool = False) -> dict:
        s = await self._get_session()
        payload = {"messages": messages, "temperature": temperature, "top_p": top_p, "max_tokens": max_tokens}
        async with s.post(f"{self.api_base}/chat/completions", json=payload) as r:
            r.raise_for_status()
            return self._fix(await r.json())

    async def chat_completion_stream(self, messages: list, temperature: float = 0.7, top_p: float = 0.9, max_tokens: int = 4096) -> AsyncGenerator[str, None]:
        s = await self._get_session()
        payload = {"messages": messages, "temperature": temperature, "top_p": top_p, "max_tokens": max_tokens, "stream": True}
        async with s.post(f"{self.api_base}/chat/completions", json=payload) as r:
            r.raise_for_status()
            async for line in r.content:
                text = line.decode("utf-8").strip()
                if text.startswith("data: "):
                    if text == "data: [DONE]":
                        break
                    try:
                        data = json.loads(text[6:])
                        data = self._fix(data)
                        yield "data: " + json.dumps(data) + "\n"
                    except Exception:
                        pass


chat_handler = ChatHandler()