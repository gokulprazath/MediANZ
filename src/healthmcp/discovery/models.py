"""Typed request, response and internal models for discovery and booking."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_DATE_RANGE_DAYS = 31
MAX_RESULTS = 100


class CoverageStatus(StrEnum):
    COVERED = "covered"
    PARTIALLY_COVERED = "partially_covered"
    NOT_COVERED = "not_covered"
    WAITING_PERIOD = "waiting_period"
    LIMIT_REACHED = "limit_reached"
    PRE_AUTH_REQUIRED = "pre_auth_required"
    NO_POLICY = "no_policy"
    UNKNOWN = "unknown"


class AcceptanceStatus(StrEnum):
    ACCEPTED = "accepted"
    NOT_ACCEPTED = "not_accepted"
    UNKNOWN = "unknown"


class ClaimMode(StrEnum):
    DIRECT = "direct"
    MANUAL = "manual"
    NOT_SUPPORTED = "not_supported"
    UNKNOWN = "unknown"


class VerificationLevel(StrEnum):
    VERIFIED = "verified"
    PRIMARY_EXTRACTED = "primary_extracted"
    FALLBACK_UNVERIFIED = "fallback_unverified"


class SourceType(StrEnum):
    PHIO = "phio"
    PRIVATEHEALTH = "privatehealth"
    INSURER_SITE = "insurer_site"
    PROVIDER_DIRECTORY = "provider_directory"
    CLINIC_SITE = "clinic_site"
    PATIENT_DOCUMENT = "patient_document"
    STAFF = "staff"


VERIFY_WARNING = (
    "Coverage is based on public information and is not guaranteed. "
    "Confirm the benefit and claim method with your insurer and clinic."
)


class Service(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    code: str
    name: str
    category: str
    insurance_category: str | None = None
    required_specialty: str | None = None
    default_duration_minutes: int = 30


class ServiceMatch(BaseModel):
    model_config = ConfigDict(frozen=True)

    service: Service | None
    needs_clarification: bool = False
    candidates: tuple[Service, ...] = ()


class DiscoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    service_code: str | None = Field(default=None, min_length=1, max_length=64)
    problem_text: str | None = Field(default=None, min_length=1, max_length=500)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    max_distance_km: float = Field(default=50.0, gt=0, le=500)
    date_from: date | None = None
    date_to: date | None = None
    limit: int = Field(default=MAX_RESULTS, ge=1, le=MAX_RESULTS)
    include_agent_descriptions: bool = True

    @model_validator(mode="after")
    def _validate(self) -> DiscoveryRequest:
        if not self.service_code and not self.problem_text:
            raise ValueError("service_code or problem_text is required")
        if (self.date_from is None) != (self.date_to is None):
            raise ValueError("date_from and date_to must be supplied together")
        if self.date_from is not None and self.date_to is not None:
            if self.date_to < self.date_from:
                raise ValueError("date_to must not be before date_from")
            if (self.date_to - self.date_from).days > MAX_DATE_RANGE_DAYS:
                raise ValueError(f"date range is limited to {MAX_DATE_RANGE_DAYS} days")
        return self


class PatientPreferences(BaseModel):
    model_config = ConfigDict(frozen=True)

    preferred_languages: tuple[str, ...] = ()
    preferred_clinician_sex: str | None = None
    preferred_facility_ids: frozenset[UUID] = frozenset()
    telehealth_ok: bool = False
    max_distance_km: int | None = None


class CandidateRow(BaseModel):
    """One clinician at one facility with the earliest suitable slot."""

    model_config = ConfigDict(frozen=True)

    facility_id: UUID
    facility_name: str
    facility_description: str | None = None
    facility_website: str | None = None
    address_line1: str
    suburb: str
    state: str
    postcode: str
    timezone: str
    latitude: float | None = None
    longitude: float | None = None
    distance_km: float
    rating: float | None = None
    review_count: int = 0

    clinician_id: UUID
    clinician_name: str
    clinician_type: str
    clinician_sex: str | None = None
    specialty: str | None = None
    languages: tuple[str, ...] = ()
    offers_telehealth: bool = False
    accepting_new_patients: bool = True

    service_id: UUID
    service_code: str
    fee: Decimal | None = None
    medicare_rebate: Decimal | None = None
    price_checked_at: datetime | None = None

    next_slot_id: UUID
    next_slot_start: datetime
    next_slot_local: datetime


class PolicyContext(BaseModel):
    model_config = ConfigDict(frozen=True)

    policy_id: UUID
    plan_id: UUID
    insurer_provider_id: UUID
    valid_from: date


class CoverageRule(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    plan_id: UUID
    service_id: UUID | None = None
    insurance_category: str | None = None
    coverage_status: CoverageStatus
    benefit_type: Literal["none", "fixed", "percent", "mbs_percent"] = "none"
    benefit_value: Decimal | None = None
    annual_limit: Decimal | None = None
    waiting_period_days: int = 0
    requires_preauth: bool = False
    verification_level: VerificationLevel
    source_type: SourceType
    source_url: str | None = None
    source_quote: str | None = None
    retrieved_at: datetime | None = None
    valid_from: date
    valid_to: date | None = None


class AcceptanceRule(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    facility_id: UUID
    insurer_provider_id: UUID
    plan_id: UUID | None = None
    service_id: UUID | None = None
    insurance_category: str | None = None
    accepted: bool
    claim_mode: ClaimMode
    verification_level: VerificationLevel
    source_type: SourceType
    source_url: str | None = None
    source_quote: str | None = None
    retrieved_at: datetime | None = None
    valid_from: date
    valid_to: date | None = None


class InsuranceResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    coverage_status: CoverageStatus
    acceptance_status: AcceptanceStatus
    claim_mode: ClaimMode
    verification_level: VerificationLevel | None = None
    verification_required: bool = True
    direct_billing_available: bool = False
    fee: Decimal | None = None
    medicare_rebate: Decimal | None = None
    insurance_benefit: Decimal | None = None
    gap: Decimal | None = None
    reason_codes: tuple[str, ...] = ()
    source_url: str | None = None
    source_quote: str | None = None
    coverage_as_of: datetime | None = None
    disclaimer: str | None = None

    @property
    def claimable(self) -> bool:
        return (
            self.coverage_status
            in {
                CoverageStatus.COVERED,
                CoverageStatus.PARTIALLY_COVERED,
                CoverageStatus.PRE_AUTH_REQUIRED,
            }
            and self.acceptance_status == AcceptanceStatus.ACCEPTED
            and self.claim_mode in {ClaimMode.DIRECT, ClaimMode.MANUAL}
        )


class FactorScores(BaseModel):
    model_config = ConfigDict(frozen=True)

    service: float
    insurance: float
    availability: float
    cost: float
    distance: float
    preference: float
    rating: float


class ProviderOption(BaseModel):
    model_config = ConfigDict(frozen=True)

    clinician_id: UUID
    clinician_name: str
    specialty: str | None = None
    languages: tuple[str, ...] = ()
    offers_telehealth: bool = False
    next_slot_id: UUID
    next_slot_start: datetime
    next_slot_local: datetime
    fee: Decimal | None = None
    medicare_rebate: Decimal | None = None
    insurance: InsuranceResult
    score: float = Field(ge=0, le=1)
    factors: FactorScores


class ClinicCard(BaseModel):
    model_config = ConfigDict(frozen=True)

    facility_id: UUID
    facility_name: str
    description: str
    address_line1: str
    suburb: str
    state: str
    postcode: str
    timezone: str
    latitude: float | None = None
    longitude: float | None = None
    distance_km: float
    rating: float | None = None
    review_count: int = 0
    service_code: str
    score: float = Field(ge=0, le=1)
    rank: int = Field(ge=1)
    flags: tuple[str, ...] = ()
    category_ranks: dict[str, int] = Field(default_factory=dict)
    primary_option: ProviderOption
    options: tuple[ProviderOption, ...] = ()
    agent_description: str | None = None


class DiscoveryResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    request_id: str
    generated_at: datetime
    service: Service
    search_radius_km: float
    candidate_count: int
    returned_count: int
    ranking_version: str
    category_rankings: dict[str, list[UUID]] = Field(default_factory=dict)
    clinics: tuple[ClinicCard, ...] = ()


class AvailabilitySlot(BaseModel):
    model_config = ConfigDict(frozen=True)

    slot_id: UUID
    facility_id: UUID
    facility_name: str
    clinician_id: UUID
    clinician_name: str
    starts_at: datetime
    ends_at: datetime
    local_start: datetime
    timezone: str


class BookingSlot(BaseModel):
    model_config = ConfigDict(frozen=True)

    slot_id: UUID
    facility_id: UUID
    clinician_id: UUID
    starts_at: datetime
    ends_at: datetime
    local_start: datetime
    local_date: date
    timezone: str


class InsuranceCheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    service_code: str
    facility_id: UUID
    appointment_date: date | None = None
    fee: Decimal | None = Field(default=None, ge=0)


class InsuranceCheckResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    service: Service
    facility_id: UUID
    insurance: InsuranceResult


class SlotHoldRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slot_id: UUID


class SlotHoldResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    slot_id: UUID
    held_until: datetime


class BookingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slot_id: UUID
    service_code: str
    reason: str | None = Field(default=None, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=128)
    expected_fee: Decimal | None = Field(default=None, ge=0)
    expected_gap: Decimal | None = Field(default=None, ge=0)


class BookingResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    appointment_id: UUID
    status: str
    scheduled_start: datetime
    facility_id: UUID
    clinician_id: UUID
    service_code: str
    quoted_fee: Decimal | None = None
    quoted_gap: Decimal | None = None
    coverage_status: CoverageStatus
    claim_mode: ClaimMode


class AppointmentSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    appointment_id: UUID
    status: str
    scheduled_start: datetime
    scheduled_end: datetime
    facility_id: UUID
    facility_name: str
    clinician_id: UUID
    clinician_name: str
    service_code: str | None = None
    reason: str | None = None
    quoted_fee: Decimal | None = None
    quoted_gap: Decimal | None = None
    coverage_status: str | None = None
    claim_mode: str | None = None


class CancelAppointmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)


class DocumentRegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_id: UUID | None = None
    storage_path: str = Field(min_length=1, max_length=500)
    file_name: str = Field(min_length=1, max_length=255)


class InsuranceDocument(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    patient_id: UUID
    plan_id: UUID | None = None
    storage_path: str
    file_name: str
    status: str
    uploaded_at: datetime
    expires_at: datetime | None = None


class ResearchTarget(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    target_type: Literal["plan_coverage", "facility_acceptance"]
    plan_id: UUID | None = None
    facility_id: UUID | None = None
    insurer_provider_id: UUID | None = None
    service_id: UUID | None = None
    insurance_category: str | None = None
    url: str | None = None
    source_type: SourceType
    priority: int = 100
    plan_name: str | None = None
    facility_name: str | None = None
    insurer_name: str | None = None
    service_name: str | None = None


class ResearchDraftSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    kind: Literal["coverage", "acceptance"]
    status: str
    plan_id: UUID | None = None
    facility_id: UUID | None = None
    insurer_provider_id: UUID | None = None
    service_id: UUID | None = None
    insurance_category: str | None = None
    coverage_status: CoverageStatus | None = None
    accepted: bool | None = None
    claim_mode: ClaimMode | None = None
    source_type: SourceType
    source_url: str | None = None
    evidence_quote: str
    confidence: float
    created_at: datetime


class ApproveResearchDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    valid_from: date | None = None


class RejectResearchDraftRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)


class ApprovedResearchDraft(BaseModel):
    model_config = ConfigDict(frozen=True)

    draft_id: UUID
    rule_id: UUID


class ResearchRefreshRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plan_ids: tuple[UUID, ...] = ()
    insurance_category: str | None = Field(default=None, max_length=64)
    limit: int = Field(default=10, ge=1, le=100)
    include_fallback: bool = True
    dry_run: bool = False


class ResearchRunSummary(BaseModel):
    model_config = ConfigDict(frozen=True)

    run_id: UUID | None = None
    source: str
    status: str
    targets: int
    pages_fetched: int
    drafts_created: int
    errors: int
    notes: tuple[str, ...] = ()


class VerificationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, max_length=500)


class CoverageExtraction(BaseModel):
    """Strict output required from the research extractor."""

    model_config = ConfigDict(extra="forbid")

    coverage_status: CoverageStatus
    benefit_type: Literal["none", "fixed", "percent", "mbs_percent"] = "none"
    benefit_value: Decimal | None = Field(default=None, ge=0)
    annual_limit: Decimal | None = Field(default=None, ge=0)
    waiting_period_days: int = Field(default=0, ge=0, le=3650)
    requires_preauth: bool = False
    evidence_quote: str = Field(min_length=1, max_length=1000)
    confidence: float = Field(ge=0, le=1)


class AcceptanceExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    accepted: bool
    claim_mode: ClaimMode
    evidence_quote: str = Field(min_length=1, max_length=1000)
    confidence: float = Field(ge=0, le=1)
