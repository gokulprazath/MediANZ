"""Answer decision questions over transcript segments (spec 6.2).

  * yes_no / choice / score questions go to the decision engine (Jev), with
    attribute questions (negated, experiencer, temporality, hypothetical) and
    an evidence question ("which segment supports this?") in the same call.
  * An answer below decision_review_below (0.6) also gets the SLM's opinion;
    the more confident one is suggested, both are returned, and the answer is
    marked for the GP to confirm (an explicit step, never a silent fallback).
  * explain questions (free text) go straight to the SLM and always need the GP.

Engines come from model_registry with health_data=True. Every engine call is
logged to decision_log with ids and hashes only.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from healthmcp.shared.context import Context
from healthmcp.shared.engines.decision import DecisionEngine
from healthmcp.shared.engines.models import QuestionOption, Segment, TypedAnswer, TypedQuestion
from healthmcp.shared.engines.registry import EngineRegistry, Selected
from healthmcp.shared.errors import InvalidRequest, NotFound
from healthmcp.shared.guards import UntrustedText, untrusted
from healthmcp.shared.logging import log_decision, sha256_hex
from healthmcp.shared.repositories.audit import AuditRepository

ATTRIBUTE_PREFIX = "attr_"
EVIDENCE_TEMPLATE = "evidence_segment"
HELPER_SEPARATOR = "__"
NOT_ASKABLE_PREFIXES = (ATTRIBUTE_PREFIX, "evidence_")
MAX_QUESTIONS = 25

AnswerSource = Literal["decision_engine", "slm"]


class _Out(BaseModel):
    model_config = ConfigDict(frozen=True)


class Opinion(_Out):
    answer: str
    probability: float
    engine: str


class Attributes(_Out):
    negated: bool | None = None
    experiencer: str | None = None
    temporality: str | None = None
    hypothetical: bool | None = None


class Answer(_Out):
    question_id: str
    question_version: int
    kind: str
    answer: str
    answer_label: str | None = None
    level: int | None = None
    probability: float
    threshold: float
    meets_threshold: bool
    engine: str
    model_version: str
    answer_source: AnswerSource
    other_opinion: Opinion | None = None
    needs_gp_review: bool
    attributes: Attributes | None = None
    evidence_segment_ids: list[UUID] = []
    text: UntrustedText | None = None  # explain questions only


def _option(q: TypedQuestion, value: str) -> QuestionOption | None:
    return next((o for o in q.options if o.value == value), None)


def _helper(
    template: TypedQuestion, q: TypedQuestion, text: str, extra: tuple[QuestionOption, ...] = ()
) -> TypedQuestion:
    return TypedQuestion(
        id=f"{template.id}{HELPER_SEPARATOR}{q.id}",
        version=template.version,
        kind=template.kind,
        text=text,
        options=template.options + extra,
        threshold=template.threshold,
    )


class DecisionService:
    def __init__(
        self,
        engines: EngineRegistry,
        audit: AuditRepository,
        *,
        server: str,
        review_below: float,
    ) -> None:
        self._engines = engines
        self._audit = audit
        self._server = server
        self._review_below = review_below

    @staticmethod
    def pick(active: Sequence[TypedQuestion], ids: Sequence[str]) -> list[TypedQuestion]:
        """The active questions asked for, in order. Helper questions cannot be asked."""
        wanted = list(dict.fromkeys(ids))
        if not wanted:
            raise InvalidRequest("Give at least one question id.")
        if len(wanted) > MAX_QUESTIONS:
            raise InvalidRequest(f"Give at most {MAX_QUESTIONS} question ids.")
        if any(i.startswith(NOT_ASKABLE_PREFIXES) for i in wanted):
            raise InvalidRequest("Attribute and evidence questions are added by the server.")
        by_id = {q.id: q for q in active}
        missing = [i for i in wanted if i not in by_id]
        if missing:
            raise NotFound("Unknown or inactive question id.")
        return [by_id[i] for i in wanted]

    def _helpers(
        self, q: TypedQuestion, active: Sequence[TypedQuestion], segments: Sequence[Segment]
    ) -> list[TypedQuestion]:
        out: list[TypedQuestion] = []
        for t in active:
            if t.id.startswith(ATTRIBUTE_PREFIX):
                out.append(_helper(t, q, f'About the question "{q.text}": {t.text}'))
            elif t.id == EVIDENCE_TEMPLATE:
                extra = tuple(
                    QuestionOption(value=str(s.id), label=f"Segment {s.seq}") for s in segments
                )
                out.append(_helper(t, q, f"{t.text} Question: {q.text}", extra))
        return out

    async def _call(
        self,
        ctx: Context,
        selected: Selected[DecisionEngine],
        questions: Sequence[TypedQuestion],
        segments: Sequence[Segment],
        state: str,
        tool: str,
    ) -> dict[str, TypedAnswer]:
        started = time.monotonic()
        answers = await selected.engine.decide(questions, state)
        await log_decision(
            self._audit,
            ctx,
            server=self._server,
            tool=tool,
            engine=selected.entry.engine,
            model=selected.engine.info.model,
            model_version=selected.entry.model_version,
            question_version=None,
            input_refs={
                "segment_ids": [str(s.id) for s in segments],
                "questions": [q.ref for q in questions],
            },
            input_text=state,
            output={
                "answers": [
                    {
                        "question_ref": f"{a.question_id}@{a.question_version}",
                        "answer": a.answer,
                        "probability": a.probability,
                        "text_hash": sha256_hex(a.text) if a.text else None,
                    }
                    for a in answers
                ]
            },
            probability=None,
            latency_ms=int((time.monotonic() - started) * 1000),
        )
        return {a.question_id: a for a in answers}

    async def decide(
        self,
        ctx: Context,
        questions: Sequence[TypedQuestion],
        active: Sequence[TypedQuestion],
        segments: Sequence[Segment],
        state: str,
        *,
        tool: str,
    ) -> list[Answer]:
        jev_qs = [q for q in questions if q.kind != "explain"]
        explain_qs = [q for q in questions if q.kind == "explain"]
        results: dict[str, Answer] = {}

        if jev_qs:
            selected = await self._engines.decision(health_data=True)
            helpers = [h for q in jev_qs for h in self._helpers(q, active, segments)]
            got = await self._call(ctx, selected, [*jev_qs, *helpers], segments, state, tool)
            unsure = [q for q in jev_qs if got[q.id].probability < self._review_below]
            second: dict[str, TypedAnswer] = {}
            review: Selected[DecisionEngine] | None = None
            if unsure:
                review = await self._engines.decision_review(health_data=True)
                second = await self._call(ctx, review, unsure, segments, state, f"{tool}:review")
            for q in jev_qs:
                results[q.id] = self._answer(
                    q,
                    got,
                    selected,
                    second.get(q.id),
                    review,
                    segment_ids={s.id for s in segments},
                )

        if explain_qs:
            slm = await self._engines.decision_review(health_data=True)
            got = await self._call(ctx, slm, explain_qs, segments, state, f"{tool}:explain")
            for q in explain_qs:
                a = got[q.id]
                results[q.id] = Answer(
                    question_id=q.id,
                    question_version=q.version,
                    kind=q.kind,
                    answer=a.answer,
                    probability=a.probability,
                    threshold=q.threshold,
                    meets_threshold=False,  # free text is always confirmed by the GP
                    engine=slm.entry.engine,
                    model_version=slm.entry.model_version,
                    answer_source="slm",
                    needs_gp_review=True,
                    text=untrusted(a.text) if a.text else None,
                )
        return [results[q.id] for q in questions]

    def _answer(
        self,
        q: TypedQuestion,
        got: dict[str, TypedAnswer],
        first: Selected[DecisionEngine],
        second: TypedAnswer | None,
        review: Selected[DecisionEngine] | None,
        *,
        segment_ids: set[UUID],
    ) -> Answer:
        a = got[q.id]
        chosen, source, entry = a, "decision_engine", first.entry
        other: Opinion | None = None
        reviewed = second is not None and review is not None
        if second is not None and review is not None:
            if second.probability > a.probability:  # a tie keeps the decision engine's answer
                chosen, source, entry = second, "slm", review.entry
                other = Opinion(
                    answer=a.answer, probability=a.probability, engine=first.entry.engine
                )
            else:
                other = Opinion(
                    answer=second.answer, probability=second.probability, engine=review.entry.engine
                )
        option = _option(q, chosen.answer)
        meets = chosen.probability >= q.threshold and not reviewed
        return Answer(
            question_id=q.id,
            question_version=q.version,
            kind=q.kind,
            answer=chosen.answer,
            answer_label=(option.label or option.description) if option else None,
            level=option.level if q.kind == "score" and option else None,
            probability=chosen.probability,
            threshold=q.threshold,
            meets_threshold=meets,
            engine=entry.engine,
            model_version=entry.model_version,
            answer_source="slm" if source == "slm" else "decision_engine",
            other_opinion=other,
            needs_gp_review=reviewed or not meets,
            attributes=_attributes(q, got),
            evidence_segment_ids=_evidence(q, got, segment_ids),
        )


def _helper_answer(got: dict[str, TypedAnswer], template: str, q: TypedQuestion) -> str | None:
    a = got.get(f"{template}{HELPER_SEPARATOR}{q.id}")
    return a.answer if a else None


def _attributes(q: TypedQuestion, got: dict[str, TypedAnswer]) -> Attributes | None:
    def yes(template: str) -> bool | None:
        value = _helper_answer(got, template, q)
        return None if value in (None, "not_stated") else value == "yes"

    def choice(template: str) -> str | None:
        value = _helper_answer(got, template, q)
        return None if value in (None, "unclear") else value

    attrs = Attributes(
        negated=yes("attr_negated"),
        experiencer=choice("attr_experiencer"),
        temporality=choice("attr_temporality"),
        hypothetical=yes("attr_hypothetical"),
    )
    return None if attrs == Attributes() else attrs


def _evidence(q: TypedQuestion, got: dict[str, TypedAnswer], segment_ids: set[UUID]) -> list[UUID]:
    value = _helper_answer(got, EVIDENCE_TEMPLATE, q)
    if value is None:
        return []
    try:
        seg = UUID(value)
    except ValueError:
        return []  # "none" / "unclear"
    return [seg] if seg in segment_ids else []
