"""Async llama.cpp OpenAI proxy with explicit upstream ownership."""

import asyncio
import json
from typing import AsyncGenerator, Optional

import aiohttp


class UpstreamError(Exception):
    def __init__(self, status: int, body):
        self.status = status
        self.body = body
        super().__init__(f"llama-server returned HTTP {status}")


class ChatHandler:
    def __init__(self, api_base: str = "http://127.0.0.1:8080", api_key: str = ""):
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self._session: Optional[aiohttp.ClientSession] = None
        self._responses: set[aiohttp.ClientResponse] = set()

    @staticmethod
    def endpoint(host: str, port: int) -> str:
        host = host.strip().strip("[]")
        # Wildcard bind addresses are not portable client destinations.
        host = {"0.0.0.0": "127.0.0.1", "::": "::1"}.get(host, host)
        if ":" in host:
            host = f"[{host}]"
        return f"http://{host}:{port}"

    def configure(self, host: str, port: int, api_key: str = ""):
        self.api_base = self.endpoint(host, port)
        self.api_key = api_key

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=300),
            )
        return self._session

    def close_response(self, response: aiohttp.ClientResponse):
        # close(), unlike waiting for release/read, immediately aborts generation.
        response.close()
        self._responses.discard(response)

    async def close(self):
        for response in tuple(self._responses):
            self.close_response(response)
        if self._session is not None:
            await self._session.close()
            self._session = None

    def _headers(self, api_key: Optional[str] = None) -> dict:
        key = self.api_key if api_key is None else api_key
        return {"Authorization": f"Bearer {key}"} if key else {}

    @staticmethod
    def _payload(messages: list, temperature: float, top_p: float, max_tokens: Optional[int], stream: bool) -> dict:
        payload = {"messages": messages, "temperature": temperature, "top_p": top_p, "stream": stream}
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        return payload

    async def list_models(self) -> list:
        try:
            session = await self._get_session()
            async with session.get(f"{self.api_base}/v1/models", headers=self._headers(), allow_redirects=False) as response:
                if response.status != 200:
                    return []
                return (await response.json()).get("data", [])
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            return []

    async def health_check(self, api_base: Optional[str] = None, api_key: Optional[str] = None) -> bool:
        try:
            session = await self._get_session()
            async with session.get(
                f"{api_base or self.api_base}/health", headers=self._headers(api_key),
                timeout=aiohttp.ClientTimeout(total=1), allow_redirects=False,
            ) as response:
                return response.status == 200
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            return False

    async def _post(self, payload: dict) -> aiohttp.ClientResponse:
        session = await self._get_session()
        try:
            response = await session.post(
                f"{self.api_base}/v1/chat/completions", json=payload,
                headers=self._headers(), allow_redirects=False,
            )
        except asyncio.TimeoutError:
            raise UpstreamError(504, {"error": {"message": "llama-server 请求超时"}}) from None
        except aiohttp.ClientError:
            raise UpstreamError(502, {"error": {"message": "无法连接 llama-server"}}) from None
        self._responses.add(response)
        if not 200 <= response.status < 300:
            try:
                try:
                    raw = await response.read()
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    raise UpstreamError(response.status, {"error": {"message": "无法读取 llama-server 错误响应"}}) from None
                try:
                    body = json.loads(raw)
                except (ValueError, UnicodeError):
                    body = {"error": {"message": raw.decode("utf-8", errors="replace") or response.reason}}
                raise UpstreamError(response.status, body)
            finally:
                self.close_response(response)
        return response

    async def chat_completion(self, messages: list, temperature: float = 0.7, top_p: float = 0.9,
                              max_tokens: Optional[int] = None, stream: bool = False):
        response = await self._post(self._payload(messages, temperature, top_p, max_tokens, False))
        try:
            return await response.json(content_type=None)
        except (ValueError, aiohttp.ClientError):
            raise UpstreamError(502, {"error": {"message": "llama-server 返回了无效 JSON"}}) from None
        except asyncio.TimeoutError:
            raise UpstreamError(504, {"error": {"message": "llama-server 响应超时"}}) from None
        finally:
            self.close_response(response)

    async def open_stream(self, messages: list, temperature: float = 0.7, top_p: float = 0.9,
                          max_tokens: Optional[int] = None) -> aiohttp.ClientResponse:
        # Await upstream headers here, BEFORE the bridge emits its SSE headers.
        response = await self._post(self._payload(messages, temperature, top_p, max_tokens, True))
        if response.content_type != "text/event-stream":
            self.close_response(response)
            raise UpstreamError(502, {"error": {"message": "llama-server 未返回 SSE 事件流"}})
        return response

    async def iter_stream(self, response: aiohttp.ClientResponse) -> AsyncGenerator[bytes, None]:
        try:
            # Preserve comments, reasoning fields, Unicode, CRLF, event separators,
            # and [DONE] verbatim. Do not parse/re-encode or invent completion events.
            async for chunk in response.content.iter_any():
                yield chunk
        finally:
            self.close_response(response)

    async def chat_completion_stream(self, messages: list, temperature: float = 0.7, top_p: float = 0.9,
                                     max_tokens: Optional[int] = None) -> AsyncGenerator[bytes, None]:
        response = await self.open_stream(messages, temperature, top_p, max_tokens)
        try:
            async for chunk in self.iter_stream(response):
                yield chunk
        finally:
            self.close_response(response)


chat_handler = ChatHandler()
