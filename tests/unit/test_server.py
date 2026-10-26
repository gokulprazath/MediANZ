"""The server factory end to end, in process: HTTP auth gate + MCP + tool wrapper."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from mcp import MCPError
from pydantic import BaseModel

from healthmcp.shared.auth import StaticKeyProvider, TokenVerifier
from healthmcp.shared.config import Settings
from healthmcp.shared.context import current_context
from healthmcp.shared.repositories import fake_repositories
from healthmcp.shared.repositories.audit import FakeAuditRepository
from healthmcp.shared.repositories.fake_data import (
    DR_RAO_AUTH_USER,
    OLIVIA,
    OLIVIA_APPROVED_APPOINTMENT,
    OLIVIA_AUTH_USER,
)
from healthmcp.shared.server import HealthServer, RateLimiter, build_deps, create_server
from tests.conftest import make_settings
from tests.helpers import http_client, job_token, mcp_session, running, user_token

PATIENT_HEADERS = {"X-Agent-Id": "patient-assistant"}


class WhoAmI(BaseModel):
    mode: str
    agent_id: str
    patient_id: str | None
    appointment_id: str | None


def _server(name: str, settings: Settings | None = None) -> HealthServer:
    settings = settings or make_settings()
    deps = build_deps(
        settings,
        repos=fake_repositories(),
        verifier=TokenVerifier(settings, StaticKeyProvider({"keys": []})),
    )
    server = create_server(name, deps=deps)

    # A stand-in implementation under a spec tool name, to observe the Context.
    tool = {
        "booking": "get_proposal_status",
        "patient_record": "get_appointments",
        "transcript": "get_processing_eligibility",
    }[name]

    async def whoami() -> WhoAmI:
        ctx = current_context()
        return WhoAmI(
            mode=ctx.mode,
            agent_id=ctx.agent_id,
            patient_id=str(ctx.patient_id) if ctx.patient_id else None,
            appointment_id=str(ctx.appointment_id) if ctx.appointment_id else None,
        )

    server.tool(name=tool)(whoami)
    return server


def _audit(server: HealthServer) -> FakeAuditRepository:
    audit = server.deps.repos.audit
    assert isinstance(audit, FakeAuditRepository)
    return audit


async def test_healthz_needs_no_token() -> None:
    server = _server("booking")
    async with running(server) as transport, http_client(transport, server, {}) as http:
        response = await http.get("/healthz")
    assert response.status_code == 200 and response.json() == {"status": "ok", "server": "booking"}


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Basic abc"},
        {"Authorization": "Bearer not-a-token"},
        {"Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER, role='service_role')}"},
    ],
    ids=["none", "basic", "garbage", "service-role-jwt"],
)
async def test_requests_without_valid_token_are_401(headers: dict[str, str]) -> None:
    server = _server("booking")
    async with running(server) as transport, http_client(transport, server, headers) as http:
        response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status_code == 401


async def test_user_mode_context_comes_from_token_not_arguments() -> None:
    server = _server("booking")
    headers = {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"}
    async with running(server) as transport, mcp_session(transport, server, headers) as session:
        tools = {t.name for t in (await session.list_tools()).tools}
        result = await session.call_tool("get_proposal_status", {})
    assert tools == {"get_proposal_status", "log_note"}
    assert result.structured_content == {
        "mode": "user",
        "agent_id": "patient-assistant",
        "patient_id": str(OLIVIA),
        "appointment_id": None,
    }
    access = _audit(server).access[-1]
    assert (access.tool, access.ok, access.patient_id) == ("get_proposal_status", True, OLIVIA)


async def test_signed_in_user_without_patient_profile() -> None:
    server = _server("booking")
    headers = {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(DR_RAO_AUTH_USER)}"}
    async with running(server) as transport, mcp_session(transport, server, headers) as session:
        result = await session.call_tool("get_proposal_status", {})
    assert result.structured_content is not None
    assert result.structured_content["patient_id"] is None


async def test_job_mode_context() -> None:
    server = _server("transcript")
    token = job_token(appointment_id=OLIVIA_APPROVED_APPOINTMENT, patient_id=OLIVIA)
    async with (
        running(server) as transport,
        mcp_session(transport, server, {"Authorization": f"Bearer {token}"}) as session,
    ):
        result = await session.call_tool("get_processing_eligibility", {})
    assert result.structured_content == {
        "mode": "job",
        "agent_id": "clinical-doc-agent",
        "patient_id": str(OLIVIA),
        "appointment_id": str(OLIVIA_APPROVED_APPOINTMENT),
    }


@pytest.mark.parametrize(
    ("server_name", "headers"),
    [
        # research-job is not allowed on the transcript server
        ("transcript", {"Authorization": f"Bearer {job_token('research-job')}"}),
        # patient agent cannot use job-only servers
        (
            "transcript",
            {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"},
        ),
        # clinical agent cannot use booking
        ("booking", {"Authorization": f"Bearer {job_token()}"}),
        # unknown agent
        (
            "booking",
            {"X-Agent-Id": "evil-agent", "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"},
        ),
        # user token without an agent id
        ("booking", {"Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"}),
        # job token whose header claims a different agent
        (
            "transcript",
            {"X-Agent-Id": "patient-assistant", "Authorization": f"Bearer {job_token()}"},
        ),
        # a patient agent cannot present a job token for itself (wrong mode)
        ("booking", {"Authorization": f"Bearer {job_token('patient-assistant')}"}),
    ],
    ids=[
        "research-on-transcript",
        "patient-on-transcript",
        "clinical-on-booking",
        "unknown-agent",
        "no-agent-header",
        "header-mismatch",
        "patient-job-token",
    ],
)
async def test_agents_not_on_the_allowlist_are_rejected(
    server_name: str, headers: dict[str, str]
) -> None:
    server = _server(server_name)
    async with running(server) as transport, http_client(transport, server, headers) as http:
        response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status_code == 403


async def test_tool_outside_allowlist_is_refused_at_call_time() -> None:
    server = _server("patient_record")
    headers = {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"}

    async def get_eligibility() -> str:
        return "should not run"

    # Registered, but remove it from the patient agent's allowlist for this test.
    server.tool(name="get_eligibility")(get_eligibility)
    allowed = server.deps.allowlist._agents["patient-assistant"].servers
    allowed["patient_record"] = allowed["patient_record"] - {"get_eligibility"}
    async with running(server) as transport, mcp_session(transport, server, headers) as session:
        names = {t.name for t in (await session.list_tools()).tools}
        assert "get_eligibility" not in names
        with pytest.raises(MCPError):
            await session.call_tool("get_eligibility", {})
    assert _audit(server).access[-1].error_code == "agent_not_allowed"


async def test_body_size_limit() -> None:
    server = _server("booking", make_settings(max_request_bytes=2048))
    headers = {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"}
    async with running(server) as transport, http_client(transport, server, headers) as http:
        response = await http.post(
            "/mcp", content=b"{" + b" " * 4096 + b"}", headers={"content-type": "application/json"}
        )
    assert response.status_code == 413


async def test_rate_limit_per_agent() -> None:
    server = _server("booking", make_settings(rate_limit_per_minute=2))
    headers = {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"}
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": "ping"}
    async with running(server) as transport, http_client(transport, server, headers) as http:
        codes = [(await http.post("/mcp", json=body)).status_code for _ in range(3)]
    assert codes[-1] == 429 and 429 not in codes[:2]
    assert _audit(server).access[-1].error_code == "rate_limited"


def test_rate_limiter_window() -> None:
    limiter = RateLimiter(2)
    assert limiter.allow("a", now=0) and limiter.allow("a", now=1)
    assert not limiter.allow("a", now=2)
    assert limiter.allow("b", now=2)
    assert limiter.allow("a", now=61)


def test_only_spec_tools_can_be_registered() -> None:
    server = _server("booking")

    async def run_sql(sql: str) -> str:
        return sql

    with pytest.raises(ValueError):
        server.tool()(run_sql)
    with pytest.raises(ValueError):
        server.tool(name="decide_batch")(run_sql)  # belongs to another server


def test_create_server_requires_database_url_for_pg() -> None:
    with pytest.raises(ValueError):
        create_server("booking", settings=make_settings(data_backend="pg"))


def test_create_server_with_pg_settings_does_not_connect() -> None:
    settings = make_settings(
        data_backend="pg", database_url="postgresql://u:p@db.invalid:5432/postgres"
    )
    server = create_server("booking", settings=settings)
    assert server.port == 3106 and server.deps.db is not None


def test_ports_match_spec() -> None:
    expected = {
        "transcript": 3101,
        "decision": 3102,
        "extraction": 3103,
        "patient_record": 3104,
        "matching": 3105,
        "booking": 3106,
        "web_research": 3107,
    }
    for name, port in expected.items():
        assert create_server(name, settings=make_settings()).port == port


def test_unknown_server_name() -> None:
    with pytest.raises(KeyError):
        create_server("sql_runner", settings=make_settings())


def test_every_server_has_log_note() -> None:
    server = create_server("web_research", settings=make_settings())
    assert server.mcp._tool_manager.get_tool("log_note") is not None


async def test_patient_cannot_be_chosen_by_argument() -> None:
    """Even if a tool had a patient_id parameter, the Context is what tools read."""
    server = _server("booking")
    headers = {**PATIENT_HEADERS, "Authorization": f"Bearer {user_token(OLIVIA_AUTH_USER)}"}
    async with running(server) as transport, mcp_session(transport, server, headers) as session:
        result = await session.call_tool("get_proposal_status", {"patient_id": str(uuid.uuid4())})
    assert result.structured_content is not None
    assert result.structured_content["patient_id"] == str(OLIVIA)
