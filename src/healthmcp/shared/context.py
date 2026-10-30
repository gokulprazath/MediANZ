"""Per-request Context (user or job mode) and the agent allowlist.

The HTTP middleware verifies the bearer token and builds a frozen `Context`;
the MCP middleware puts it in a ContextVar for the duration of each MCP
message, so tool code reads it with `current_context()`. Patient and
appointment ids always come from here, never from tool arguments.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from healthmcp.shared.errors import AgentNotAllowed, NotAuthenticated, ScopeViolation
from healthmcp.shared.tool_catalog import SERVERS, Mode


@dataclass(frozen=True, slots=True)
class Context:
    mode: Mode
    agent_id: str
    request_id: str
    user_id: UUID | None = None
    patient_id: UUID | None = None
    job_id: str | None = None
    appointment_id: UUID | None = None
    clinician_id: UUID | None = None
    scope: frozenset[str] = frozenset()
    # User mode only: the verified JWT claims as JSON (db.user_tx hands them to Postgres).
    jwt_claims_json: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.mode == "user":
            if self.user_id is None or not self.jwt_claims_json:
                raise ValueError("user mode needs user_id and jwt claims")
            if self.job_id is not None:
                raise ValueError("user mode has no job id")
        elif self.mode == "job":
            if not self.job_id:
                raise ValueError("job mode needs a job id")
            if self.user_id is not None or self.jwt_claims_json is not None:
                raise ValueError("job mode has no user")
        else:
            raise ValueError(f"unknown mode {self.mode!r}")

    @classmethod
    def for_user(
        cls,
        *,
        agent_id: str,
        request_id: str,
        user_id: UUID,
        claims: Mapping[str, object],
        patient_id: UUID | None = None,
    ) -> Context:
        return cls(
            mode="user",
            agent_id=agent_id,
            request_id=request_id,
            user_id=user_id,
            patient_id=patient_id,
            jwt_claims_json=json.dumps(dict(claims), separators=(",", ":"), sort_keys=True),
        )

    def require_patient(self) -> UUID:
        if self.patient_id is None:
            raise ScopeViolation("No patient is associated with this request.")
        return self.patient_id

    def require_scope(self, scope: str) -> None:
        """A write that needs explicit permission: the job token must carry this scope."""
        if self.mode != "job" or scope not in self.scope:
            raise ScopeViolation()

    def require_appointment(self, appointment_id: UUID | None = None) -> UUID:
        """In job mode, the appointment comes from the token; an argument must match it.

        In user mode an appointment argument is checked by RLS when it is read.
        """
        if self.mode == "job":
            if self.appointment_id is None:
                raise ScopeViolation()
            if appointment_id is not None and appointment_id != self.appointment_id:
                raise ScopeViolation()
            return self.appointment_id
        if appointment_id is None:
            raise ScopeViolation()
        return appointment_id


_current: ContextVar[Context | None] = ContextVar("healthmcp_context", default=None)


def current_context() -> Context:
    ctx = _current.get()
    if ctx is None:
        raise NotAuthenticated()
    return ctx


@contextmanager
def use_context(ctx: Context) -> Iterator[Context]:
    token = _current.set(ctx)
    try:
        yield ctx
    finally:
        _current.reset(token)


# ---------------------------------------------------------------------------
# Agent allowlist (config/agents.json)
# ---------------------------------------------------------------------------
class AgentEntry(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    description: str = ""
    modes: frozenset[Literal["user", "job"]]
    servers: dict[str, frozenset[str]]

    @field_validator("servers")
    @classmethod
    def _known_tools_only(cls, v: dict[str, frozenset[str]]) -> dict[str, frozenset[str]]:
        for server, tools in v.items():
            spec = SERVERS.get(server)
            if spec is None:
                raise ValueError(f"unknown server {server!r}")
            unknown = tools - spec.tools
            if unknown:
                raise ValueError(f"tools not in the spec for {server}: {sorted(unknown)}")
        return v


class AllowlistFile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: int = Field(ge=1)
    agents: dict[str, AgentEntry]


class AgentAllowlist:
    def __init__(self, data: AllowlistFile) -> None:
        self._agents = data.agents

    @classmethod
    def load(cls, path: Path) -> AgentAllowlist:
        return cls(AllowlistFile.model_validate_json(path.read_text(encoding="utf-8")))

    @property
    def agent_ids(self) -> frozenset[str]:
        return frozenset(self._agents)

    def check_server(self, agent_id: str, mode: Mode, server: str) -> None:
        entry = self._agents.get(agent_id)
        if entry is None or mode not in entry.modes or server not in entry.servers:
            raise AgentNotAllowed()
        spec = SERVERS.get(server)
        if spec is None or mode not in spec.modes:
            raise AgentNotAllowed()

    def is_tool_allowed(self, agent_id: str, server: str, tool: str) -> bool:
        entry = self._agents.get(agent_id)
        return entry is not None and tool in entry.servers.get(server, frozenset())

    def check_tool(self, agent_id: str, server: str, tool: str) -> None:
        if not self.is_tool_allowed(agent_id, server, tool):
            raise AgentNotAllowed()

    def allowed_tools(self, agent_id: str, server: str) -> frozenset[str]:
        entry = self._agents.get(agent_id)
        return entry.servers.get(server, frozenset()) if entry else frozenset()

    def servers_for(self, agent_id: str) -> Mapping[str, frozenset[str]]:
        entry = self._agents.get(agent_id)
        return entry.servers if entry else {}
