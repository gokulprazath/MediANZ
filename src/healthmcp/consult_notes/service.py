"""Turn one approved consult transcript into draft notes.

  SLM (extraction engine)   every active clinical_field, per window of segments,
                            into draft clinical_facts (grounded quote, hash only).
  Jev (decision engine)     every active decision_question, per window, aggregated
                            into one draft consult_key_point per question.
                            Low-confidence answers and high urgency raise open_items.

The engines come from model_registry with health_data=True, so nothing is sent
to an engine that is not approved for health data. Every engine call is logged
to decision_log with ids and hashes only. Nothing is approved here: the treating
clinician reviews every draft.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import TypeVar
from uuid import UUID

from healthmcp.consult_notes.models import (
    ClaimedRun,
    DraftFact,
    DraftKeyPoint,
    DraftOpenItem,
    NoteResults,
    RunSummary,
)
from healthmcp.consult_notes.repository import ConsultNotesRepository
from healthmcp.shared.context import Context
from healthmcp.shared.engines.decision import DecisionEngine
from healthmcp.shared.engines.extraction import ExtractionEngine
from healthmcp.shared.engines.models import (
    ClinicalField,
    ExtractedValue,
    QuestionOption,
    Segment,
    TypedAnswer,
    TypedQuestion,
)
from healthmcp.shared.engines.registry import EngineRegistry, Selected
from healthmcp.shared.errors import HealthMcpError
from healthmcp.shared.logging import log_decision, sha256_hex
from healthmcp.shared.repositories.audit import AuditRepository

logger = logging.getLogger("healthmcp.consult_notes")

AGENT_ID = "consult-notes"
SERVER = "consult-notes"

# Attribute and evidence questions qualify other findings; they are not key points.
NON_KEY_POINT_PREFIXES = ("attr_", "evidence_")
# Answers that mean "nothing to note".
EMPTY_ANSWERS = frozenset({"not_stated", "unclear", "none"})
URGENCY_QUESTION = "urgency_level"
URGENT_SEVERITY = {2: 6, 3: 9}  # urgency level -> open item severity (0-10)

T = TypeVar("T")


class NotEligible(HealthMcpError):
    code = "not_eligible"
    public_message = "The consult is not eligible for AI processing."


class NoSegments(HealthMcpError):
    code = "no_segments"
    public_message = "The transcript has no segments."


@dataclass(frozen=True)
class Window:
    segments: tuple[Segment, ...]

    @property
    def segment_ids(self) -> tuple[UUID, ...]:
        return tuple(s.id for s in self.segments)

    @property
    def text(self) -> str:
        return "\n".join(f"{s.speaker or 'speaker'}: {s.text}" for s in self.segments)


def make_windows(segments: Sequence[Segment], size: int) -> list[Window]:
    ordered = sorted(segments, key=lambda s: s.seq)
    return [Window(tuple(ordered[i : i + size])) for i in range(0, len(ordered), size)]


def key_point_questions(questions: Sequence[TypedQuestion]) -> list[TypedQuestion]:
    return [q for q in questions if not q.id.startswith(NON_KEY_POINT_PREFIXES)]


@dataclass(frozen=True)
class Vote:
    answer: TypedAnswer
    segment_ids: tuple[UUID, ...]


def _option(question: TypedQuestion, value: str) -> QuestionOption | None:
    return next((o for o in question.options if o.value == value), None)


def _lowest_level(question: TypedQuestion) -> int | None:
    levels = [o.level for o in question.options if o.level is not None]
    return min(levels) if levels else None


def is_empty(question: TypedQuestion, answer: str) -> bool:
    if answer in EMPTY_ANSWERS:
        return True
    if question.kind == "score":
        option = _option(question, answer)
        return option is None or option.level == _lowest_level(question)
    return False


def aggregate(question: TypedQuestion, votes: Sequence[Vote]) -> Vote | None:
    """One answer per question from the per-window answers, or None if nothing to note.

    yes_no: a 'yes' anywhere wins (most probable), otherwise the most probable 'no'.
    choice: the most probable answer.
    score:  the highest level that meets the threshold, otherwise the most probable.
    """
    candidates = [v for v in votes if not is_empty(question, v.answer.answer)]
    if not candidates:
        return None

    def probability(v: Vote) -> float:
        return v.answer.probability

    if question.kind == "yes_no":
        yes = [v for v in candidates if v.answer.answer == "yes"]
        return max(yes or candidates, key=probability)
    if question.kind == "score":
        confident = [v for v in candidates if v.answer.probability >= question.threshold]
        if confident:

            def level(v: Vote) -> tuple[int, float]:
                option = _option(question, v.answer.answer)
                return (option.level if option and option.level is not None else -1, probability(v))

            return max(confident, key=level)
    return max(candidates, key=probability)


def _error_code(exc: BaseException) -> str:
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    return exc.code if isinstance(exc, HealthMcpError) else "internal_error"


class ConsultNotesWorker:
    def __init__(
        self,
        repository: ConsultNotesRepository,
        engines: EngineRegistry,
        audit: AuditRepository,
        *,
        window_segments: int = 20,
        concurrency: int = 4,
        agent_id: str = AGENT_ID,
    ) -> None:
        self._repo = repository
        self._engines = engines
        self._audit = audit
        self._window_segments = window_segments
        self._concurrency = concurrency
        self.agent_id = agent_id

    # -- contexts -----------------------------------------------------------
    def dispatcher_context(self) -> Context:
        """Job context for claiming runs: no appointment, so only reference queries."""
        return Context(
            mode="job",
            agent_id=self.agent_id,
            request_id=str(uuid.uuid4()),
            job_id=f"{self.agent_id}-dispatch-{uuid.uuid4()}",
        )

    def appointment_context(self, appointment_id: UUID, job_id: str | None = None) -> Context:
        return Context(
            mode="job",
            agent_id=self.agent_id,
            request_id=str(uuid.uuid4()),
            job_id=job_id or f"{self.agent_id}-{uuid.uuid4()}",
            appointment_id=appointment_id,
        )

    # -- one run ------------------------------------------------------------
    async def handle(self, run: ClaimedRun) -> RunSummary:
        """Process a claimed run and mark it done or failed (error code only)."""
        ctx = self.appointment_context(
            run.appointment_id, job_id=f"{self.agent_id}-{run.id}-{run.attempts}"
        )
        log_ids = {"run_id": str(run.id), "appointment_id": str(run.appointment_id)}
        try:
            results = await self.build(ctx, run)
            saved = await self._repo.finish(ctx, run.id, results, agent_id=self.agent_id)
        except Exception as exc:
            code = _error_code(exc)
            logger.warning(
                "consult notes run failed",
                extra={**log_ids, "attempt": run.attempts, "error_code": code},
            )
            await self._repo.fail_run(ctx, run.id, code)
            return RunSummary(
                run_id=run.id,
                appointment_id=run.appointment_id,
                status="failed",
                attempt=run.attempts,
                error=code,
            )
        logger.info(
            "consult notes run done",
            extra={
                **log_ids,
                "attempt": run.attempts,
                "facts": len(results.facts),
                "key_points": len(results.key_points),
                "open_items": len(results.open_items),
                "inserted": saved.total,
            },
        )
        return RunSummary(
            run_id=run.id,
            appointment_id=run.appointment_id,
            status="done",
            attempt=run.attempts,
            facts=len(results.facts),
            key_points=len(results.key_points),
            open_items=len(results.open_items),
            inserted=saved.total,
        )

    async def build(self, ctx: Context, run: ClaimedRun) -> NoteResults:
        eligibility = await self._repo.eligibility(ctx)
        if not eligibility.eligible:
            raise NotEligible()
        segments = await self._repo.segments(ctx, run.transcript_id)
        if not segments:
            raise NoSegments()
        windows = make_windows(segments, self._window_segments)
        fields = await self._repo.active_fields(ctx)
        questions = key_point_questions(await self._repo.active_questions(ctx))

        facts: tuple[DraftFact, ...] = ()
        if fields:
            extraction = await self._engines.extraction(health_data=True)
            facts = await self._facts(ctx, run, extraction, fields, windows)

        key_points: tuple[DraftKeyPoint, ...] = ()
        open_items: tuple[DraftOpenItem, ...] = ()
        if questions:
            decision = await self._engines.decision(health_data=True)
            key_points, open_items = await self._key_points(ctx, run, decision, questions, windows)
        return NoteResults(facts=facts, key_points=key_points, open_items=open_items)

    async def _bounded(self, calls: Sequence[Callable[[], Awaitable[T]]]) -> list[T]:
        """Run engine calls with limited concurrency; the first failure cancels the rest."""
        semaphore = asyncio.Semaphore(self._concurrency)

        async def one(call: Callable[[], Awaitable[T]]) -> T:
            async with semaphore:
                return await call()

        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(one(call)) for call in calls]
        return [t.result() for t in tasks]

    # -- SLM: clinical facts --------------------------------------------------
    async def _facts(
        self,
        ctx: Context,
        run: ClaimedRun,
        selected: Selected[ExtractionEngine],
        fields: Sequence[ClinicalField],
        windows: Sequence[Window],
    ) -> tuple[DraftFact, ...]:
        engine, entry = selected.engine, selected.entry

        def call(
            field: ClinicalField, window: Window
        ) -> Callable[[], Awaitable[tuple[ClinicalField, ExtractedValue]]]:
            async def run_call() -> tuple[ClinicalField, ExtractedValue]:
                started = time.monotonic()
                result = await engine.extract(field, window.segments)
                await log_decision(
                    self._audit,
                    ctx,
                    server=SERVER,
                    tool="extract_value",
                    engine=entry.engine,
                    model=engine.info.model,
                    model_version=entry.model_version,
                    question_version=f"{field.id}@{field.version}",
                    input_refs={
                        "transcript_id": str(run.transcript_id),
                        "segment_ids": [str(i) for i in window.segment_ids],
                    },
                    input_text=window.text,
                    output={
                        "found": result.found,
                        "segment_id": str(result.segment_id) if result.segment_id else None,
                        "quote_hash": sha256_hex(result.quote) if result.quote else None,
                    },
                    probability=result.confidence,
                    latency_ms=int((time.monotonic() - started) * 1000),
                )
                return field, result

            return run_call

        results = await self._bounded([call(f, w) for f in fields for w in windows])

        # The same value found in several windows is one fact (highest confidence).
        best: dict[tuple[str, int, str], tuple[ClinicalField, ExtractedValue]] = {}
        for field, result in results:
            if not result.found:
                continue
            value_key = json.dumps(result.value, sort_keys=True, separators=(",", ":"))
            key = (field.id, field.version, value_key)
            if key not in best or result.confidence > best[key][1].confidence:
                best[key] = (field, result)

        facts: list[DraftFact] = []
        for (_, _, value_key), (field, result) in sorted(best.items(), key=lambda kv: kv[0]):
            assert result.quote is not None and result.segment_id is not None
            assert result.char_start is not None and result.char_end is not None
            facts.append(
                DraftFact(
                    field_id=field.id,
                    field_version=field.version,
                    value=result.value,
                    unit=result.unit or field.unit,
                    code_system=field.code_system,
                    segment_ids=(result.segment_id,),
                    quote_hash=sha256_hex(result.quote),
                    char_start=result.char_start,
                    char_end=result.char_end,
                    confidence=result.confidence,
                    engine=entry.engine,
                    model_version=entry.model_version,
                    idempotency_key=(
                        f"cn:{run.transcript_id}:f:{field.id}@{field.version}:"
                        f"{sha256_hex(value_key)[:16]}"
                    ),
                )
            )
        return tuple(facts)

    # -- Jev: key points --------------------------------------------------------
    async def _key_points(
        self,
        ctx: Context,
        run: ClaimedRun,
        selected: Selected[DecisionEngine],
        questions: Sequence[TypedQuestion],
        windows: Sequence[Window],
    ) -> tuple[tuple[DraftKeyPoint, ...], tuple[DraftOpenItem, ...]]:
        engine, entry = selected.engine, selected.entry

        def call(window: Window) -> Callable[[], Awaitable[tuple[Window, list[TypedAnswer]]]]:
            async def run_call() -> tuple[Window, list[TypedAnswer]]:
                started = time.monotonic()
                answers = await engine.decide(questions, window.text)
                await log_decision(
                    self._audit,
                    ctx,
                    server=SERVER,
                    tool="decide_batch",
                    engine=entry.engine,
                    model=engine.info.model,
                    model_version=entry.model_version,
                    question_version=None,
                    input_refs={
                        "transcript_id": str(run.transcript_id),
                        "segment_ids": [str(i) for i in window.segment_ids],
                        "questions": [q.ref for q in questions],
                    },
                    input_text=window.text,
                    output={
                        "answers": [
                            {
                                "question_ref": f"{a.question_id}@{a.question_version}",
                                "answer": a.answer,
                                "probability": a.probability,
                            }
                            for a in answers
                        ]
                    },
                    probability=None,
                    latency_ms=int((time.monotonic() - started) * 1000),
                )
                return window, answers

            return run_call

        results = await self._bounded([call(w) for w in windows])

        votes: dict[tuple[str, int], list[Vote]] = {(q.id, q.version): [] for q in questions}
        for window, answers in results:
            for a in answers:
                votes[(a.question_id, a.question_version)].append(Vote(a, window.segment_ids))

        key_points: list[DraftKeyPoint] = []
        open_items: list[DraftOpenItem] = []
        for q in questions:
            vote = aggregate(q, votes[(q.id, q.version)])
            if vote is None:
                continue
            option = _option(q, vote.answer.answer)
            label = (option.label or option.description) if option else None
            meets = vote.answer.probability >= q.threshold
            key_points.append(
                DraftKeyPoint(
                    transcript_id=run.transcript_id,
                    question_id=q.id,
                    question_version=q.version,
                    kind=q.kind,
                    answer=vote.answer.answer,
                    answer_label=label[:300] if label else None,
                    level=option.level if q.kind == "score" and option else None,
                    probability=vote.answer.probability,
                    threshold=q.threshold,
                    meets_threshold=meets,
                    segment_ids=vote.segment_ids,
                    engine=entry.engine,
                    model_version=entry.model_version,
                    idempotency_key=f"cn:{run.transcript_id}:k:{q.ref}",
                )
            )
            if not meets:
                open_items.append(
                    DraftOpenItem(
                        kind="missing_info",
                        severity=None,
                        description=(
                            f"Confirm key point: {q.text} Suggested answer: "
                            f"{label or vote.answer.answer} "
                            f"({vote.answer.probability:.0%} confidence, "
                            f"threshold {q.threshold:.0%})."
                        )[:2000],
                        idempotency_key=f"cn:{run.transcript_id}:o:missing_info:{q.ref}",
                    )
                )
            elif q.id == URGENCY_QUESTION and option and option.level in URGENT_SEVERITY:
                open_items.append(
                    DraftOpenItem(
                        kind="urgent",
                        severity=URGENT_SEVERITY[option.level],
                        description=(
                            f"Urgency assessed from the consult: "
                            f"{option.description or option.value}."
                        )[:2000],
                        idempotency_key=f"cn:{run.transcript_id}:o:urgent:{q.ref}",
                    )
                )
        return tuple(key_points), tuple(open_items)
