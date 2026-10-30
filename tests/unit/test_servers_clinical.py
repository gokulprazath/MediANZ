"""transcript, decision and extraction tools end to end (job mode, Fake repository)."""

from __future__ import annotations

import uuid
from typing import Any

from healthmcp.consult_notes.models import Eligibility
from healthmcp.servers.clinical import (
    SAMPLE_SEGMENTS,
    FakeClinicalData,
    FakeClinicalRepository,
)
from healthmcp.servers.decision import tools as decision
from healthmcp.servers.extraction import tools as extraction
from healthmcp.servers.transcript import tools as transcript
from healthmcp.servers.transcript.tools import window_id
from healthmcp.shared.repositories import fake_repositories
from healthmcp.shared.repositories.fake_data import (
    DR_RAO,
    OLIVIA,
    OLIVIA_APPROVED_APPOINTMENT,
)
from healthmcp.shared.repositories.model_registry import FakeModelRegistryRepository
from healthmcp.shared.server import HealthServer
from healthmcp.shared.tool_catalog import GP_QUERY_SCOPE
from tests.helpers import mcp_session, running
from tests.unit.servers_helpers import audit, call, job_headers, make_server, session

SEG = {s.seq: str(s.id) for s in SAMPLE_SEGMENTS}
ALL = list(SEG.values())


def _server(
    name: str, module: Any, data: FakeClinicalData | None = None, **kw: Any
) -> tuple[HealthServer, FakeClinicalRepository]:
    repo = FakeClinicalRepository(data)
    server = make_server(name, lambda s: module.register(s, repo), **kw)
    return server, repo


# ---------------------------------------------------------------------------
# transcript
# ---------------------------------------------------------------------------
async def test_windows_are_deterministic_and_untrusted() -> None:
    server, _ = _server("transcript", transcript)
    async with session(server, job_headers()) as s:
        first = await call(s, "get_transcript_windows", window_size=4, overlap=2)
        again = await call(s, "get_transcript_windows", window_size=4, overlap=2)
    windows = first["windows"]
    assert [len(w["segment_ids"]) for w in windows] == [4, 4]
    assert windows[0]["segment_ids"][2:] == windows[1]["segment_ids"][:2]  # overlap
    assert [w["window_id"] for w in windows] == [w["window_id"] for w in again["windows"]]
    assert windows[0]["window_id"] == window_id(uuid.UUID(first["transcript_id"]), 1, 4)
    assert windows[0]["segments"][0]["text"]["untrusted_content"] is True


async def test_another_appointment_is_refused() -> None:
    server, _ = _server("transcript", transcript)
    async with session(server, job_headers()) as s:
        other = await call(s, "get_transcript_windows", appointment_id=str(uuid.uuid4()))
        own = await call(
            s, "get_processing_eligibility", appointment_id=str(OLIVIA_APPROVED_APPOINTMENT)
        )
    assert "outside this request's scope" in other["error"]  # spec 7.2
    assert own == {"eligible": True, "reasons": []}


async def test_tools_refuse_when_not_eligible() -> None:
    data = FakeClinicalData(eligible=Eligibility(False, ("consent_v1",)))
    server, _ = _server("transcript", transcript, data)
    async with session(server, job_headers()) as s:
        eligibility = await call(s, "get_processing_eligibility")
        windows = await call(s, "get_transcript_windows")
        search = await call(s, "search_transcript", query="tired")
    assert eligibility == {"eligible": False, "reasons": ["consent_v1"]}  # spec 7.4
    assert "not eligible" in windows["error"] and "not eligible" in search["error"]


async def test_search_and_grounding() -> None:
    server, _ = _server("transcript", transcript)
    async with session(server, job_headers()) as s:
        found = await call(s, "search_transcript", query="BLOOD PRESSURE")
        grounded = await call(
            s,
            "check_grounding",
            segment_ids=[SEG[3]],
            quote="142  over 91",
            value={"systolic": 142, "diastolic": 91},
            value_type="blood_pressure",
        )
        wrong = await call(
            s,
            "check_grounding",
            segment_ids=[SEG[3]],
            quote="142 over 91",
            value={"systolic": 140, "diastolic": 90},
            value_type="blood_pressure",
        )
        missing = await call(
            s,
            "check_grounding",
            segment_ids=[SEG[3]],
            quote="150 over 95",
            value={"systolic": 150, "diastolic": 95},
            value_type="blood_pressure",
        )
        foreign = await call(
            s,
            "check_grounding",
            segment_ids=[str(uuid.uuid4())],
            quote="x",
            value=1,
            value_type="number",
        )
    assert [x["id"] for x in found["segments"]] == [SEG[3]]
    assert grounded["quote_found"] and grounded["value_derivable"]
    assert grounded["segment_id"] == SEG[3] and grounded["char_end"] > grounded["char_start"]
    assert wrong["quote_found"] and not wrong["value_derivable"]
    assert missing["reason"] == "quote_not_found"
    assert "outside this request's scope" in foreign["error"]


async def test_patient_tokens_cannot_use_job_servers() -> None:
    from healthmcp.shared.repositories.fake_data import OLIVIA_AUTH_USER
    from tests.helpers import http_client, running
    from tests.unit.servers_helpers import user_headers

    server, _ = _server("transcript", transcript)
    async with (
        running(server) as transport,
        http_client(transport, server, user_headers(OLIVIA_AUTH_USER)) as http,
    ):
        response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status_code == 403  # spec 7.3


# ---------------------------------------------------------------------------
# decision
# ---------------------------------------------------------------------------
async def test_decide_batch_with_attributes_evidence_and_logging() -> None:
    server, _ = _server("decision", decision)
    async with session(server, job_headers()) as s:
        result = await call(
            s,
            "decide_batch",
            segment_ids=ALL,
            question_ids=["fatigue_reported", "smoker_status", "presenting_complaint_summary"],
        )
    by_id = {a["question_id"]: a for a in result["answers"]}
    fatigue = by_id["fatigue_reported"]
    assert fatigue["answer"] == "yes" and fatigue["meets_threshold"] is True
    assert fatigue["engine"] == "mock_decision" and fatigue["needs_gp_review"] is False
    assert by_id["smoker_status"]["answer"] == "never"
    explain = by_id["presenting_complaint_summary"]
    assert explain["answer_source"] == "slm" and explain["needs_gp_review"] is True
    calls = audit(server).decisions
    assert {c.tool for c in calls} == {"decide_batch", "decide_batch:explain"}
    jev_call = next(c for c in calls if c.tool == "decide_batch")
    asked = jev_call.input_refs["questions"]
    assert "attr_negated__fatigue_reported@1" in asked
    assert "evidence_segment__fatigue_reported@1" in asked
    # spec 7.7: no transcript text in decision_log
    logged = str([(c.input_refs, c.output) for c in calls])
    assert all(seg.text not in logged for seg in SAMPLE_SEGMENTS)


async def test_low_confidence_gets_a_second_opinion() -> None:
    # The mock answers "not_stated" at 0.70 when nothing matches; with the review
    # level above that, every answer goes to the SLM and is marked for the GP.
    from tests.conftest import make_settings

    server, _ = _server("decision", decision, settings=make_settings(decision_review_below=0.95))
    async with session(server, job_headers()) as s:
        answer = await call(s, "decide_yes_no", segment_ids=ALL, question_id="chest_pain_reported")
    assert answer["needs_gp_review"] is True and answer["meets_threshold"] is False
    assert answer["other_opinion"] is not None
    assert {c.tool for c in audit(server).decisions} == {"decide_yes_no", "decide_yes_no:review"}


async def test_decision_input_rules() -> None:
    server, _ = _server("decision", decision)
    async with session(server, job_headers()) as s:
        helper = await call(s, "decide_batch", segment_ids=ALL, question_ids=["attr_negated"])
        unknown = await call(s, "decide_batch", segment_ids=ALL, question_ids=["no_such_question"])
        wrong_kind = await call(s, "decide_score", segment_ids=ALL, question_id="fatigue_reported")
        score = await call(s, "decide_score", segment_ids=ALL, question_id="urgency_level")
    assert "added by the server" in helper["error"]
    assert "Unknown or inactive" in unknown["error"]
    assert "not a score question" in wrong_kind["error"]
    assert score["kind"] == "score" and score["level"] is not None


async def test_health_data_guard_blocks_the_engine() -> None:
    registry = FakeModelRegistryRepository()
    registry.set("mock_decision", allow_health_data=False)
    repos = fake_repositories()
    repos = type(repos)(
        identity=repos.identity,
        model_registry=registry,
        audit=repos.audit,
        patient_names=repos.patient_names,
    )
    server, _ = _server("decision", decision, repos=repos)
    async with session(server, job_headers()) as s:
        result = await call(s, "decide_yes_no", segment_ids=ALL, question_id="fatigue_reported")
    assert "not approved for health data" in result["error"]  # spec 7.8
    assert audit(server).decisions == []


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------
async def test_extract_then_save_grounded_draft_idempotently() -> None:
    server, repo = _server("extraction", extraction)
    async with session(server, job_headers()) as s:
        got = await call(s, "extract_value", field_id="bp_reading", segment_ids=ALL)
        args = {
            "field_id": "bp_reading",
            "value": got["value"],
            "segment_ids": ALL,
            "quote": got["quote"]["text"],
            "char_start": got["char_start"],
            "char_end": got["char_end"],
            "confidence": got["confidence"],
            "idempotency_key": "test-bp-0001",
        }
        first = await call(s, "save_draft_fact", **args)
        retry = await call(s, "save_draft_fact", **args)
        duplicate = await call(s, "save_draft_fact", **{**args, "idempotency_key": "test-bp-0002"})
    assert got["value"] == {"systolic": 142, "diastolic": 91}
    assert got["quote"]["untrusted_content"] is True
    assert first["created"] is True and first["status"] == "draft"
    assert retry == {**first, "created": False}  # spec 7.6
    assert duplicate["fact_id"] == first["fact_id"] and duplicate["created"] is False
    assert len(repo.data.facts) == 1
    saved = repo.data.facts[0].fact
    assert saved.quote_hash != got["quote"]["text"] and len(saved.quote_hash) == 64


async def test_ungrounded_and_invalid_facts_are_refused() -> None:
    server, repo = _server("extraction", extraction)
    base = {
        "field_id": "bp_reading",
        "segment_ids": [SEG[3]],
        "char_start": 0,
        "char_end": 5,
        "confidence": 0.9,
    }
    async with session(server, job_headers()) as s:
        not_there = await call(
            s,
            "save_draft_fact",
            **base,
            value={"systolic": 150, "diastolic": 95},
            quote="150 over 95",
            idempotency_key="test-bad-0001",
        )
        not_derivable = await call(
            s,
            "save_draft_fact",
            **base,
            value={"systolic": 150, "diastolic": 95},
            quote="142 over 91",
            idempotency_key="test-bad-0002",
        )
        bad_schema = await call(
            s,
            "save_draft_fact",
            **base,
            value={"systolic": "high"},
            quote="142 over 91",
            idempotency_key="test-bad-0003",
        )
    assert "not in the given segments" in not_there["error"]  # spec 7.5
    assert "not in the given segments" in not_derivable["error"]
    assert "schema" in bad_schema["error"]
    assert repo.data.facts == []


async def test_urgent_severity_comes_from_the_engine() -> None:
    # The mock rates "today" as urgent, so use a consult that never says it.
    calm = tuple(
        s.model_copy(update={"text": s.text.replace(" today", "")}) for s in SAMPLE_SEGMENTS
    )
    server, _ = _server("extraction", extraction, FakeClinicalData(segments=calm))
    async with session(server, job_headers()) as s:
        urgent = await call(
            s,
            "raise_open_item",
            kind="urgent",
            description="Check BP.",
            idempotency_key="test-urgent-1",
        )
        missing = await call(
            s,
            "raise_open_item",
            kind="missing_info",
            description="Dose not stated.",
            idempotency_key="test-missing-1",
        )
        listed = await call(s, "list_open_items")
    assert "did not rate this consult urgent" in urgent["error"]
    assert missing["created"] is True and missing["severity"] is None
    assert listed["items"][0]["description"]["untrusted_content"] is True


async def test_urgent_item_when_the_transcript_says_so() -> None:
    from healthmcp.servers.clinical import _seg

    data = FakeClinicalData(
        segments=(*SAMPLE_SEGMENTS, _seg(7, "patient", "I have chest pain now."))
    )
    server, _ = _server("extraction", extraction, data)
    async with session(server, job_headers()) as s:
        urgent = await call(
            s,
            "raise_open_item",
            kind="urgent",
            description="Chest pain.",
            idempotency_key="test-urgent-2",
        )
    assert urgent["created"] is True and urgent["severity"] == 9


async def test_gp_query_needs_the_gp_query_scope() -> None:
    server, repo = _server("extraction", extraction)
    async with running(server) as transport:
        async with mcp_session(
            transport, server, job_headers(agent="insights-writer", patient_id=None)
        ) as s:
            writer = await call(
                s, "create_gp_query", question="Is my iron okay?", idempotency_key="gpq-00010"
            )
        async with mcp_session(transport, server, job_headers()) as s:
            doc_agent = await call(
                s, "create_gp_query", question="Is my iron okay?", idempotency_key="gpq-00011"
            )
    assert "outside this request's scope" in writer["error"]
    assert "outside this request's scope" in doc_agent["error"]
    assert repo.data.gp_queries == {}


async def test_gp_query_and_preferences() -> None:
    server, repo = _server("extraction", extraction)
    async with session(
        server, job_headers(agent="insights-writer", patient_id=None, scope=[GP_QUERY_SCOPE])
    ) as s:
        first = await call(
            s, "create_gp_query", question="Is my iron okay?", idempotency_key="gpq-00001"
        )
        again = await call(
            s, "create_gp_query", question="Is my iron okay?", idempotency_key="gpq-00001"
        )
        foreign = await call(
            s,
            "create_gp_query",
            question="x",
            idempotency_key="gpq-00002",
            context_fact_ids=[str(uuid.uuid4())],
        )
    async with session(
        make_server("extraction", lambda s: extraction.register(s, repo)),
        job_headers(clinician_id=DR_RAO, patient_id=OLIVIA),
    ) as s:
        prefs = await call(s, "get_clinician_preferences")
    assert first["created"] is True and again == {**first, "created": False}
    assert "outside this request's scope" in foreign["error"]
    assert prefs["preferences"] == {"note_style": "soap", "units": "metric"}
