"""Build a real server (auth gate, MCP, tool wrapper) over Fake repositories."""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

from mcp import ClientSession

from healthmcp.shared.auth import StaticKeyProvider, TokenVerifier
from healthmcp.shared.config import Settings
from healthmcp.shared.repositories import Repositories, fake_repositories
from healthmcp.shared.repositories.audit import FakeAuditRepository
from healthmcp.shared.repositories.fake_data import OLIVIA, OLIVIA_APPROVED_APPOINTMENT
from healthmcp.shared.server import HealthServer, build_deps, create_server
from tests.conftest import make_settings
from tests.helpers import job_token, mcp_session, running, user_token

Register = Callable[[HealthServer], None]


def make_server(
    name: str,
    register: Register,
    *,
    settings: Settings | None = None,
    repos: Repositories | None = None,
) -> HealthServer:
    settings = settings or make_settings()
    deps = build_deps(
        settings,
        repos=repos or fake_repositories(),
        verifier=TokenVerifier(settings, StaticKeyProvider({"keys": []})),
    )
    server = create_server(name, deps=deps)
    register(server)
    return server


def user_headers(auth_user: Any, agent: str = "patient-assistant") -> dict[str, str]:
    return {"Authorization": f"Bearer {user_token(auth_user)}", "X-Agent-Id": agent}


def job_headers(agent: str = "clinical-doc-agent", **claims: Any) -> dict[str, str]:
    claims.setdefault("appointment_id", OLIVIA_APPROVED_APPOINTMENT)
    claims.setdefault("patient_id", OLIVIA)
    return {"Authorization": f"Bearer {job_token(agent, **claims)}"}


@asynccontextmanager
async def session(server: HealthServer, headers: dict[str, str]) -> AsyncIterator[ClientSession]:
    async with running(server) as transport, mcp_session(transport, server, headers) as s:
        yield s


async def call(s: ClientSession, tool: str, **arguments: Any) -> dict[str, Any]:
    """Call a tool; return its structured result, or {"error": message}."""
    result = await s.call_tool(tool, arguments)
    if result.is_error:
        text = " ".join(getattr(c, "text", "") for c in result.content)
        return {"error": text}
    assert result.structured_content is not None, tool
    return dict(result.structured_content)


def audit(server: HealthServer) -> FakeAuditRepository:
    repo = server.deps.repos.audit
    assert isinstance(repo, FakeAuditRepository)
    return repo
