"""Pg repositories and db.py against the development database (RUN_INTEGRATION=1).

Everything runs on one connection inside one transaction that is rolled back:
the agent logs are append-only, so nothing may be committed by tests.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import psycopg
import pytest
from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row

from healthmcp.shared.db import Database
from healthmcp.shared.errors import ScopeViolation
from healthmcp.shared.repositories.audit import (
    AccessLogEntry,
    DecisionLogEntry,
    NoteEntry,
    PgAuditRepository,
    WebResearchLogEntry,
)
from healthmcp.shared.repositories.identity import PgIdentityRepository
from healthmcp.shared.repositories.model_registry import PgModelRegistryRepository
from healthmcp.shared.repositories.people import PgPatientNameDirectory
from tests.helpers import job_context, user_context

pytestmark = pytest.mark.integration

OLIVIA = uuid.UUID("50000000-0000-4000-8000-000000000001")
OLIVIA_APPT = uuid.UUID("60000000-0000-4000-8000-000000000002")
TEST_USER = uuid.UUID("ee000000-0000-4000-8000-000000000101")


class _OneConnectionPool:
    """Hands out the same connection; Database's transactions become savepoints."""

    def __init__(self, conn: AsyncConnection[DictRow]) -> None:
        self._conn = conn

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[AsyncConnection[DictRow]]:
        yield self._conn

    async def open(self, wait: bool = True) -> None:
        return None

    async def close(self) -> None:
        return None


def _dsn() -> str:
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return dsn
    from healthmcp.shared.config import Settings

    url = Settings().database_url
    if url is None:
        pytest.skip("DATABASE_URL is not configured")
    return url.get_secret_value()


@pytest.fixture
async def db() -> AsyncIterator[tuple[Database, AsyncConnection[DictRow]]]:
    conn = await AsyncConnection.connect(_dsn(), autocommit=False, row_factory=dict_row)
    try:
        await conn.execute("select 1")  # opens the outer transaction
        yield Database(_OneConnectionPool(conn)), conn  # type: ignore[arg-type]
    finally:
        await conn.rollback()
        await conn.close()


async def _scalar(conn: AsyncConnection[DictRow], sql: str, params: Any = None) -> Any:
    await conn.execute("reset role")
    cur = await conn.execute(sql, params)
    row = await cur.fetchone()
    assert row is not None
    return next(iter(row.values()))


async def test_model_registry(db: tuple[Database, AsyncConnection[DictRow]]) -> None:
    database, _ = db
    repo = PgModelRegistryRepository(database)
    jev = await repo.get("jev")
    assert jev is not None and jev.allow_health_data is False
    enabled = await repo.enabled_for("decision")
    assert [e.engine for e in enabled] == ["mock_decision"]


async def test_audit_writes_through_functions(
    db: tuple[Database, AsyncConnection[DictRow]],
) -> None:
    database, conn = db
    repo = PgAuditRepository(database)
    before = await _scalar(conn, "select count(*) from public.agent_access_log")
    await repo.record_access(
        AccessLogEntry(
            agent_id="clinical-doc-agent",
            mode="job",
            server="transcript",
            tool="search_transcript",
            ok=True,
            latency_ms=4,
            job_id="job-it",
            appointment_id=OLIVIA_APPT,
        )
    )
    await repo.record_decision(
        DecisionLogEntry(
            agent_id="clinical-doc-agent",
            server="decision",
            tool="decide_batch",
            engine="mock_decision",
            input_refs={"segment_ids": ["a"]},
            input_hash="0" * 64,
            output={"answer": "yes"},
            probability=0.9,
            latency_ms=2,
        )
    )
    note_id = await repo.record_note(
        NoteEntry(
            agent_id="research-job",
            mode="job",
            server="web_research",
            note="test note",
            job_id="job-it",
        )
    )
    await repo.record_web_research(
        WebResearchLogEntry(
            tool="web_search",
            job_id="job-it",
            domains=("data.gov.au",),
            blocked_reason="personal_information",
        )
    )
    assert note_id > 0
    assert await _scalar(conn, "select count(*) from public.agent_access_log") == before + 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        await conn.execute("delete from public.agent_notes where id = %s", [note_id])


async def test_identity_resolves_patient_under_rls(
    db: tuple[Database, AsyncConnection[DictRow]],
) -> None:
    database, conn = db
    await conn.execute("reset role")
    await conn.execute(
        "insert into auth.users (id, email) values (%s, %s)",
        [TEST_USER, "mcp-test+identity@example.com"],
    )
    await conn.execute(
        "update public.patients set auth_user_id = %s where id = %s", [TEST_USER, OLIVIA]
    )
    repo = PgIdentityRepository(database)
    assert await repo.resolve_patient_id(user_context(TEST_USER, None)) == OLIVIA
    assert await repo.resolve_patient_id(user_context(uuid.uuid4(), None)) is None


async def test_user_tx_applies_rls(db: tuple[Database, AsyncConnection[DictRow]]) -> None:
    database, conn = db
    await conn.execute("reset role")
    await conn.execute(
        "insert into auth.users (id, email) values (%s, %s)",
        [TEST_USER, "mcp-test+rls@example.com"],
    )
    await conn.execute(
        "update public.patients set auth_user_id = %s where id = %s", [TEST_USER, OLIVIA]
    )
    async with database.user_tx(user_context(TEST_USER, OLIVIA)) as sc:
        rows = await sc.fetch_all("select distinct patient_id from public.appointments")
        role = await sc.fetch_one("select current_user as role")
    assert {r["patient_id"] for r in rows} == {OLIVIA}
    assert role == {"role": "authenticated"}


async def test_job_tx_scoping(db: tuple[Database, AsyncConnection[DictRow]]) -> None:
    database, _ = db
    ctx = job_context(appointment_id=OLIVIA_APPT)
    async with database.job_tx(ctx) as sc:
        rows = await sc.fetch_all(
            "select count(*) as n from public.transcript_segments "
            "where appointment_id = %(scope_appointment_id)s"
        )
        assert rows[0]["n"] == 5
        with pytest.raises(ScopeViolation):
            await sc.fetch_all("select count(*) from public.transcript_segments")


async def test_patient_name_directory(db: tuple[Database, AsyncConnection[DictRow]]) -> None:
    database, _ = db
    names = PgPatientNameDirectory(database)
    assert await names.mentions_patient_name("cover for Olivia Brown") is True
    assert await names.mentions_patient_name("gold hospital cover") is False
