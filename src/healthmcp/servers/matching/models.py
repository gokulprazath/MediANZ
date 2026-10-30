"""Tool inputs and outputs for matching (spec 6.5)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from healthmcp.shared.guards import UntrustedText

ClinicianType = Literal["gp", "specialist", "nurse", "allied_health"]
Sex = Literal["female", "male", "intersex", "not_stated"]


class _Out(BaseModel):
    model_config = ConfigDict(frozen=True)


class Preferences(_Out):
    preferred_languages: list[str] = []
    preferred_clinician_sex: Sex | None = None
    preferred_facility_ids: list[UUID] = []
    telehealth_ok: bool = False
    max_distance_km: int | None = None
    stored: bool = False


class Near(BaseModel):
    """Where to search from: a postcode, or latitude and longitude."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    postcode: str | None = Field(default=None, pattern=r"^\d{4}$")
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class Overrides(BaseModel):
    """Preferences for this search only; anything left out uses the stored preferences."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    languages: list[str] | None = Field(default=None, max_length=10)
    clinician_sex: Sex | None = None
    telehealth: bool | None = None


class CandidateSearch(_Out):
    date_from: date
    date_to: date
    lat: float | None
    lng: float | None
    max_km: float | None
    clinician_type: ClinicianType | None
    languages: list[str] | None
    sex: str | None
    telehealth: bool | None


class Candidate(_Out):
    clinician_id: UUID
    clinician_name: str
    clinician_type: str
    specialty: str | None = None
    sex: str | None = None
    languages: list[str] = []
    offers_telehealth: bool = False
    facility_id: UUID
    facility_name: str
    facility_suburb: str | None = None
    distance_km: float | None = None
    next_slot_id: UUID | None = None
    next_slot_start: datetime | None = None
    next_slot_local: datetime | None = None
    facility_tz: str | None = None


class Candidates(_Out):
    applied: CandidateSearch
    candidates: list[Candidate]


class Factor(_Out):
    factor: str
    score: float
    computed_at: datetime


class ScoreBreakdown(_Out):
    clinician_id: UUID
    scoring_version: str | None
    visible_rating_count: int
    rating_factors_shown: bool
    factors: list[Factor]


class FeeEstimate(_Out):
    is_estimate: Literal[True] = True
    label: str = "Estimate only: the clinic confirms the final fee and rebates."
    fee_schedule_id: UUID | None = None
    mbs_item: str | None = None
    fee: Decimal | None = None
    medicare_eligible: bool | None = None
    medicare_rebate: Decimal | None = None
    plan_id: UUID | None = None
    plan_version_id: UUID | None = None
    insurance_benefit: Decimal | None = None
    gap: Decimal | None = None


class PlanCoverage(_Out):
    available: bool
    plan_id: UUID | None = None
    plan_name: str | None = None
    plan_version_id: UUID | None = None
    valid_from: date | None = None
    valid_to: date | None = None
    hospital_inclusions: Any = None
    hospital_exclusions: Any = None
    hospital_restricted: Any = None
    excess: Decimal | None = None
    extras_limits: Any = None
    waiting_periods: Any = None
    gp_benefit: Any = None
    source: str | None = None
    source_url: str | None = None
    verified_at: datetime | None = None


class ReviewSummary(_Out):
    facility_id: UUID
    facility_name: str
    available: bool
    rating: float | None = None
    review_count: int = 0
    non_clinical_summary: UntrustedText | None = None  # generated from web reviews
    source: str | None = None
    source_url: str | None = None
    retrieved_at: datetime | None = None

    @field_validator("non_clinical_summary", mode="before")
    @classmethod
    def _wrap(cls, v: Any) -> Any:
        return {"text": v} if isinstance(v, str) else v
