"""Typed inputs and outputs shared by every engine implementation."""

from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class EngineInfo(BaseModel):
    model_config = ConfigDict(frozen=True)

    engine: str
    provider: str
    model: str
    model_version: str


class QuestionOption(BaseModel):
    model_config = ConfigDict(frozen=True, extra="ignore")

    value: str = Field(min_length=1)
    label: str | None = None
    level: int | None = None
    description: str | None = None


class TypedQuestion(BaseModel):
    """A decision question as stored in decision_questions (or built at call time)."""

    model_config = ConfigDict(frozen=True)

    id: str
    version: int = Field(ge=1)
    kind: Literal["yes_no", "choice", "score"]
    text: str
    options: tuple[QuestionOption, ...]
    threshold: float = Field(gt=0, le=1)

    @property
    def allowed_values(self) -> frozenset[str]:
        return frozenset(o.value for o in self.options)

    @property
    def ref(self) -> str:
        return f"{self.id}@{self.version}"

    @model_validator(mode="after")
    def _shape(self) -> TypedQuestion:
        values = [o.value for o in self.options]
        if len(set(values)) != len(values):
            raise ValueError("option values must be unique")
        if self.kind == "yes_no" and set(values) != {"yes", "no", "not_stated"}:
            raise ValueError("yes/no questions answer yes, no or not_stated")
        if self.kind == "choice" and "unclear" not in values:
            raise ValueError("choice questions must include 'unclear'")
        if self.kind == "score" and any(
            o.level is None or not (o.description or "").strip() for o in self.options
        ):
            raise ValueError("every score level needs a level number and a description")
        return self


class TypedAnswer(BaseModel):
    model_config = ConfigDict(frozen=True)

    question_id: str
    question_version: int
    answer: str
    probability: float = Field(ge=0, le=1)


class ClinicalField(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    version: int = Field(ge=1)
    label: str
    value_schema: dict[str, Any]
    unit: str | None = None
    code_system: str | None = None
    topic: str


class Segment(BaseModel):
    """One transcript segment, loaded by the server (never supplied by the agent)."""

    model_config = ConfigDict(frozen=True)

    id: UUID
    seq: int
    speaker: str | None = None
    speaker_confidence: float | None = None
    start_sec: float | None = None
    end_sec: float | None = None
    text: str


class ExtractedValue(BaseModel):
    """`char_start`/`char_end` are offsets into the text of `segment_id`. Everything is
    None when the field is not stated."""

    model_config = ConfigDict(frozen=True)

    value: Any | None = None
    unit: str | None = None
    quote: str | None = None
    segment_id: UUID | None = None
    char_start: int | None = Field(default=None, ge=0)
    char_end: int | None = Field(default=None, ge=0)
    confidence: float = Field(ge=0, le=1)

    @property
    def found(self) -> bool:
        return self.value is not None

    @model_validator(mode="after")
    def _consistent(self) -> ExtractedValue:
        if self.value is None:
            return self
        if self.quote is None or self.segment_id is None:
            raise ValueError("a found value needs a quote and a segment id")
        if self.char_start is None or self.char_end is None or self.char_end < self.char_start:
            raise ValueError("a found value needs valid offsets")
        return self


class SearchResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    title: str
    content: str
    score: float | None = None


class ExtractedPage(BaseModel):
    model_config = ConfigDict(frozen=True)

    url: str
    content: str


class PlaceDetails(BaseModel):
    """Review text is held in memory only, to build a summary; it is never stored."""

    model_config = ConfigDict(frozen=True)

    place_id: str
    rating: float | None = Field(default=None, ge=0, le=5)
    review_count: int = Field(default=0, ge=0)
    reviews: tuple[str, ...] = ()
    maps_url: str | None = None
