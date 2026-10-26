from __future__ import annotations

import io
import json
import logging
import uuid

import pytest
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from healthmcp.shared.context import AgentAllowlist, use_context
from healthmcp.shared.errors import NotFound, TextNotAllowedInLog
from healthmcp.shared.guards import PersonalInfoDetector
from healthmcp.shared.logging import (
    JsonFormatter,
    RedactingFilter,
    log_decision,
    register_log_note,
    sha256_hex,
    with_tool_logging,
)
from healthmcp.shared.repositories.audit import FakeAuditRepository
from healthmcp.shared.repositories.people import FakePatientNameDirectory
from tests.conftest import ROOT
from tests.helpers import job_context, user_context

SECRET_TEXT = "I would like you to start an iron supplement once a day"


@pytest.fixture
def allowlist() -> AgentAllowlist:
    return AgentAllowlist.load(ROOT / "config" / "agents.json")


@pytest.fixture
def audit() -> FakeAuditRepository:
    return FakeAuditRepository()


def _capture() -> tuple[logging.Logger, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())
    lg = logging.getLogger(f"test-{uuid.uuid4()}")
    lg.handlers = [handler]
    lg.propagate = False
    lg.setLevel(logging.DEBUG)
    return lg, stream


def test_redacting_filter_drops_text_fields() -> None:
    lg, stream = _capture()
    lg.info("engine call", extra={"text": SECRET_TEXT, "meta": {"quote": SECRET_TEXT, "n": 1}})
    try:
        raise ValueError(SECRET_TEXT)
    except ValueError:
        lg.exception("failed")
    out = stream.getvalue()
    assert SECRET_TEXT not in out
    first = json.loads(out.splitlines()[0])
    assert first["text"] == "[redacted]" and first["meta"] == {"quote": "[redacted]", "n": 1}
    assert "ValueError (message withheld)" in out


async def test_with_tool_logging_records_success_and_failure(
    audit: FakeAuditRepository, allowlist: AgentAllowlist
) -> None:
    appt = uuid.UUID("60000000-0000-4000-8000-000000000002")

    @with_tool_logging("extraction", audit, allowlist)
    async def list_open_items(status: str | None = None) -> dict[str, int]:
        if status == "missing":
            raise NotFound()
        if status == "boom":
            raise RuntimeError(SECRET_TEXT)
        return {"count": 0}

    with use_context(job_context(appointment_id=appt)):
        assert await list_open_items() == {"count": 0}
        with pytest.raises(ToolError) as refused:
            await list_open_items("missing")
        assert str(refused.value) == "Not found."
        with pytest.raises(ToolError) as crashed:
            await list_open_items("boom")
        assert SECRET_TEXT not in str(crashed.value)

    assert [(e.ok, e.error_code) for e in audit.access] == [
        (True, None),
        (False, "not_found"),
        (False, "internal_error"),
    ]
    first = audit.access[0]
    assert (first.agent_id, first.mode, first.server, first.tool) == (
        "clinical-doc-agent",
        "job",
        "extraction",
        "list_open_items",
    )
    assert first.appointment_id == appt and first.latency_ms >= 0


async def test_with_tool_logging_enforces_tool_allowlist(
    audit: FakeAuditRepository, allowlist: AgentAllowlist
) -> None:
    @with_tool_logging("booking", audit, allowlist)
    async def hold_slot(slot_id: str) -> str:
        return "held"

    with use_context(job_context()), pytest.raises(ToolError):  # clinical agent, booking server
        await hold_slot("x")
    assert audit.access[-1].error_code == "agent_not_allowed"


def test_wrapper_keeps_signature_for_schema(
    audit: FakeAuditRepository, allowlist: AgentAllowlist
) -> None:
    mcp: MCPServer = MCPServer("t")

    async def get_appointments(status: str | None = None, limit: int = 10) -> list[str]:
        """List appointments."""
        return []

    mcp.add_tool(with_tool_logging("patient_record", audit, allowlist)(get_appointments))
    tool = mcp._tool_manager.get_tool("get_appointments")
    assert tool is not None
    assert set(tool.parameters["properties"]) == {"status", "limit"}
    assert tool.description == "List appointments."


async def test_log_decision_hashes_input_and_refuses_text(audit: FakeAuditRepository) -> None:
    ctx = job_context(appointment_id=uuid.UUID("60000000-0000-4000-8000-000000000002"))
    await log_decision(
        audit,
        ctx,
        server="decision",
        tool="decide_batch",
        engine="mock_decision",
        model="mock-keywords",
        model_version="1",
        question_version="fatigue_reported@1",
        input_refs={"segment_ids": ["s1", "s2"], "question_ids": ["fatigue_reported"]},
        input_text=SECRET_TEXT,
        output={"answer": "yes", "quote_hash": sha256_hex("x")},
        probability=0.9,
        latency_ms=3,
    )
    entry = audit.decisions[0]
    assert entry.input_hash == sha256_hex(SECRET_TEXT)
    assert SECRET_TEXT not in json.dumps(entry.__dict__, default=str)

    with pytest.raises(TextNotAllowedInLog):
        await log_decision(
            audit,
            ctx,
            server="decision",
            tool="decide_batch",
            engine="mock_decision",
            model=None,
            model_version=None,
            question_version=None,
            input_refs={},
            input_text="x",
            output={"evidence": [{"quote": SECRET_TEXT}]},
            probability=None,
            latency_ms=1,
        )


async def test_log_note_tool(audit: FakeAuditRepository, allowlist: AgentAllowlist) -> None:
    mcp: MCPServer = MCPServer("t")
    pii = PersonalInfoDetector(FakePatientNameDirectory())
    register_log_note(mcp, "booking", audit, allowlist, check_note=pii.require_clean)
    olivia_user = uuid.UUID("aa000000-0000-4000-8000-000000000001")
    with use_context(user_context(olivia_user, uuid.uuid4())):
        result = await mcp.call_tool("log_note", {"note": "Offered two morning slots."})
        assert not result.is_error
        assert audit.notes[0].note == "Offered two morning slots."
        assert audit.notes[0].user_id == olivia_user

        with pytest.raises(ToolError, match="1 to 1000 characters"):
            await mcp.call_tool("log_note", {"note": "x" * 1001})
        with pytest.raises(ToolError, match="personal information"):
            await mcp.call_tool("log_note", {"note": "Patient Olivia Brown prefers mornings"})
    assert len(audit.notes) == 1
    assert [e.ok for e in audit.access] == [True, False, False]
