"""db.py role switching and query scoping, without a database."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

import pytest

from healthmcp.shared.db import (
    ScopedConnection,
    apply_infra_role,
    apply_job_role,
    apply_user_role,
)
from healthmcp.shared.errors import ScopeViolation
from tests.conftest import ROOT
from tests.helpers import job_context, user_context

APPT = uuid.UUID("60000000-0000-4000-8000-000000000002")
SRC = ROOT / "src" / "healthmcp"


class RecordingConn:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def execute(self, query: Any, params: Any = None) -> RecordingConn:
        self.calls.append((str(query), params))
        return self

    async def fetchall(self) -> list[dict[str, Any]]:
        return []

    async def fetchone(self) -> dict[str, Any] | None:
        return None

    rowcount = 0


async def test_user_role_sets_claims_and_never_service_role() -> None:
    conn = RecordingConn()
    user = uuid.uuid4()
    ctx = user_context(user, uuid.uuid4())
    await apply_user_role(conn, ctx)
    assert conn.calls[0][0] == "set local role authenticated"
    sql, params = conn.calls[1]
    assert "request.jwt.claims" in sql
    assert json.loads(params[0])["sub"] == str(user)
    assert all("service_role" not in c[0] for c in conn.calls)


async def test_roles_refuse_the_wrong_mode() -> None:
    conn = RecordingConn()
    with pytest.raises(ScopeViolation):
        await apply_user_role(conn, job_context())
    with pytest.raises(ScopeViolation):
        await apply_job_role(conn, user_context(uuid.uuid4(), None))
    assert conn.calls == []


async def test_job_and_infra_roles() -> None:
    conn = RecordingConn()
    await apply_job_role(conn, job_context())
    await apply_infra_role(conn)
    assert [c[0] for c in conn.calls] == [
        "set local role service_role",
        "select set_config('request.jwt.claims', '', true)",
        "set local role mcp_server",
        "select set_config('request.jwt.claims', '', true)",
    ]


async def test_job_queries_must_be_scoped() -> None:
    conn = RecordingConn()
    sc = ScopedConnection(conn, job_context(appointment_id=APPT))  # type: ignore[arg-type]
    with pytest.raises(ScopeViolation):
        await sc.fetch_all("select * from public.clinical_facts")
    await sc.fetch_all(
        "select * from public.clinical_facts where appointment_id = %(scope_appointment_id)s"
    )
    _, params = conn.calls[-1]
    assert params["scope_appointment_id"] == APPT
    # Reference data (not about a patient) may be read unscoped when marked.
    await sc.fetch_all("select * from public.decision_questions", reference=True)


async def test_callers_cannot_supply_scope_params() -> None:
    sc = ScopedConnection(RecordingConn(), job_context(appointment_id=APPT))  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        await sc.fetch_one(
            "select 1 where %(scope_appointment_id)s is not null",
            {"scope_appointment_id": uuid.uuid4()},
        )


def _python_files(exclude: set[str]) -> list[Path]:
    return [p for p in SRC.rglob("*.py") if p.relative_to(SRC).as_posix() not in exclude]


def test_service_role_only_in_db_module() -> None:
    """Spec 3.1: no raw service_role use outside db.py."""
    offenders = [
        p.relative_to(SRC).as_posix()
        for p in _python_files({"shared/db.py"})
        if re.search(r"\bservice_role\b", p.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_role_switching_only_in_db_module() -> None:
    pattern = re.compile(r"\bset\s+(local\s+)?role\b|request\.jwt\.claims", re.IGNORECASE)
    offenders = [
        p.relative_to(SRC).as_posix()
        for p in _python_files({"shared/db.py"})
        if pattern.search(p.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_servers_do_not_import_psycopg() -> None:
    """Tool code reaches the database only through repositories."""
    servers = SRC / "servers"
    offenders = [
        p.relative_to(SRC).as_posix()
        for p in servers.rglob("*.py")
        if re.search(r"^\s*(import|from)\s+psycopg", p.read_text(encoding="utf-8"), re.MULTILINE)
    ]
    assert offenders == []
