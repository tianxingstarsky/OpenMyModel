"""Run: python -m unittest discover -s python/tests -v"""

import asyncio
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from unittest.mock import AsyncMock, patch

# unittest discovery adds tests/, not the sibling bridge modules, to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import aiohttp
from aiohttp import web
import httpx
import uvicorn

import bridge_server as bridge
from chat_handler import ChatHandler, UpstreamError
from config_manager import ConfigManager, ProfileNameError
from server_manager import ServerConfig, ServerManager


class FakeProcess:
    def __init__(self, output="", returncode=None, stubborn=False):
        self.stdout = io.StringIO(output)
        self.returncode = returncode
        self.pid = 12345
        self.terminated = 0
        self.killed = 0
        self.stubborn = stubborn

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated += 1
        if not self.stubborn:
            self.returncode = 0

    def kill(self):
        self.killed += 1
        self.returncode = -9

    def wait(self, timeout=None):
        if self.returncode is None:
            raise subprocess.TimeoutExpired("fake-owned-process", timeout)
        return self.returncode


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = ConfigManager(self.temp.name)

    def test_chinese_spaces_and_legacy_valid_names_round_trip(self):
        for name in ("中文 模型", "my-model.v1_测试", " spaced ", "trailing."):
            with self.subTest(name=name):
                config = ServerConfig(port=9123, model_path="模型.gguf")
                self.assertTrue(self.manager.save(name, config))
                self.assertEqual(self.manager.load(name), config)
                self.assertEqual(self.manager._profile_path(name).stem, name)
                self.assertTrue(self.manager.delete(name))
                self.assertFalse(self.manager.delete(name))

    def test_invalid_names_do_not_silently_alias(self):
        self.manager.save("ab", ServerConfig())
        for name in ("", "   ", ".", "..", "a/b", "a\\b", "../ab", "a:b", "a?b", "a\nb", "CON", "nul.txt", "LPT1", "x" * 201):
            with self.subTest(name=name):
                for operation in (self.manager.load, self.manager.delete):
                    with self.assertRaises(ProfileNameError):
                        operation(name)
                with self.assertRaises(ProfileNameError):
                    self.manager.save(name, ServerConfig())
        self.assertIsNotNone(self.manager.load("ab"))

    def test_case_collision_is_explicit(self):
        self.manager.save("Model", ServerConfig())
        with self.assertRaises(ProfileNameError):
            self.manager.save("model", ServerConfig(port=9191))
        self.assertEqual(self.manager.load("Model").port, 8080)

    def test_atomic_failure_preserves_original_and_is_not_hidden(self):
        self.manager.save("模型", ServerConfig(port=8001))
        path = self.manager._profile_path("模型")
        original = path.read_bytes()
        with patch("config_manager.os.replace", side_effect=PermissionError("read only")):
            with self.assertRaises(PermissionError):
                self.manager.save("模型", ServerConfig(port=8002))
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(list(Path(self.temp.name).glob("*.tmp")), [])

    def test_preserve_created_at_and_report_corrupt_file(self):
        self.manager.save("test", ServerConfig())
        path = self.manager._profile_path("test")
        created = json.loads(path.read_text("utf-8"))["created_at"]
        self.manager.save("test", ServerConfig(port=8081))
        self.assertEqual(json.loads(path.read_text("utf-8"))["created_at"], created)
        path.write_text("{invalid", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.manager.load("test")
        with self.assertRaises(ValueError):
            self.manager.save("test", ServerConfig())
        self.assertIsNone(self.manager.load("missing"))


class ServerManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        exe, model = root / "server.exe", root / "model.gguf"
        exe.touch()
        model.touch()
        self.config = ServerConfig(server_path=str(exe), model_path=str(model), api_key="secret-123")
        self.manager = ServerManager()
        self.addCleanup(self.manager.stop)

    def test_concurrent_start_stop_are_idempotent_and_owned(self):
        process = FakeProcess()
        with patch("server_manager.subprocess.Popen", return_value=process) as popen:
            with ThreadPoolExecutor(max_workers=8) as pool:
                started = list(pool.map(lambda _: self.manager.start(self.config), range(12)))
            self.assertTrue(all(item is process for item in started))
            self.assertEqual(popen.call_count, 1)
            self.assertFalse(self.manager.get_status()["ready"])
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: self.manager.stop(), range(12)))
        self.assertEqual(process.terminated, 1)
        self.assertEqual(process.killed, 0)
        self.assertFalse(self.manager.is_running())

    def test_reconfigure_running_requires_stop_and_failed_start_preserves_config(self):
        with patch("server_manager.subprocess.Popen", return_value=FakeProcess()):
            self.manager.start(self.config)
        different = ServerConfig(**{**asdict(self.config), "port": 9000})
        with self.assertRaises(RuntimeError):
            self.manager.start(different)
        self.assertEqual(self.manager.config.port, 8080)
        self.manager.stop()
        with patch("server_manager.subprocess.Popen", side_effect=OSError("failed secret-123")):
            with self.assertRaisesRegex(RuntimeError, "REDACTED"):
                self.manager.start(different)
        self.assertEqual(self.manager.config.port, 8080)
        self.assertNotIn("secret-123", json.dumps(self.manager.get_status()))

    def test_poll_controls_running_uptime_ready_and_exit_diagnostics(self):
        process = FakeProcess()
        with patch("server_manager.subprocess.Popen", return_value=process):
            self.manager.start(self.config)
        self.manager.set_ready(process, True)
        self.assertTrue(self.manager.get_status()["ready"])
        self.manager.set_ready(FakeProcess(), False)
        self.assertTrue(self.manager.get_status()["ready"])
        process.returncode = 17
        status = self.manager.get_status()
        self.assertFalse(status["running"])
        self.assertFalse(status["ready"])
        self.assertEqual(status["uptime"], 0)
        self.assertEqual(status["exit_code"], 17)
        self.assertIn("17", status["last_error"])

    def test_stdout_is_drained_bounded_and_secret_redacted(self):
        process = FakeProcess("".join(f"line {i} secret-123\n" for i in range(150)))
        with patch("server_manager.subprocess.Popen", return_value=process):
            self.manager.start(self.config)
        self.manager._reader.join(timeout=1)
        status = self.manager.get_status()
        self.assertEqual(len(status["log_tail"]), 100)
        self.assertIn("line 149 [REDACTED]", status["log_tail"][-1])
        self.assertNotIn("secret-123", json.dumps(status))
        self.assertTrue(process.stdout.closed)

    def test_oversized_logs_cannot_split_and_leak_api_key(self):
        process = FakeProcess("x" * 4092 + "secret-123" + "y" * 5000 + "\nnext line\n")
        with patch("server_manager.subprocess.Popen", return_value=process):
            self.manager.start(self.config)
        self.manager._reader.join(timeout=1)
        self.assertEqual(self.manager.get_status()["log_tail"], ["[oversized log line omitted]", "next line"])

    def test_stop_escalates_only_owned_process(self):
        unrelated = FakeProcess()
        owned = FakeProcess(stubborn=True)
        with patch("server_manager.subprocess.Popen", return_value=owned):
            self.manager.start(self.config)
        self.manager.stop()
        self.manager.stop()
        self.assertEqual(owned.terminated, 1)
        self.assertEqual(owned.killed, 1)
        self.assertEqual(unrelated.terminated, 0)
        self.assertIsNone(unrelated.poll())

    def test_immediate_exit_has_diagnostics(self):
        with patch("server_manager.subprocess.Popen", return_value=FakeProcess("model load failed\n", returncode=2)):
            with self.assertRaisesRegex(RuntimeError, "exit code 2"):
                self.manager.start(self.config)
        self.assertIn("model load failed", self.manager.get_status()["log_tail"])

    def test_extra_args_preserve_quotes_without_endpoint_override(self):
        self.config.extra_args = '--alias "Chinese model" --chat-template-file "C:\\my models\\template.jinja"'
        command = self.manager.build_command(self.config)
        self.assertIn("Chinese model", command)
        self.assertIn("C:\\my models\\template.jinja", command)
        for arg in ("--port 1234", "--host=example.com", "--api-key secret", "--api-key-file key.txt"):
            self.config.extra_args = arg
            with self.assertRaises(ValueError):
                self.manager.build_command(self.config)


class BridgeHTTPTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.manager = ServerManager()
        self.handler = ChatHandler()
        self.profiles = ConfigManager(self.temp.name)
        self.patches = [patch.object(bridge, "server_manager", self.manager),
                        patch.object(bridge, "chat_handler", self.handler),
                        patch.object(bridge, "config_manager", self.profiles)]
        for item in self.patches:
            item.start()
        self.requests = []
        self.error_status = 0
        self.health_status = 503
        self.non_sse = False
        self.slow_stream = False
        self.delay_headers = False
        self.delay_health = False
        self.upstream_received = asyncio.Event()
        self.upstream_closed = asyncio.Event()
        self.raw_sse = ': heartbeat\r\nevent: message\r\ndata: {"choices":[{"delta":{"content":"中","reasoning_content":"思"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'.encode()
        upstream = web.Application()
        upstream.router.add_post("/v1/chat/completions", self.handle_chat)
        upstream.router.add_get("/health", self.handle_health)
        self.runner = web.AppRunner(upstream)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await self.site.start()
        self.port = self.site._server.sockets[0].getsockname()[1]
        self.handler.configure("127.0.0.1", self.port, "test-api-key")
        self.manager.process = FakeProcess()
        self.manager.config = ServerConfig(port=self.port, api_key="test-api-key")
        self.lifespan = bridge.app.router.lifespan_context(bridge.app)
        await self.lifespan.__aenter__()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=bridge.app, client=("127.0.0.1", 1234)),
                                        base_url="http://127.0.0.1:8765")
        bridge.app.state.bridge_token = "owned-token"
        bridge.app.state.shutdown_callback = AsyncMock()

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.lifespan.__aexit__(None, None, None)
        await self.runner.cleanup()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    async def handle_health(self, request):
        if self.delay_health:
            while request.transport is not None and not request.transport.is_closing():
                await asyncio.sleep(0.01)
        self.assertEqual(request.headers.get("Authorization"), "Bearer test-api-key")
        return web.json_response({"status": "ok" if self.health_status == 200 else "loading model"}, status=self.health_status)

    async def handle_chat(self, request):
        payload = await request.json()
        self.requests.append((request.path, request.headers.get("Authorization"), payload))
        self.upstream_received.set()
        if self.delay_headers:
            while request.transport is not None and not request.transport.is_closing():
                await asyncio.sleep(0.01)
            self.upstream_closed.set()
            return web.Response()
        if self.error_status:
            return web.json_response({"error": {"message": "upstream rejected", "code": "test_error"}}, status=self.error_status)
        if not payload.get("stream"):
            return web.json_response({"choices": [{"message": {"content": "", "reasoning_content": "unchanged"}}]})
        if self.non_sse:
            return web.json_response({"error": "not a stream"})
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        try:
            if self.slow_stream:
                await response.write(b": connected\n\n")
                while True:
                    if request.transport is None or request.transport.is_closing():
                        break
                    await asyncio.sleep(0.01)
            else:
                # Deliberately split Unicode and SSE separators across chunks.
                for offset in range(0, len(self.raw_sse), 7):
                    await response.write(self.raw_sse[offset:offset + 7])
                await response.write_eof()
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            if self.slow_stream:
                self.upstream_closed.set()
        return response

    async def test_profile_load_returns_object_not_json_string(self):
        response = await self.client.post("/api/profiles/save", json={"name": "中文 模型", "config": {"port": 9222}})
        self.assertEqual(response.status_code, 200)
        response = await self.client.post("/api/profiles/load", json={"name": "中文 模型"})
        self.assertEqual(response.status_code, 200)
        self.assertIsInstance(response.json(), dict)
        self.assertEqual(response.json()["port"], 9222)
        self.assertNotIn("updated_at", response.json())

    async def test_profile_validation_missing_corrupt_and_write_error(self):
        self.assertEqual((await self.client.post("/api/profiles/load", json={"name": ""})).status_code, 400)
        self.assertEqual((await self.client.post("/api/profiles/load", json={"name": "missing"})).status_code, 404)
        Path(self.temp.name, "bad.json").write_text("bad", encoding="utf-8")
        self.assertEqual((await self.client.post("/api/profiles/load", json={"name": "bad"})).status_code, 500)
        with patch.object(self.profiles, "save", side_effect=PermissionError("denied")):
            response = await self.client.post("/api/profiles/save", json={"name": "test", "config": {}})
        self.assertEqual(response.status_code, 500)

    async def test_sse_is_raw_and_optional_tokens_are_omitted(self):
        response = await self.client.post("/api/chat", json={"messages": []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, self.raw_sse)
        self.assertEqual(response.content.count(b"[DONE]"), 1)
        path, auth, payload = self.requests[-1]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(auth, "Bearer test-api-key")
        self.assertNotIn("max_tokens", payload)
        self.assertTrue(payload["stream"])
        self.assertEqual(len(self.handler._responses), 0)

    async def test_sync_honors_null_and_explicit_tokens_without_reasoning_rewrite(self):
        for endpoint in ("/api/chat/sync", "/api/chat"):
            for value in (None, 87):
                response = await self.client.post(endpoint, json={"messages": [], "max_tokens": value, "stream": False})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["choices"][0]["message"]["content"], "")
                payload = self.requests[-1][2]
                self.assertFalse(payload["stream"])
                if value is None:
                    self.assertNotIn("max_tokens", payload)
                else:
                    self.assertEqual(payload["max_tokens"], value)
        self.assertEqual((await self.client.post("/api/chat", json={"messages": [], "max_tokens": 0})).status_code, 422)

    async def test_upstream_status_json_before_sse_headers_and_sync(self):
        for endpoint in ("/api/chat", "/api/chat/sync"):
            for code in (400, 401, 429, 503):
                self.error_status = code
                response = await self.client.post(endpoint, json={"messages": []})
                self.assertEqual(response.status_code, code)
                self.assertIn("application/json", response.headers["content-type"])
                self.assertEqual(response.json(), {"error": {"message": "upstream rejected", "code": "test_error"}})
        self.assertFalse(self.handler._responses)

    async def test_non_sse_rejected_before_stream_headers(self):
        self.non_sse = True
        response = await self.client.post("/api/chat", json={"messages": []})
        self.assertEqual(response.status_code, 502)
        self.assertIn("application/json", response.headers["content-type"])
        self.assertFalse(self.handler._responses)

    async def test_status_health_not_process_spawn_and_no_secret(self):
        response = await self.client.get("/api/status")
        self.assertTrue(response.json()["running"])
        self.assertFalse(response.json()["ready"])
        self.health_status = 200
        response = await self.client.get("/api/status")
        self.assertTrue(response.json()["ready"])
        self.assertEqual(response.json()["port"], self.port)
        self.assertIn("bridge_id", response.json())
        self.assertEqual(response.json()["bridge_pid"], os.getpid())
        self.assertNotIn("test-api-key", response.text)
        self.manager.process.returncode = 4
        response = await self.client.get("/api/status")
        self.assertFalse(response.json()["running"])
        self.assertFalse(response.json()["ready"])

    async def test_successful_start_configures_runtime_and_failure_does_not(self):
        self.manager.stop()
        config = {"server_path": "test.exe", "model_path": "test.gguf", "host": "0.0.0.0", "port": self.port, "api_key": "test-api-key"}
        with patch.object(self.manager, "build_command", return_value=["test.exe"]), patch("server_manager.subprocess.Popen", return_value=FakeProcess()):
            response = await self.client.post("/api/server/start", json=config)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["ready"])
        self.assertEqual(self.handler.api_base, f"http://127.0.0.1:{self.port}")
        self.assertEqual(self.handler.api_key, "test-api-key")
        config["port"] = 9090
        self.assertEqual((await self.client.post("/api/server/start", json=config)).status_code, 409)
        self.assertEqual(self.handler.api_base, f"http://127.0.0.1:{self.port}")
        self.assertEqual(ChatHandler.endpoint("::", 9001), "http://[::1]:9001")

    async def test_native_loopback_only_and_shutdown_requires_ownership(self):
        callback = bridge.app.state.shutdown_callback
        for headers in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Host": "evil.example:8765"}, {"Sec-Fetch-Site": "cross-site"}):
            response = await self.client.post("/api/server/stop", headers=headers)
            self.assertEqual(response.status_code, 403)
            self.assertNotIn("access-control-allow-origin", response.headers)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=bridge.app, client=("203.0.113.1", 80)), base_url="http://127.0.0.1") as remote:
            self.assertEqual((await remote.post("/api/server/stop")).status_code, 403)
        for token in (None, "wrong"):
            headers = {"X-Bridge-Token": token} if token else {}
            self.assertEqual((await self.client.post("/api/shutdown", headers=headers)).status_code, 403)
        callback.assert_not_awaited()
        response = await self.client.post("/api/shutdown", headers={"X-Bridge-Token": "owned-token"})
        self.assertEqual(response.status_code, 200)
        callback.assert_awaited_once()
        self.assertTrue(bridge.app.state.shutting_down)
        self.assertEqual((await self.client.post("/api/server/start", json={})).status_code, 503)

    async def test_shutdown_disabled_without_launch_token(self):
        bridge.app.state.bridge_token = ""
        response = await self.client.post("/api/shutdown", headers={"X-Bridge-Token": "owned-token"})
        self.assertEqual(response.status_code, 403)

    async def test_cancellation_closes_upstream_immediately(self):
        self.slow_stream = True
        upstream = await self.handler.open_stream([])
        streaming = bridge.UpstreamStreamingResponse(upstream)
        disconnected = asyncio.Event()
        sent = []

        async def send(message):
            sent.append(message)
            if message["type"] == "http.response.body":
                disconnected.set()

        async def receive():
            await disconnected.wait()
            return {"type": "http.disconnect"}

        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}}
        await asyncio.wait_for(streaming(scope, receive, send), timeout=1)
        self.assertTrue(upstream.closed)
        self.assertFalse(self.handler._responses)
        await asyncio.wait_for(self.upstream_closed.wait(), timeout=1)
        self.assertEqual(sent[0]["type"], "http.response.start")

    async def test_disconnect_during_headers_also_closes_response(self):
        self.slow_stream = True
        upstream = await self.handler.open_stream([])
        streaming = bridge.UpstreamStreamingResponse(upstream)

        async def send(message):
            raise OSError("client disconnected")

        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}}
        async def receive():
            await asyncio.Event().wait()

        with self.assertRaises(OSError):
            await streaming(scope, receive, send)
        self.assertTrue(upstream.closed)
        await asyncio.wait_for(self.upstream_closed.wait(), timeout=1)

    async def test_real_client_disconnect_before_upstream_headers_stream_and_sync(self):
        # Exercise uvicorn's actual receive() behavior, not only an ASGI mock.
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(8)
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(bridge.app, host="127.0.0.1", port=port,
                                                lifespan="off", proxy_headers=False,
                                                log_level="warning", timeout_graceful_shutdown=1))
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        try:
            while not server.started:
                await asyncio.sleep(0.01)
            for endpoint in ("/api/chat", "/api/chat/sync"):
                self.delay_headers = True
                self.upstream_received.clear()
                self.upstream_closed.clear()
                reader, writer = await asyncio.open_connection("127.0.0.1", port)
                body = b'{"messages": []}'
                writer.write(f"POST {endpoint} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body)
                await writer.drain()
                await asyncio.wait_for(self.upstream_received.wait(), timeout=1)
                writer.close()
                await writer.wait_closed()
                await asyncio.wait_for(self.upstream_closed.wait(), timeout=1)
                self.assertFalse(self.handler._responses)
        finally:
            server.should_exit = True
            await asyncio.wait_for(serving, timeout=3)
            listener.close()

    async def test_close_session_aborts_inflight_stream_and_can_reopen(self):
        self.slow_stream = True
        upstream = await self.handler.open_stream([])
        old_session = self.handler._session
        await self.handler.close()
        self.assertTrue(upstream.closed)
        self.assertTrue(old_session.closed)
        self.assertIsNone(self.handler._session)
        self.assertIsNot(await self.handler._get_session(), old_session)
        await asyncio.wait_for(self.upstream_closed.wait(), timeout=1)

    async def test_lifespan_stops_owned_process_and_closes_session(self):
        owned = self.manager.process
        session = await self.handler._get_session()
        async with bridge.lifespan(bridge.app):
            pass
        self.assertTrue(session.closed)
        self.assertEqual(owned.terminated, 1)
        self.assertIsNone(self.manager.process)
        self.assertIsNone(self.handler._session)

    async def test_health_timeout_is_bounded_and_does_not_mark_ready(self):
        self.delay_health = True
        self.health_status = 200
        started = time.monotonic()
        response = await self.client.get("/api/status")
        self.assertFalse(response.json()["ready"])
        self.assertGreater(time.monotonic() - started, 0.9)
        self.assertLess(time.monotonic() - started, 1.5)

    async def test_cancelled_lifecycle_waits_for_worker_and_keeps_runtime_config(self):
        self.manager.stop()
        entered = threading.Event()
        release = threading.Event()
        config = bridge.ConfigModel(host="127.0.0.1", port=9144, api_key="cancel-test")

        def slow_start(*args):
            entered.set()
            release.wait(timeout=2)

        with patch.object(self.manager, "start", side_effect=slow_start):
            starting = asyncio.create_task(bridge.start_server(config))
            while not entered.is_set():
                await asyncio.sleep(0.001)
            starting.cancel()
            await asyncio.sleep(0.01)
            self.assertTrue(bridge.app.state.lifecycle_lock.locked())
            self.assertFalse(starting.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await starting
        self.assertFalse(bridge.app.state.lifecycle_lock.locked())
        self.assertEqual(self.handler.api_base, "http://127.0.0.1:9144")
        self.assertEqual(self.handler.api_key, "cancel-test")

    async def test_slow_process_start_does_not_block_event_loop(self):
        self.manager.stop()
        entered = threading.Event()
        finished = threading.Event()

        def slow_start(config, work_dir):
            entered.set()
            time.sleep(0.15)
            finished.set()

        with patch.object(self.manager, "start", side_effect=slow_start):
            task = asyncio.create_task(self.client.post("/api/server/start", json={}))
            while not entered.is_set():
                await asyncio.sleep(0.001)
            await asyncio.sleep(0.01)
            self.assertFalse(finished.is_set())
            self.assertEqual((await task).status_code, 200)


if __name__ == "__main__":
    unittest.main()
