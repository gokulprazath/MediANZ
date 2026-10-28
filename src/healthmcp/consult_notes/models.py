"""Records the consult-notes worker reads and writes. Ids, enums and hashes only:
transcript text stays in the database and in engine calls, never in these records
(except the structured fact value and an explain key point's text, which are what
the clinician reviews)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


@dataclass(frozen=True)
class ClaimedRun:
    id: UUID
    transcript_id: UUID
    appointment_id: UUID
    attempts: int


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class DraftFact:
    field_id: str
    field_version: int
    value: Any
    unit: str | None
    code_system: str | None
    segment_ids: tuple[UUID, ...]
    quote_hash: str
    char_start: int
    char_end: int
    confidence: float
    engine: str
    model_version: str
    idempotency_key: str


AnswerSource = Literal["decision_engine", "slm"]


@dataclass(frozen=True)
class Opinion:
    """The engine opinion that was not chosen as the suggested answer."""

    answer: str
    probability: float
    engine: str


@dataclass(frozen=True)
class DraftKeyPoint:
    transcript_id: UUID
    question_id: str
    question_version: int
    kind: Literal["yes_no", "choice", "score", "explain"]
    answer: str
    answer_label: str | None
    level: int | None
    probability: float
    threshold: float
    meets_threshold: bool
    segment_ids: tuple[UUID, ...]
    engine: str
    model_version: str
    idempotency_key: str
    answer_source: AnswerSource = "decision_engine"
    # Explain questions only: the SLM's explanation, which the clinician reviews
    # (like a fact value). Never logged.
    answer_text: str | None = None
    other_opinion: Opinion | None = None


@dataclass(frozen=True)
class DraftOpenItem:
    kind: Literal["missing_info", "conflict", "urgent"]
    severity: int | None
    description: str
    idempotency_key: str


@dataclass(frozen=True)
class NoteResults:
    facts: tuple[DraftFact, ...] = ()
    key_points: tuple[DraftKeyPoint, ...] = ()
    open_items: tuple[DraftOpenItem, ...] = ()


@dataclass(frozen=True)
class SavedCounts:
    """Rows inserted by this run (re-runs insert nothing new)."""

    facts: int = 0
    key_points: int = 0
    open_items: int = 0

    @property
    def total(self) -> int:
        return self.facts + self.key_points + self.open_items


class RunSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: UUID
    appointment_id: UUID
    status: Literal["done", "failed"]
    attempt: int
    facts: int = 0
    key_points: int = 0
    open_items: int = 0
    inserted: int = 0
    error: str | None = None
