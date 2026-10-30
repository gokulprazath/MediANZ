"""Tool outputs for booking (spec 6.6)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

ClinicianType = Literal["gp", "specialist", "nurse", "allied_health"]
ProposalKind = Literal["book", "cancel", "reschedule"]
ProposalState = Literal["pending", "confirmed", "declined", "expired"]


class _Out(BaseModel):
    model_config = ConfigDict(frozen=True)


class Slot(_Out):
    slot_id: UUID
    starts_at: datetime
    ends_at: datetime
    local_start: datetime
    clinician_id: UUID
    clinician_name: str
    clinician_type: str
    specialty: str | None = None
    facility_id: UUID
    facility_name: str
    facility_tz: str


class BookableSlot(Slot):
    bookable: bool


class Slots(_Out):
    slots: list[Slot]


class Hold(_Out):
    slot_id: UUID
    held_until: datetime
    note: str = "The slot is held for you for 5 minutes. Holding does not book it."


class AppointmentBrief(_Out):
    appointment_id: UUID
    status: str
    local_start: datetime
    clinician_name: str
    facility_name: str


class Proposal(_Out):
    proposal_id: UUID
    kind: ProposalKind
    summary: str
    status: ProposalState
    expires_at: datetime
    next_step: str = (
        "Nothing has been booked or changed. The app shows the patient a confirmation "
        "card; only the patient tapping Confirm makes the change."
    )


class ProposalStatus(_Out):
    proposal_id: UUID
    kind: ProposalKind
    status: ProposalState
    expires_at: datetime
    created_at: datetime
    result_appointment_id: UUID | None = None
