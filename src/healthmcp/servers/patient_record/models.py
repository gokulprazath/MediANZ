"""Tool outputs for patient_record (spec 6.4). Read only; ids, values and labels."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

AppointmentStatus = Literal[
    "booked",
    "confirmed",
    "checked_in",
    "in_consultation",
    "completed",
    "cancelled",
    "no_show",
    "rescheduled",
]
ObservationKind = Literal[
    "temperature", "spo2", "blood_pressure", "height", "weight", "bmi", "other"
]


class _Out(BaseModel):
    model_config = ConfigDict(frozen=True)


class ApprovedFact(_Out):
    fact_id: UUID
    appointment_id: UUID
    field_id: str
    field_version: int
    label: str
    topic: str
    value: Any
    unit: str | None = None
    code_system: str | None = None
    status: Literal["approved", "superseded"]
    negated: bool = False
    experiencer: str = "patient"
    temporality: str = "current"
    valid_from: date
    valid_to: date | None = None
    superseded_by: UUID | None = None


class ApprovedFacts(_Out):
    as_of: date
    facts: list[ApprovedFact]


class Observation(_Out):
    kind: ObservationKind
    field_id: str | None = None  # transcript observations: the clinical field
    value: Any
    unit: str | None = None
    observed_at: datetime
    source: Literal["measured", "transcript"]
    appointment_id: UUID
    fact_id: UUID | None = None


class Observations(_Out):
    note: str = (
        "Measured vitals and approved transcript observations are listed separately "
        "and never merged; each row says its source."
    )
    observations: list[Observation]


class Residency(_Out):
    code: str
    category: str
    name: str
    medicare_eligible: bool
    valid_from: date
    valid_to: date | None = None


class InsuranceInForce(_Out):
    policy_id: UUID
    plan_id: UUID
    plan_name: str
    cover_type: str
    tier: str | None = None
    insurer_name: str
    valid_from: date
    valid_to: date | None = None


class Eligibility(_Out):
    date: date
    residency: Residency | None = None
    medicare_eligible: bool
    medicare_card_valid: bool
    insurance: InsuranceInForce | None = None


class AppointmentRow(_Out):
    appointment_id: UUID
    status: AppointmentStatus
    scheduled_start: datetime
    scheduled_end: datetime
    local_start: datetime
    timezone: str
    visit_type: str | None = None
    clinician_id: UUID
    clinician_name: str
    clinician_type: str
    facility_id: UUID
    facility_name: str
    facility_suburb: str | None = None


class Appointments(_Out):
    appointments: list[AppointmentRow]


# Approved transcript facts that are observations, by clinical field.
FIELD_KINDS: dict[str, ObservationKind] = {
    "bp_reading": "blood_pressure",
    "body_temperature": "temperature",
    "body_weight": "weight",
}
