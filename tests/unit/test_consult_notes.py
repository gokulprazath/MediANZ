"""Consult-notes worker: SLM facts and decision-engine key points (offline, mock engines)."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from healthmcp.consult_notes.models import (
    ClaimedRun,
    Eligibility,
    NoteResults,
    SavedCounts,
)
from healthmcp.consult_notes.service import (
    ConsultNotesWorker,
    Vote,
    aggregate,
    key_point_questions,
    make_windows,
)
from healthmcp.consult_notes.worker import drain
from healthmcp.shared.context import Context
from healthmcp.shared.engines.extraction import repair_offsets
from healthmcp.shared.engines.models import (
    ClinicalField,
    EngineInfo,
    QuestionOption,
    Segment,
    TypedAnswer,
    TypedQuestion,
)
from healthmcp.shared.engines.registry import EngineRegistry
from healthmcp.shared.errors import EngineFailure
from healthmcp.shared.logging import configure_logging, sha256_hex
from healthmcp.shared.repositories.audit import FakeAuditRepository
from healthmcp.shared.repositories.model_registry import FakeModelRegistryRepository
from tests.conftest import make_settings

APPT = UUID("60000000-0000-4000-8000-000000000002")
TRANSCRIPT = UUID("71000000-0000-4000-8000-000000000001")


def _seg(n: int, speaker: str, text: str) -> Segment:
    return Segment(id=uuid.UUID(int=n), seq=n, speaker=speaker, text=text)


# Olivia's approved transcript (seed/01) plus a chest-pain line.
SEGMENTS = [
    _seg(1, "clinician", "Hi Olivia, your iron levels are a bit low."),
    _seg(2, "patient", "That would explain why I have been so tired lately."),
    _seg(
        3,
        "clinician",
        "I would like you to start an iron supplement once a day, and we will repeat the "
        "blood test in three months.",
    ),
    _seg(4, "patient", "Are there any side effects?"),
    _seg(5, "patient", "I also get chest pain when I climb stairs."),
]

YES_NO = [QuestionOption(value=v) for v in ("yes", "no", "not_stated")]


def _q(qid: str, kind: str, options: Sequence[QuestionOption], threshold: float) -> TypedQuestion:
    return TypedQuestion(
        id=qid, version=1, kind=kind, text=f"{qid}?", options=tuple(options), threshold=threshold
    )


QUESTIONS = [
    _q("chest_pain_reported", "yes_no", YES_NO, 0.8),
    _q("fatigue_reported", "yes_no", YES_NO, 0.7),
    _q("medication_started", "yes_no", YES_NO, 0.75),
    _q("follow_up_arranged", "yes_no", YES_NO, 0.7),
    _q(
        "smoker_status",
        "choice",
        [QuestionOption(value=v) for v in ("current", "former", "never", "unclear")],
        0.7,
    ),
    _q(
        "urgency_level",
        "score",
        [
            QuestionOption(value="routine", level=0, description="Routine"),
            QuestionOption(value="soon", level=1, description="Soon"),
            QuestionOption(value="urgent", level=2, description="Urgent: needs review today"),
            QuestionOption(value="emergency", level=3, description="Emergency: call 000"),
        ],
        0.8,
    ),
    _q("attr_negated", "yes_no", YES_NO, 0.7),
]

FIELDS = [
    ClinicalField(
        id="current_medication",
        version=1,
        label="Current medication",
        value_schema={
            "type": "object",
            "properties": {"name": {"type": "string"}, "frequency": {"type": "string"}},
            "required": ["name"],
        },
        topic="medication",
    ),
    ClinicalField(
        id="symptom",
        version=1,
        label="Symptom",
        value_schema={
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        },
        topic="symptom",
    ),
    ClinicalField(
        id="follow_up",
        version=1,
        label="Follow-up plan",
        value_schema={
            "type": "object",
            "properties": {"action": {"type": "string"}, "interval": {"type": "string"}},
            "required": ["action"],
        },
        topic="plan",
    ),
]


class FakeConsultNotesRepository:
    """In-memory queue and tables; inserts are idempotent like the real ones."""

    def __init__(
        self,
        *,
        eligible: bool = True,
        segments: Sequence[Segment] = SEGMENTS,
        questions: Sequence[TypedQuestion] = QUESTIONS,
    ) -> None:
        self.queue: list[ClaimedRun] = [ClaimedRun(uuid.uuid4(), TRANSCRIPT, APPT, 0)]
        self.status: dict[UUID, str] = {}
        self.errors: dict[UUID, str] = {}
        self.rows: dict[str, Any] = {}
        self._eligible = eligible
        self._segments = list(segments)
        self._questions = list(questions)
        self.contexts: list[Context] = []

    async def claim_run(
        self, ctx: Context, *, max_attempts: int, appointment_id: UUID | None = None
    ) -> ClaimedRun | None:
        assert ctx.mode == "job" and ctx.appointment_id is None
        for i, run in enumerate(self.queue):
            if appointment_id in (None, run.appointment_id) and run.attempts < max_attempts:
                claimed = ClaimedRun(
                    run.id, run.transcript_id, run.appointment_id, run.attempts + 1
                )
                del self.queue[i]
                self.status[run.id] = "running"
                return claimed
        return None

    async def requeue(self, ctx: Context) -> int:
        return 0

    async def eligibility(self, ctx: Context) -> Eligibility:
        self.contexts.append(ctx)
        return Eligibility(self._eligible, () if self._eligible else ("no_approved_transcript",))

    async def segments(self, ctx: Context, transcript_id: UUID) -> list[Segment]:
        assert ctx.appointment_id == APPT and transcript_id == TRANSCRIPT
        return list(self._segments)

    async def active_fields(self, ctx: Context) -> list[ClinicalField]:
        return list(FIELDS)

    async def active_questions(self, ctx: Context) -> list[TypedQuestion]:
        return list(self._questions)

    async def finish(
        self, ctx: Context, run_id: UUID, results: NoteResults, *, agent_id: str
    ) -> SavedCounts:
        counts = [0, 0, 0]
        for i, group in enumerate((results.facts, results.key_points, results.open_items)):
            for row in group:
                if row.idempotency_key not in self.rows:
                    self.rows[row.idempotency_key] = row
                    counts[i] += 1
        self.status[run_id] = "done"
        return SavedCounts(*counts)

    async def fail_run(self, ctx: Context, run_id: UUID, error_code: str) -> None:
        self.status[run_id] = "failed"
        self.errors[run_id] = error_code

    def of(self, kind: str) -> list[Any]:
        return [r for k, r in self.rows.items() if k.split(":")[2] == kind]


def _worker(
    repo: FakeConsultNotesRepository, *, window: int = 2, registry: Any = None
) -> tuple[ConsultNotesWorker, FakeAuditRepository]:
    audit = FakeAuditRepository()
    engines = registry or EngineRegistry(make_settings(), FakeModelRegistryRepository())
    return ConsultNotesWorker(repo, engines, audit, window_segments=window), audit


async def _run_all(repo: FakeConsultNotesRepository, worker: ConsultNotesWorker) -> list[Any]:
    return await drain(worker, repo, max_attempts=3)


# ---------------------------------------------------------------------------
# End to end with the mock engines
# ---------------------------------------------------------------------------
async def test_run_saves_facts_key_points_and_urgent_item() -> None:
    repo = FakeConsultNotesRepository()
    worker, audit = _worker(repo)

    [summary] = await _run_all(repo, worker)

    assert summary.status == "done" and summary.attempt == 1
    assert repo.status[summary.run_id] == "done"

    facts = {f.field_id: f for f in repo.of("f") if f.field_id != "symptom"}
    assert facts["current_medication"].value == {
        "name": "iron supplement",
        "frequency": "once a day",
    }
    assert facts["follow_up"].value["action"] == "repeat the blood test"
    # Several values of one field are kept as separate facts.
    symptoms = sorted(f.value["name"] for f in repo.of("f") if f.field_id == "symptom")
    assert symptoms == ["chest pain", "tired"]
    med = facts["current_medication"]
    seg3 = SEGMENTS[2]
    assert med.segment_ids == (seg3.id,)
    assert med.quote_hash == sha256_hex(seg3.text[med.char_start : med.char_end])

    points = {k.question_id: k for k in repo.of("k")}
    # Nothing to note for smoking; attribute questions are never key points.
    assert set(points) == {
        "chest_pain_reported",
        "fatigue_reported",
        "medication_started",
        "follow_up_arranged",
        "urgency_level",
    }
    assert all(k.answer == "yes" for qid, k in points.items() if qid != "urgency_level")
    assert points["chest_pain_reported"].segment_ids == (SEGMENTS[4].id,)
    urgency = points["urgency_level"]
    assert (urgency.answer, urgency.level, urgency.meets_threshold) == ("emergency", 3, True)

    [item] = repo.of("o")
    assert (item.kind, item.severity) == ("urgent", 9)

    # Every engine call is logged, with hashes and ids only. The mock is confident
    # (>= 0.6) everywhere, so the SLM is never asked for a second opinion.
    windows = 3
    assert len(audit.decisions) == len(FIELDS) * windows + windows
    assert "review_batch" not in {d.tool for d in audit.decisions}
    assert all(
        k.answer_source == "decision_engine" and k.other_opinion is None for k in points.values()
    )
    for entry in audit.decisions:
        assert entry.appointment_id == APPT and entry.input_hash
        assert "Olivia" not in json.dumps(entry.output) + json.dumps(entry.input_refs)


async def test_rerun_is_idempotent() -> None:
    repo = FakeConsultNotesRepository()
    worker, _ = _worker(repo)
    [first] = await _run_all(repo, worker)
    stored = dict(repo.rows)

    repo.queue.append(ClaimedRun(uuid.uuid4(), TRANSCRIPT, APPT, 0))
    [second] = await _run_all(repo, worker)

    assert first.inserted > 0 and second.inserted == 0
    assert (second.facts, second.key_points) == (first.facts, first.key_points)
    assert repo.rows == stored


async def test_same_value_in_several_windows_is_one_fact() -> None:
    repeated = [*SEGMENTS, _seg(6, "patient", "I have been so tired, honestly.")]
    repo = FakeConsultNotesRepository(segments=repeated)
    worker, _ = _worker(repo, window=1)
    await _run_all(repo, worker)
    symptoms = [f.value["name"] for f in repo.of("f") if f.field_id == "symptom"]
    assert symptoms.count("tired") == 1


async def test_not_eligible_fails_the_run_without_engine_calls() -> None:
    repo = FakeConsultNotesRepository(eligible=False)
    worker, audit = _worker(repo)
    [summary] = await _run_all(repo, worker)
    assert (summary.status, summary.error) == ("failed", "not_eligible")
    assert repo.rows == {} and audit.decisions == []


async def test_engine_failure_fails_the_run_and_stores_nothing() -> None:
    class Broken:
        async def decide(self, *args: Any) -> Any:
            raise EngineFailure()

    class Registry:
        def __init__(self) -> None:
            self.real = EngineRegistry(make_settings(), FakeModelRegistryRepository())

        async def extraction(self, *, health_data: bool) -> Any:
            return await self.real.extraction(health_data=health_data)

        async def decision(self, *, health_data: bool) -> Any:
            selected = await self.real.decision(health_data=health_data)
            return type(selected)(Broken(), selected.entry)

    repo = FakeConsultNotesRepository()
    worker, _ = _worker(repo, registry=Registry())
    [summary] = await _run_all(repo, worker)
    assert (summary.status, summary.error) == ("failed", "engine_failure")
    assert repo.rows == {}


async def test_engine_not_approved_for_health_data_fails() -> None:
    models = FakeModelRegistryRepository()
    models.set("mock_extraction", allow_health_data=False)
    repo = FakeConsultNotesRepository()
    worker, audit = _worker(repo, registry=EngineRegistry(make_settings(), models))
    [summary] = await _run_all(repo, worker)
    assert summary.error == "health_data_not_allowed"
    assert audit.decisions == []


async def test_low_confidence_answer_raises_missing_info() -> None:
    strict = [_q("fatigue_reported", "yes_no", YES_NO, 0.95)]
    repo = FakeConsultNotesRepository(questions=strict)
    worker, _ = _worker(repo)
    await _run_all(repo, worker)
    [point] = repo.of("k")
    assert point.meets_threshold is False
    [item] = repo.of("o")
    assert item.kind == "missing_info" and "fatigue_reported?" in item.description


# ---------------------------------------------------------------------------
# Jev unsure -> SLM second opinion -> GP; explain questions -> SLM directly
# ---------------------------------------------------------------------------
class ScriptedEngine:
    """Answers from a script: {question_id: (answer, probability, text)}."""

    def __init__(self, name: str, script: dict[str, tuple[str, float, str | None]]) -> None:
        self.info = EngineInfo(engine=name, provider="test", model=name, model_version="1")
        self.script = script
        self.asked: list[list[str]] = []

    async def decide(self, questions: Sequence[TypedQuestion], state: str) -> list[TypedAnswer]:
        self.asked.append([q.id for q in questions])
        out = []
        for q in questions:
            answer, probability, text = self.script.get(q.id, ("not_stated", 0.9, None))
            out.append(
                TypedAnswer(
                    question_id=q.id,
                    question_version=q.version,
                    answer=answer,
                    probability=probability,
                    text=text,
                )
            )
        return out


class ScriptedRegistry:
    def __init__(self, jev: ScriptedEngine, slm: ScriptedEngine) -> None:
        self.real = EngineRegistry(make_settings(), FakeModelRegistryRepository())
        self.jev, self.slm = jev, slm

    async def extraction(self, *, health_data: bool) -> Any:
        return await self.real.extraction(health_data=health_data)

    async def decision(self, *, health_data: bool) -> Any:
        selected = await self.real.decision(health_data=health_data)
        return type(selected)(self.jev, selected.entry.model_copy(update={"engine": "jev"}))

    async def decision_review(self, *, health_data: bool) -> Any:
        selected = await self.real.decision_review(health_data=health_data)
        return type(selected)(self.slm, selected.entry.model_copy(update={"engine": "slm"}))


EXPLAIN_Q = _q("management_plan_summary", "explain", (), 0.7)
PLAN_TEXT = "Start an iron supplement once a day and repeat the blood test in three months."


async def test_unsure_jev_answer_gets_slm_opinion_then_gp() -> None:
    questions = [QUESTIONS[1], QUESTIONS[4], QUESTIONS[0]]  # fatigue, smoker, chest pain
    jev = ScriptedEngine(
        "jev",
        {
            "fatigue_reported": ("yes", 0.5, None),  # unsure
            "smoker_status": ("former", 0.55, None),  # unsure
            "chest_pain_reported": ("yes", 0.95, None),  # confident
        },
    )
    slm = ScriptedEngine(
        "slm",
        {"fatigue_reported": ("yes", 0.85, None), "smoker_status": ("never", 0.4, None)},
    )
    repo = FakeConsultNotesRepository(questions=questions)
    worker, audit = _worker(repo, registry=ScriptedRegistry(jev, slm))
    [summary] = await _run_all(repo, worker)
    assert summary.status == "done"

    # Only the unsure questions are sent for a second opinion.
    assert all(asked == ["fatigue_reported", "smoker_status"] for asked in slm.asked)
    points = {k.question_id: k for k in repo.of("k")}

    fatigue = points["fatigue_reported"]  # SLM more confident: suggested, Jev's kept
    assert (fatigue.answer, fatigue.answer_source, fatigue.engine) == ("yes", "slm", "slm")
    assert fatigue.other_opinion is not None
    assert (fatigue.other_opinion.engine, fatigue.other_opinion.probability) == ("jev", 0.5)
    assert fatigue.meets_threshold is False

    smoker = points["smoker_status"]  # Jev more confident: Jev's answer, SLM's kept
    assert (smoker.answer, smoker.answer_source) == ("former", "decision_engine")
    assert smoker.other_opinion is not None and smoker.other_opinion.answer == "never"

    chest = points["chest_pain_reported"]
    assert (chest.answer_source, chest.other_opinion, chest.meets_threshold) == (
        "decision_engine",
        None,
        True,
    )

    # The GP is asked to confirm every reviewed key point.
    reviews = sorted(o.idempotency_key.rsplit(":", 1)[1] for o in repo.of("o"))
    assert reviews == ["fatigue_reported@1", "smoker_status@1"]
    assert all(
        "Decision engine:" in o.description and "SLM:" in o.description for o in repo.of("o")
    )
    assert {d.tool for d in audit.decisions} >= {"decide_batch", "review_batch"}

    # Re-running inserts nothing new.
    repo.queue.append(ClaimedRun(uuid.uuid4(), TRANSCRIPT, APPT, 0))
    [again] = await _run_all(repo, worker)
    assert again.inserted == 0


async def test_explain_questions_go_straight_to_the_slm() -> None:
    jev = ScriptedEngine("jev", {"fatigue_reported": ("yes", 0.9, None)})
    slm = ScriptedEngine("slm", {"management_plan_summary": ("answered", 0.8, PLAN_TEXT)})
    repo = FakeConsultNotesRepository(questions=[QUESTIONS[1], EXPLAIN_Q])
    worker, audit = _worker(repo, registry=ScriptedRegistry(jev, slm))
    await _run_all(repo, worker)

    assert all("management_plan_summary" not in asked for asked in jev.asked)
    points = {k.question_id: k for k in repo.of("k")}
    plan = points["management_plan_summary"]
    assert (plan.kind, plan.answer, plan.answer_text, plan.answer_source) == (
        "explain",
        "answered",
        PLAN_TEXT,
        "slm",
    )
    assert plan.meets_threshold is False and plan.answer_label is None
    [item] = repo.of("o")
    assert item.idempotency_key.endswith(":explain:management_plan_summary@1")
    assert "iron" not in item.description

    # The explanation is stored for the GP but never logged.
    explain_logs = [d for d in audit.decisions if d.tool == "explain_batch"]
    assert explain_logs and all(
        "iron" not in json.dumps(d.output) and d.output["answers"][0]["text_hash"]
        for d in explain_logs
        if d.output["answers"][0]["answer"] == "answered"
    )


# ---------------------------------------------------------------------------
# Pieces
# ---------------------------------------------------------------------------
def test_windows_and_question_filter() -> None:
    windows = make_windows(list(reversed(SEGMENTS)), 2)
    assert [len(w.segments) for w in windows] == [2, 2, 1]
    assert windows[0].segment_ids == (SEGMENTS[0].id, SEGMENTS[1].id)
    assert windows[0].text.startswith("clinician: Hi Olivia")
    assert "attr_negated" not in {q.id for q in key_point_questions(QUESTIONS)}


def _vote(q: TypedQuestion, answer: str, p: float, n: int) -> Vote:
    return Vote(
        TypedAnswer(question_id=q.id, question_version=1, answer=answer, probability=p),
        (uuid.UUID(int=n),),
    )


def test_aggregate_rules() -> None:
    yes_no, choice, score = QUESTIONS[0], QUESTIONS[4], QUESTIONS[5]

    v = aggregate(yes_no, [_vote(yes_no, "no", 0.95, 1), _vote(yes_no, "yes", 0.85, 2)])
    assert v is not None and v.answer.answer == "yes" and v.segment_ids == (uuid.UUID(int=2),)
    assert aggregate(yes_no, [_vote(yes_no, "not_stated", 0.7, 1)]) is None
    v = aggregate(yes_no, [_vote(yes_no, "no", 0.9, 1), _vote(yes_no, "not_stated", 0.99, 2)])
    assert v is not None and v.answer.answer == "no"

    v = aggregate(choice, [_vote(choice, "former", 0.6, 1), _vote(choice, "never", 0.9, 2)])
    assert v is not None and v.answer.answer == "never"
    assert aggregate(choice, [_vote(choice, "unclear", 0.9, 1)]) is None

    v = aggregate(
        score,
        [
            _vote(score, "soon", 0.95, 1),
            _vote(score, "urgent", 0.85, 2),
            _vote(score, "emergency", 0.5, 3),
        ],
    )
    assert v is not None and v.answer.answer == "urgent"  # highest level meeting the threshold
    assert aggregate(score, [_vote(score, "routine", 0.99, 1)]) is None
    v = aggregate(score, [_vote(score, "soon", 0.5, 1), _vote(score, "urgent", 0.6, 2)])
    assert v is not None and v.answer.answer == "urgent"  # none confident: most probable


def test_repair_offsets() -> None:
    seg = SEGMENTS[2]
    quote = "start an iron supplement"
    start = seg.text.index(quote)
    raw = {
        "value": {"name": "iron"},
        "quote": quote,
        "segment_id": str(seg.id),
        "char_start": 0,
        "char_end": 3,
        "confidence": 0.9,
    }
    fixed = repair_offsets(raw, SEGMENTS)
    assert (fixed["char_start"], fixed["char_end"]) == (start, start + len(quote))

    # Wrong segment id: found uniquely in another segment.
    moved = repair_offsets({**raw, "segment_id": str(SEGMENTS[0].id)}, SEGMENTS)
    assert moved["segment_id"] == str(seg.id)

    # Correct offsets and not-found values are left alone; unknown quotes stay invalid.
    exact = {**raw, "char_start": start, "char_end": start + len(quote)}
    assert repair_offsets(exact, SEGMENTS) == exact
    assert repair_offsets({"value": None, "confidence": 0.5}, SEGMENTS) == {
        "value": None,
        "confidence": 0.5,
    }
    invented = {**raw, "quote": "take two aspirin"}
    assert repair_offsets(invented, SEGMENTS) == invented

    # Ambiguous (twice in the segment): unchanged.
    twice = [_seg(9, "patient", "tired, so tired")]
    amb = {
        "value": {"name": "tired"},
        "quote": "tired",
        "segment_id": str(twice[0].id),
        "char_start": 1,
        "char_end": 2,
        "confidence": 0.9,
    }
    assert repair_offsets(amb, twice) == amb


def test_file_logging_is_redacted(tmp_path: Path) -> None:
    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    try:
        configure_logging("INFO", log_dir=tmp_path / "logs", name="consult-worker")
        logging.getLogger("healthmcp.test").info(
            "run done", extra={"text": "patient said something private", "run_id": "r1"}
        )
        for handler in root.handlers:
            handler.flush()
        content = (tmp_path / "logs" / "consult-worker.log").read_text(encoding="utf-8")
    finally:
        for handler in root.handlers:
            if handler not in saved_handlers:
                handler.close()
        root.handlers[:] = saved_handlers
        root.setLevel(saved_level)
    line = json.loads(content.strip().splitlines()[-1])
    assert line["msg"] == "run done" and line["run_id"] == "r1"
    assert line["text"] == "[redacted]" and "private" not in content


@pytest.mark.parametrize("attempts", [3])
async def test_attempt_limit_stops_claims(attempts: int) -> None:
    repo = FakeConsultNotesRepository()
    repo.queue = [ClaimedRun(uuid.uuid4(), TRANSCRIPT, APPT, attempts)]
    worker, _ = _worker(repo)
    assert await _run_all(repo, worker) == []
