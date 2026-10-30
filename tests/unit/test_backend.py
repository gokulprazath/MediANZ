"""healthmcp.backend: the single ASGI app the Vercel "backend" service runs."""

from __future__ import annotations

from typing import Any, cast

import httpx

from healthmcp.backend import REGISTRARS, create_backend, create_vercel_app
from healthmcp.discovery.app import create_app as create_discovery_app
from healthmcp.servers.common import build
from healthmcp.shared.auth import StaticKeyProvider, TokenVerifier
from healthmcp.shared.config import Settings
from healthmcp.shared.repositories import fake_repositories
from healthmcp.shared.repositories.fake_data import OLIVIA_AUTH_USER
from healthmcp.shared.server import build_deps
from healthmcp.shared.tool_catalog import SERVERS
from tests.conftest import make_settings
from tests.helpers import user_token
from tests.unit.test_discovery_api import FakeIdentity, FakeRepository, FakeVerifier


def _backend(settings: Settings | None = None) -> Any:
    settings = settings or make_settings()
    verifier = TokenVerifier(settings, StaticKeyProvider({"keys": []}))
    servers = {
        name: build(
            name, register, deps=build_deps(settings, repos=fake_repositories(), verifier=verifier)
        )
        for name, register in REGISTRARS.items()
    }
    discovery = create_discovery_app(
        settings=settings,
        database=cast(Any, object()),
        repository=cast(Any, FakeRepository()),
        identity=cast(Any, FakeIdentity(None)),
        verifier=cast(TokenVerifier, FakeVerifier()),
    )
    return create_backend(settings, servers=servers, discovery_app=discovery)


def _http(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend")


async def test_agent_reaches_the_servers_through_the_in_process_gateway() -> None:
    app = _backend()
    async with app.router.lifespan_context(app):
        factory = app.state.agent_service._tool_factory
        async with factory.open(user_token(OLIVIA_AUTH_USER), "insights") as connection:
            names = {tool.name for tool in await connection.list_tools()}
        # The gateway still filters by the agent's allowlist (config/agents.json).
        assert names == {
            "patient_record__get_approved_facts",
            "patient_record__get_observations",
            "patient_record__get_appointments",
            "matching__get_patient_gp_preferences",
        }
        async with factory.open(user_token(OLIVIA_AUTH_USER), "booking") as connection:
            names = {tool.name for tool in await connection.list_tools()}
        assert "booking__propose_booking" in names
        assert not any(name.startswith("extraction__") for name in names)


async def test_only_the_agent_and_discovery_apis_are_mounted() -> None:
    app = _backend()
    async with app.router.lifespan_context(app), _http(app) as http:
        assert (await http.get("/healthz")).json()["mcp_servers"] == sorted(SERVERS)
        assert (await http.get("/agent/healthz")).json() == {"status": "ok", "server": "agent"}
        assert (await http.get("/discovery/healthz")).json() == {"status": "ok"}
        assert (await http.post("/agent/chat", json={"message": "hi"})).status_code == 401
        # The gateway and the MCP servers have no route of their own.
        assert (await http.post("/mcp", json={})).status_code == 404
        assert (await http.get("/gateway/healthz")).status_code == 404


async def test_vercel_app_builds_lazily_once() -> None:
    built: list[int] = []

    def factory() -> Any:
        built.append(1)
        return _backend()

    app = create_vercel_app(factory)
    assert built == []  # nothing at import: no secrets needed to build the bundle
    # No lifespan events (some platforms): the first request builds it.
    async with _http(app) as http:
        assert (await http.get("/agent/healthz")).status_code == 200
        assert (await http.get("/healthz")).status_code == 200
    assert built == [1]
    await app.state.backend.stop()

    async with app.router.lifespan_context(app):
        assert app.state.backend.started
    assert built == [1, 1]
    assert not app.state.backend.started
