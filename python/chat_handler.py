"""
聊天处理器
处理本地对话请求，支持流式输出和多模态（图片输入）
"""

import httpx
import json
import asyncio
from typing import AsyncGenerator, Optional


class ChatHandler:
    """本地 llama-server 聊天处理器"""

    def __init__(self, api_base: str = "http://127.0.0.1:8080"):
        self.api_base = api_base.rstrip("/")
        self.client: Optional[httpx.AsyncClient] = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self.client is None:
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(300.0))
        return self.client

    async def close(self):
        if self.client:
            await self.client.aclose()
            self.client = None

    async def health_check(self) -> bool:
        """检查 llama-server 是否可用"""
        try:
            client = await self._get_client()
            resp = await client.get(f"{self.api_base}/health")
            return resp.status_code == 200
        except Exception:
            return False

    async def list_models(self) -> list[dict]:
        """获取可用模型列表"""
        try:
            client = await self._get_client()
            resp = await client.get(f"{self.api_base}/v1/models")
            return resp.json().get("data", [])
        except Exception:
            return []

    async def chat_completion(
        self,
        messages: list[dict],
        temperature: float = 0.7,
        top_p: float = 0.9,
        max_tokens: int = 4096,
        stream: bool = False,
    ) -> dict:
        """发送聊天完成请求（非流式）"""
        client = await self._get_client()
        payload = {
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens,
            "stream": False,
        }
        resp = await client.post(
            f"{self.api_base}/v1/chat/completions",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()

    async def chat_completion_stream(
        self,
        messages: list[dict],
        temperature: float = 0.7,
        top_p: float = 0.9,
        max_tokens: int = 4096,
    ) -> AsyncGenerator[str, None]:
        """发送聊天完成请求（流式），逐块返回 SSE 数据"""
        client = await self._get_client()
        payload = {
            "messages": messages,
            "temperature": temperature,
            "top_p": top_p,
            "max_tokens": max_tokens,
            "stream": True,
        }
        async with client.stream(
            "POST",
            f"{self.api_base}/v1/chat/completions",
            json=payload,
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    yield line

    async def tokenize(self, text: str) -> dict:
        """分词"""
        client = await self._get_client()
        resp = await client.post(
            f"{self.api_base}/tokenize",
            json={"content": text},
        )
        resp.raise_for_status()
        return resp.json()


# 全局实例
chat_handler = ChatHandler()