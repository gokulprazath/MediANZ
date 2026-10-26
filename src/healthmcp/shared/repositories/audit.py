"""Append-only agent logs: agent_access_log, decision_log, agent_notes, web_research_log.

Written as mcp_server through security definer functions; never updated or
deleted. Entries carry ids and hashes only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID

from psycopg.types.json import Jsonb

from healthmcp.shared.db import Database


@dataclass(frozen=True)
class AccessLogEntry:
    agent_id: str
    mode: str
    server: str
    tool: str
    ok: bool
    latency_ms: int
    user_id: UUID | None = None
    job_id: str | None = None
    patient_id: UUID | None = None
    appointment_id: UUID | None = None
    error_code: str | None = None


@dataclass(frozen=True)
class DecisionLogEntry:
    agent_id: str
    server: str
    tool: str
    engine: str
    job_id: str | None = None
    appointment_id: UUID | None = None
    model: str | None = None
    model_version: str | None = None
    prompt_or_question_version: str | None = None
    input_refs: dict[str, Any] = field(default_factory=dict)
    input_hash: str | None = None
    output: dict[str, Any] = field(default_factory=dict)
    probability: float | None = None
    latency_ms: int | None = None


@dataclass(frozen=True)
class NoteEntry:
    agent_id: str
    mode: str
    server: str
    note: str
    user_id: UUID | None = None
    job_id: str | None = None
    appointment_id: UUID | None = None


@dataclass(frozen=True)
class WebResearchLogEntry:
    tool: str
    job_id: str | None = None
    query_hash: str | None = None
    domains: tuple[str, ...] = ()
    urls: tuple[str, ...] = ()
    result_count: int = 0
    blocked_reason: str | None = None


class AuditRepository(Protocol):
    async def record_access(self, entry: AccessLogEntry) -> None: ...

    async def record_decision(self, entry: DecisionLogEntry) -> None: ...

    async def record_note(self, entry: NoteEntry) -> int: ...

    async def record_web_research(self, entry: WebResearchLogEntry) -> None: ...


class PgAuditRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def record_access(self, e: AccessLogEntry) -> None:
        async with self._db.infra_tx() as conn:
            await conn.execute(
                "select public.log_agent_access(%s::text, %s::text, %s::uuid, %s::text, "
                "%s::uuid, %s::uuid, %s::text, %s::text, %s::boolean, %s::text, %s::integer)",
                [
                    e.agent_id,
                    e.mode,
                    e.user_id,
                    e.job_id,
                    e.patient_id,
                    e.appointment_id,
                    e.server,
                    e.tool,
                    e.ok,
                    e.error_code,
                    e.latency_ms,
                ],
            )

    async def record_decision(self, e: DecisionLogEntry) -> None:
        async with self._db.infra_tx() as conn:
            await conn.execute(
                "select public.log_decision(%s::text, %s::text, %s::uuid, %s::text, %s::text, "
                "%s::text, %s::text, %s::text, %s::text, %s::jsonb, %s::text, %s::jsonb, "
                "%s::numeric, %s::integer)",
                [
                    e.agent_id,
                    e.job_id,
                    e.appointment_id,
                    e.server,
                    e.tool,
                    e.engine,
                    e.model,
                    e.model_version,
                    e.prompt_or_question_version,
                    Jsonb(e.input_refs),
                    e.input_hash,
                    Jsonb(e.output),
                    e.probability,
                    e.latency_ms,
                ],
            )

    async def record_note(self, e: NoteEntry) -> int:
        async with self._db.infra_tx() as conn:
            cur = await conn.execute(
                "select public.log_agent_note(%s::text, %s::text, %s::uuid, %s::text, "
                "%s::uuid, %s::text, %s::text) as id",
                [e.agent_id, e.mode, e.user_id, e.job_id, e.appointment_id, e.server, e.note],
            )
            row = await cur.fetchone()
        assert row is not None
        return int(row["id"])

    async def record_web_research(self, e: WebResearchLogEntry) -> None:
        async with self._db.infra_tx() as conn:
            await conn.execute(
                "select public.log_web_research(%s::text, %s::text, %s::text, %s::text[], "
                "%s::text[], %s::integer, %s::text)",
                [
                    e.job_id,
                    e.tool,
                    e.query_hash,
                    list(e.domains),
                    list(e.urls),
                    e.result_count,
                    e.blocked_reason,
                ],
            )


class FakeAuditRepository:
    def __init__(self) -> None:
        self.access: list[AccessLogEntry] = []
        self.decisions: list[DecisionLogEntry] = []
        self.notes: list[NoteEntry] = []
        self.web_research: list[WebResearchLogEntry] = []

    async def record_access(self, entry: AccessLogEntry) -> None:
        self.access.append(entry)

    async def record_decision(self, entry: DecisionLogEntry) -> None:
        self.decisions.append(entry)

    async def record_note(self, entry: NoteEntry) -> int:
        self.notes.append(entry)
        return len(self.notes)

    async def record_web_research(self, entry: WebResearchLogEntry) -> None:
        self.web_research.append(entry)
