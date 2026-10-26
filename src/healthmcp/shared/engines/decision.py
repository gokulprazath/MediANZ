"""Typed decisions: bool / enum / ordinal answers with a probability each.

Implementations:
  JevEngine          TypeSafe AI System One. Its API is early access and must not be
                     guessed: without JEV_DOCS_PATH it raises EngineNotConfigured, and
                     the client is only written once those docs are available.
  LlmAdapterEngine   A deliberate alternative (System One LLM adapter or equivalent),
                     selected in model_registry; never an automatic fallback. Not built yet.
  MockDecisionEngine Deterministic keyword rules, so everything works with no API keys.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Protocol

from pydantic import TypeAdapter

from healthmcp.shared.config import Settings
from healthmcp.shared.engines.base import check_answers, validated_call
from healthmcp.shared.engines.models import EngineInfo, TypedAnswer, TypedQuestion
from healthmcp.shared.errors import EngineNotConfigured
from healthmcp.shared.repositories.model_registry import EngineEntry

_ANSWERS = TypeAdapter(list[TypedAnswer])


class DecisionEngine(Protocol):
    info: EngineInfo

    async def decide(self, questions: Sequence[TypedQuestion], state: str) -> list[TypedAnswer]: ...


def _info(entry: EngineEntry) -> EngineInfo:
    return EngineInfo(
        engine=entry.engine,
        provider=entry.provider,
        model=entry.model,
        model_version=entry.model_version,
    )


class JevEngine:
    def __init__(self, entry: EngineEntry, settings: Settings) -> None:
        if not settings.jev_docs_path:
            raise EngineNotConfigured("Jev is not configured (JEV_DOCS_PATH is not set).")
        # The API must come from the docs at JEV_DOCS_PATH, not from guesses.
        raise EngineNotConfigured("The Jev client has not been built yet.")

    info: EngineInfo

    async def decide(self, questions: Sequence[TypedQuestion], state: str) -> list[TypedAnswer]:
        raise EngineNotConfigured()


class LlmAdapterEngine:
    def __init__(self, entry: EngineEntry, settings: Settings) -> None:
        raise EngineNotConfigured("The LLM adapter decision engine has not been built yet.")

    info: EngineInfo

    async def decide(self, questions: Sequence[TypedQuestion], state: str) -> list[TypedAnswer]:
        raise EngineNotConfigured()


# ---------------------------------------------------------------------------
# Mock
# ---------------------------------------------------------------------------
_NEGATIONS = re.compile(r"\b(no|not|denies|denied|without|never|none)\b(?:\W+\w+){0,3}\W*$")

_YES_NO_KEYWORDS: dict[str, tuple[str, ...]] = {
    "chest_pain_reported": ("chest pain", "chest tightness", "tight chest"),
    "shortness_of_breath_reported": ("short of breath", "shortness of breath", "breathless"),
    "fatigue_reported": ("tired", "fatigue", "exhausted", "no energy"),
    "medication_started": ("start an", "start a ", "prescrib", "supplement"),
    "follow_up_arranged": ("repeat the", "follow up", "follow-up", "come back", "review in"),
    "attr_hypothetical": ("if that happens", "if it", "in case", "would you"),
    "attr_negated": ("denies", "no ", "not "),
}

_CHOICE_RULES: dict[str, tuple[tuple[str, tuple[str, ...]], ...]] = {
    "smoker_status": (
        ("never", ("never smoked", "non-smoker", "don't smoke", "do not smoke")),
        ("former", ("quit smoking", "ex-smoker", "used to smoke", "gave up smoking")),
        ("current", ("i smoke", "smoker", "cigarettes a day", "still smoke")),
    ),
    "attr_experiencer": (
        ("family", ("my mother", "my father", "my sister", "my brother", "family history")),
    ),
    "attr_temporality": (
        ("past", ("used to", "last year", "previously", "in the past", "years ago")),
        ("future", ("in three months", "next week", "will start", "we will repeat")),
    ),
}
_CHOICE_DEFAULTS = {"attr_experiencer": "patient", "attr_temporality": "current"}

_SCORE_RULES: dict[str, tuple[tuple[int, tuple[str, ...]], ...]] = {
    "pain_severity": (
        (3, ("severe pain", "excruciating", "worst pain", "unbearable")),
        (2, ("moderate pain", "quite painful", "hurts a lot")),
        (1, ("mild pain", "a bit sore", "slight pain", "sore")),
    ),
    "urgency_level": (
        (3, ("chest pain", "can't breathe", "cannot breathe", "unconscious", "call 000")),
        (2, ("urgent", "today", "getting worse", "worsening")),
        (1, ("this week", "within a few days", "soon")),
    ),
}


def _keywords_for(question: TypedQuestion) -> tuple[str, ...]:
    if question.id in _YES_NO_KEYWORDS:
        return _YES_NO_KEYWORDS[question.id]
    base = re.sub(r"_(reported|status|present|mentioned)$", "", question.id)
    return (base.replace("_", " "),)


def _find(state: str, phrases: Sequence[str]) -> int | None:
    for phrase in phrases:
        idx = state.find(phrase)
        if idx >= 0:
            return idx
    return None


def _negated(state: str, idx: int) -> bool:
    return bool(_NEGATIONS.search(state[max(0, idx - 40) : idx]))


def _find_affirmed(state: str, phrases: Sequence[str]) -> int | None:
    """First occurrence of any phrase that is not negated ("no chest pain")."""
    for phrase in phrases:
        start = 0
        while (idx := state.find(phrase, start)) >= 0:
            if not _negated(state, idx):
                return idx
            start = idx + 1
    return None


class MockDecisionEngine:
    """Deterministic, keyword-based. Same input, same output."""

    def __init__(self, entry: EngineEntry, settings: Settings | None = None) -> None:
        self.info = _info(entry)

    def _answer(self, q: TypedQuestion, state: str) -> dict[str, object]:
        text = state.lower()
        answer: str
        probability: float
        if q.kind == "yes_no":
            idx = _find(text, _keywords_for(q))
            if idx is None:
                answer, probability = "not_stated", 0.70
            elif q.id != "attr_negated" and _find_affirmed(text, _keywords_for(q)) is None:
                answer, probability = "no", 0.85
            else:
                answer, probability = "yes", 0.90
        elif q.kind == "choice":
            answer, probability = _CHOICE_DEFAULTS.get(q.id, "unclear"), 0.60
            rules = _CHOICE_RULES.get(q.id) or tuple(
                (o.value, (o.value.replace("_", " "),) + ((o.label.lower(),) if o.label else ()))
                for o in q.options
                if o.value not in {"unclear", "none"}
            )
            for value, phrases in rules:
                if value in q.allowed_values and _find_affirmed(text, phrases) is not None:
                    answer, probability = value, 0.88
                    break
        else:
            levels = {o.level: o.value for o in q.options if o.level is not None}
            answer, probability = levels[min(levels)], 0.65
            for level, phrases in _SCORE_RULES.get(q.id, ()):
                if level in levels and _find_affirmed(text, phrases) is not None:
                    answer, probability = levels[level], 0.87
                    break
        return {
            "question_id": q.id,
            "question_version": q.version,
            "answer": answer,
            "probability": probability,
        }

    async def decide(self, questions: Sequence[TypedQuestion], state: str) -> list[TypedAnswer]:
        async def call() -> list[dict[str, object]]:
            return [self._answer(q, state) for q in questions]

        return await validated_call(
            call, _ANSWERS, check=check_answers(questions), engine=self.info.engine
        )
