from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any

import httpx
import httpx2
import pytest
from mcp import ClientSession, MCPError
from mcp.client.streamable_http import streamable_http_client
from starlette.applications import Starlette
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Route

from healthmcp.gateway.app import GatewayConfig, create_app
from healthmcp.gateway.proxy import GatewayProxy
from healthmcp.shared.repositories.fake_data import (
    OLIVIA,
    OLIVIA_APPROVED_APPOINTMENT,
    OLIVIA_AUTH_USER,
)
from tests.helpers import job_token, user_token
from tests.unit.test_server import _server

PATIENT_HEADERS = {
    "X-Agent-Id": "patient-assistant",
    "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}",
}
JOB_HEADERS = {
    "Authorization": f"Bearer {job_token(appointment_id=OLIVIA_APPROVED_APPOINTMENT, patient_id=OLIVIA)}"
}
GATEWAY_URL = "http://127.0.0.1:3100"


@asynccontextmanager
async def _gateway(
    names: tuple[str, ...] = ("booking", "patient_record", "transcript"),
) -> AsyncIterator[Starlette]:
    async with AsyncExitStack() as stack:
        servers = {name: _server(name) for name in names}
        clients: dict[str, httpx.AsyncClient] = {}
        for name, server in servers.items():
            await stack.enter_async_context(server.app.router.lifespan_context(server.app))
            client = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=server.app),
                base_url=f"http://127.0.0.1:{server.port}",
            )
            clients[name] = client
            stack.push_async_callback(client.aclose)
        upstreams = {name: f"http://127.0.0.1:{s.port}/mcp" for name, s in servers.items()}
        proxy = GatewayProxy(upstreams, clients=clients)
        config = GatewayConfig(
            host="127.0.0.1",
            port=3100,
            upstreams=upstreams,
            timeout=10,
            max_request_bytes=262144,
        )
        app = create_app(config, proxy=proxy)
        await stack.enter_async_context(app.router.lifespan_context(app))
        yield app


@asynccontextmanager
async def _session(app: Starlette, headers: dict[str, str]) -> AsyncIterator[ClientSession]:
    http = httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url=GATEWAY_URL,
        headers=headers,
    )
    async with (
        http,
        streamable_http_client(f"{GATEWAY_URL}/mcp", http_client=http) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        yield session


async def _post(
    app: Starlette, body: Any, headers: dict[str, str] | None = None
) -> httpx2.Response:
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app),
        base_url=GATEWAY_URL,
        headers=headers or {},
    ) as http:
        if isinstance(body, bytes):
            return await http.post(
                "/mcp", content=body, headers={"content-type": "application/json"}
            )
        return await http.post("/mcp", json=body)


async def test_patient_token_sees_only_patient_tools() -> None:
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        tools = {tool.name for tool in (await session.list_tools()).tools}
    assert tools == {
        "booking__get_proposal_status",
        "booking__log_note",
        "patient_record__get_appointments",
        "patient_record__log_note",
    }


async def test_job_token_sees_only_job_tools() -> None:
    async with _gateway() as app, _session(app, JOB_HEADERS) as session:
        tools = {tool.name for tool in (await session.list_tools()).tools}
    assert tools == {
        "patient_record__get_appointments",
        "patient_record__log_note",
        "transcript__get_processing_eligibility",
        "transcript__log_note",
    }


async def test_call_routes_to_the_right_upstream() -> None:
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        result = await session.call_tool("booking__get_proposal_status", {})
    assert result.structured_content == {
        "mode": "user",
        "agent_id": "patient-assistant",
        "patient_id": str(OLIVIA),
        "appointment_id": None,
    }


async def test_agent_can_chain_tools_from_two_servers() -> None:
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        first = await session.call_tool("patient_record__get_appointments", {})
        second = await session.call_tool("booking__get_proposal_status", {})
    assert first.structured_content is not None
    assert second.structured_content is not None
    assert first.structured_content["agent_id"] == "patient-assistant"
    assert second.structured_content["agent_id"] == "patient-assistant"


async def test_patient_cannot_call_a_clinical_tool() -> None:
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        with pytest.raises(MCPError, match="Tool not available"):
            await session.call_tool("transcript__get_processing_eligibility", {})


async def test_job_token_cannot_call_a_patient_tool() -> None:
    async with _gateway() as app, _session(app, JOB_HEADERS) as session:
        with pytest.raises(MCPError, match="Tool not available"):
            await session.call_tool("booking__get_proposal_status", {})


@pytest.mark.parametrize(
    "name",
    ["no_prefix", "unknown__tool", "booking__not_a_tool", "booking__x__y"],
)
async def test_unknown_tool_names_are_rejected(name: str) -> None:
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        with pytest.raises(MCPError, match=r"Invalid tool name|Tool not available"):
            await session.call_tool(name, {})


async def test_missing_upstream_is_skipped_but_others_still_work() -> None:
    async def broken(request: Any) -> PlainTextResponse:
        return PlainTextResponse("down", status_code=500)

    broken_app = Starlette(routes=[Route("/mcp", broken, methods=["POST"])])
    clients = {}
    async with AsyncExitStack() as stack:
        good = _server("booking")
        await stack.enter_async_context(good.app.router.lifespan_context(good.app))
        good_client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=good.app),
            base_url=f"http://127.0.0.1:{good.port}",
        )
        stack.push_async_callback(good_client.aclose)
        broken_client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=broken_app),
            base_url="http://127.0.0.1:3999",
        )
        stack.push_async_callback(broken_client.aclose)
        clients = {"booking": good_client, "transcript": broken_client}
        upstreams = {
            "booking": f"http://127.0.0.1:{good.port}/mcp",
            "transcript": "http://127.0.0.1:3999/mcp",
        }
        proxy = GatewayProxy(upstreams, clients=clients)
        config = GatewayConfig("127.0.0.1", 3100, upstreams, 10, 262144)
        app = create_app(config, proxy=proxy)
        async with _session(app, PATIENT_HEADERS) as session:
            tools = {tool.name for tool in (await session.list_tools()).tools}
            assert tools == {"booking__get_proposal_status", "booking__log_note"}
            result = await session.call_tool("booking__get_proposal_status", {})
            assert result.structured_content is not None
            with pytest.raises(MCPError, match="Upstream unavailable"):
                await session.call_tool("transcript__get_processing_eligibility", {})


async def test_upstream_error_text_is_not_forwarded() -> None:
    secret = "patient-name-and-token"

    async def failing(request: Any) -> JSONResponse:
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {"code": -32000, "message": f"leaked {secret}"},
            }
        )

    failing_app = Starlette(routes=[Route("/mcp", failing, methods=["POST"])])
    async with AsyncExitStack() as stack:
        good = _server("patient_record")
        await stack.enter_async_context(good.app.router.lifespan_context(good.app))
        good_client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=good.app),
            base_url=f"http://127.0.0.1:{good.port}",
        )
        stack.push_async_callback(good_client.aclose)
        failing_client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=failing_app),
            base_url="http://127.0.0.1:3998",
        )
        stack.push_async_callback(failing_client.aclose)
        upstreams = {
            "booking": "http://127.0.0.1:3998/mcp",
            "patient_record": f"http://127.0.0.1:{good.port}/mcp",
        }
        proxy = GatewayProxy(
            upstreams, clients={"booking": failing_client, "patient_record": good_client}
        )
        config = GatewayConfig("127.0.0.1", 3100, upstreams, 10, 262144)
        app = create_app(config, proxy=proxy)
        async with _session(app, PATIENT_HEADERS) as session:
            with pytest.raises(MCPError) as exc_info:
                await session.call_tool("booking__get_proposal_status", {})
    assert "leaked" not in str(exc_info.value)
    assert secret not in str(exc_info.value)


async def test_initialize_ping_and_healthz() -> None:
    async with _gateway() as app:
        init = await _post(
            app,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {}},
            },
        )
        ping = await _post(app, {"jsonrpc": "2.0", "id": 2, "method": "ping"})
        notification = await _post(app, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        async with httpx2.AsyncClient(
            transport=httpx2.ASGITransport(app=app), base_url=GATEWAY_URL
        ) as http:
            health = await http.get("/healthz")
            get_mcp = await http.get("/mcp")
    assert init.status_code == 200
    assert init.json()["result"]["serverInfo"]["name"] == "healthmcp-gateway"
    assert init.json()["result"]["protocolVersion"] == "2025-06-18"
    assert ping.json()["result"] == {}
    assert notification.status_code == 202
    assert health.json() == {"status": "ok", "server": "gateway"}
    assert get_mcp.status_code == 405


async def test_invalid_json_and_request_size() -> None:
    async with _gateway() as app:
        invalid = await _post(app, b"{")
        error = await _post(
            app,
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            headers={"content-length": "999999"},
        )
    assert invalid.json()["error"]["code"] == -32700
    assert error.json()["error"]["code"] == -32600


async def test_token_is_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("INFO")
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        await session.list_tools()
    assert PATIENT_HEADERS["Authorization"] not in caplog.text


async def test_tool_schema_and_description_are_preserved() -> None:
    async with _gateway() as app, _session(app, PATIENT_HEADERS) as session:
        tools = {tool.name: tool for tool in (await session.list_tools()).tools}
    tool = tools["booking__get_proposal_status"]
    assert tool.description == "[booking]"
    assert tool.input_schema["type"] == "object"


async def test_proxy_does_not_expose_server_without_auth() -> None:
    async with _gateway() as app:
        response = await _post(
            app,
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
        )
    assert response.status_code == 200
    assert response.json()["result"]["tools"] == []
