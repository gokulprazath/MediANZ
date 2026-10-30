from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest
from pydantic import ValidationError

from healthmcp.shared.config import Settings
from healthmcp.shared.context import (
    AgentAllowlist,
    AllowlistFile,
    Context,
    current_context,
    use_context,
)
from healthmcp.shared.errors import AgentNotAllowed, NotAuthenticated, ScopeViolation
from healthmcp.shared.tool_catalog import LOG_NOTE, SERVERS
from tests.conftest import ROOT, make_settings
from tests.helpers import job_context, user_context

APPT_A = uuid.UUID("60000000-0000-4000-8000-000000000002")
APPT_B = uuid.UUID("60000000-0000-4000-8000-000000000010")


@pytest.fixture
def allowlist() -> AgentAllowlist:
    return AgentAllowlist.load(ROOT / "config" / "agents.json")


def test_settings_defaults_and_domains() -> None:
    s = make_settings(allowed_research_domains=" Sunstate.example.com ,data.gov.au., ,")
    assert s.research_domains == ("sunstate.example.com", "data.gov.au")
    assert s.supabase_issuer == "https://testproject.supabase.co/auth/v1"
    assert s.jwks_url == "https://testproject.supabase.co/auth/v1/.well-known/jwks.json"
    assert "secret" not in repr(s.supabase_jwt_secret)


def test_settings_ignore_dotenv_when_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / ".env").write_text("DATABASE_URL=postgresql://should-not-load\n")
    monkeypatch.chdir(tmp_path)
    assert Settings(_env_file=None).database_url is None  # type: ignore[call-arg]


def test_allowlist_matches_spec(allowlist: AgentAllowlist) -> None:
    assert allowlist.agent_ids == {
        "patient-assistant",
        "clinical-doc-agent",
        "research-job",
        "explainer",
        "extractor",
        "insights",
        "insurance",
        "insights-writer",
        "booking",
    }
    expected = {
        "patient-assistant": {"patient_record", "matching", "booking"},
        "clinical-doc-agent": {"transcript", "decision", "extraction", "patient_record"},
        "research-job": {"web_research"},
    }
    data = json.loads((ROOT / "config" / "agents.json").read_text())
    for agent, servers in expected.items():
        assert set(data["agents"][agent]["servers"]) == servers
        for server in servers:
            tools = set(data["agents"][agent]["servers"][server])
            # These broad agents predate the least-privilege agent roles.
            assert tools == SERVERS[server].tools, (agent, server)
            assert LOG_NOTE in tools

    least_privilege = {
        "explainer": {"matching": {"get_score_breakdown", "get_fees"}},
        "extractor": {
            "transcript": {"get_transcript_windows", "check_grounding"},
            "decision": {"decide_yes_no", "decide_choice", "decide_score"},
            "extraction": {"extract_value", "save_draft_fact", "list_open_items"},
        },
        "insights": {
            "patient_record": {"get_approved_facts", "get_observations", "get_appointments"},
            "matching": {"get_patient_gp_preferences"},
        },
        "insurance": {
            "matching": {"get_fees", "get_plan_coverage"},
            "web_research": {"web_search", "web_extract"},
        },
        "insights-writer": {"extraction": {"create_gp_query"}},
        # Proposes only: confirm_booking_proposal stays app-only (never an agent tool).
        "booking": {
            "matching": {"find_gp_candidates"},
            "booking": {"get_available_slots", "propose_booking"},
        },
    }
    for agent, servers in least_privilege.items():
        assert {
            name: set(tools) for name, tools in data["agents"][agent]["servers"].items()
        } == servers
        assert LOG_NOTE not in {tool for tools in servers.values() for tool in tools}


def test_allowlist_rejects_unknown_tools() -> None:
    bad = {
        "version": 1,
        "agents": {"x": {"modes": ["job"], "servers": {"transcript": ["run_sql"]}}},
    }
    with pytest.raises(ValidationError):
        AllowlistFile.model_validate(bad)
    bad["agents"]["x"]["servers"] = {"nope": []}
    with pytest.raises(ValidationError):
        AllowlistFile.model_validate(bad)


def test_server_checks(allowlist: AgentAllowlist) -> None:
    allowlist.check_server("patient-assistant", "user", "booking")
    allowlist.check_server("clinical-doc-agent", "job", "patient_record")
    allowlist.check_server("research-job", "job", "web_research")
    for agent, mode, server in [
        ("research-job", "job", "transcript"),  # not on its list
        ("patient-assistant", "user", "transcript"),
        ("patient-assistant", "job", "booking"),  # wrong mode for the agent
        ("clinical-doc-agent", "user", "patient_record"),
        ("unknown-agent", "user", "booking"),
    ]:
        with pytest.raises(AgentNotAllowed):
            allowlist.check_server(agent, mode, server)  # type: ignore[arg-type]


def test_tool_checks(allowlist: AgentAllowlist) -> None:
    allowlist.check_tool("patient-assistant", "booking", "propose_booking")
    allowlist.check_tool("research-job", "web_research", "log_note")
    with pytest.raises(AgentNotAllowed):
        allowlist.check_tool("patient-assistant", "booking", "confirm_booking_proposal")
    with pytest.raises(AgentNotAllowed):
        allowlist.check_tool("clinical-doc-agent", "booking", "hold_slot")


def test_no_forbidden_tools_in_catalogue() -> None:
    forbidden = {
        "give_consent",
        "withdraw_consent",
        "approve_transcript",
        "reject_transcript",
        "approve_fact",
        "resolve_open_item",
        "answer_gp_query",
        "confirm_booking",
        "confirm_booking_proposal",
        "verify_plan_version",
        "moderate_rating",
        "run_sql",
        "execute_sql",
        "call_rpc",
        "fetch_url",
    }
    for spec in SERVERS.values():
        assert not (spec.tools & forbidden), spec.name


def test_context_rules() -> None:
    with pytest.raises(ValueError):
        Context(mode="user", agent_id="a", request_id="r")
    with pytest.raises(ValueError):
        Context(mode="job", agent_id="a", request_id="r")
    with pytest.raises(ValueError):
        Context(mode="job", agent_id="a", request_id="r", job_id="j", user_id=uuid.uuid4())
    ctx = user_context(uuid.uuid4(), None)
    assert "jwt_claims_json" not in repr(ctx)
    with pytest.raises(ScopeViolation):
        ctx.require_patient()


def test_job_appointment_scope() -> None:
    ctx = job_context(appointment_id=APPT_A)
    assert ctx.require_appointment() == APPT_A
    assert ctx.require_appointment(APPT_A) == APPT_A
    with pytest.raises(ScopeViolation):
        ctx.require_appointment(APPT_B)
    with pytest.raises(ScopeViolation):
        job_context().require_appointment()


def test_context_var() -> None:
    with pytest.raises(NotAuthenticated):
        current_context()
    ctx = job_context()
    with use_context(ctx):
        assert current_context() is ctx
    with pytest.raises(NotAuthenticated):
        current_context()
