"""Booking reads and proposal writes (spec 6.6). User mode only (RLS applies).

Agents never book: they create `booking_proposals` rows, and only the patient
confirming in the app (confirm_booking_proposal, not granted to jobs) books.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Protocol
from uuid import UUID

from healthmcp.servers.booking.models import (
    AppointmentBrief,
    BookableSlot,
    ClinicianType,
    ProposalKind,
    ProposalState,
    ProposalStatus,
    Slot,
)
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database
from healthmcp.shared.repositories.fake_data import DR_RAO, OLIVIA, OLIVIA_APPROVED_APPOINTMENT


class BookingRepository(Protocol):
    async def available_slots(
        self,
        ctx: Context,
        *,
        on_date: date,
        facility_id: UUID | None,
        clinician_id: UUID | None,
        clinician_type: ClinicianType | None,
    ) -> list[Slot]: ...

    async def hold_slot(self, ctx: Context, slot_id: UUID) -> datetime: ...

    async def slot(self, ctx: Context, slot_id: UUID) -> BookableSlot | None: ...

    async def appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentBrief | None: ...

    async def create_proposal(
        self,
        ctx: Context,
        *,
        kind: ProposalKind,
        slot_id: UUID | None = None,
        appointment_id: UUID | None = None,
        new_slot_id: UUID | None = None,
        reason: str | None = None,
        visit_type: str | None = None,
    ) -> ProposalStatus: ...

    async def proposal(self, ctx: Context, proposal_id: UUID) -> ProposalStatus | None: ...


_SLOT = """
select s.id as slot_id, s.starts_at, s.ends_at,
       (s.starts_at at time zone f.timezone) as local_start,
       c.id as clinician_id, c.first_name || ' ' || c.last_name as clinician_name,
       c.clinician_type::text as clinician_type, c.specialty, f.id as facility_id,
       f.name as facility_name, f.timezone as facility_tz,
       (s.starts_at > now()
        and (s.status = 'available'
             or (s.status = 'held'
                 and (s.held_until < now() or s.held_by_patient_id = %(scope_patient_id)s))))
         as bookable
  from public.appointment_slots s
  join public.facilities f on f.id = s.facility_id
  join public.clinicians c on c.id = s.clinician_id
 where s.id = %(slot_id)s
"""

_APPOINTMENT = """
select a.id as appointment_id, a.status::text as status,
       (a.scheduled_start at time zone f.timezone) as local_start,
       c.first_name || ' ' || c.last_name as clinician_name, f.name as facility_name
  from public.appointments a
  join public.facilities f on f.id = a.facility_id
  join public.clinicians c on c.id = a.clinician_id
 where a.id = %(appointment_id)s and a.patient_id = %(scope_patient_id)s
"""

_INSERT_PROPOSAL = """
insert into public.booking_proposals
  (patient_id, kind, slot_id, appointment_id, new_slot_id, reason, visit_type, created_by_agent)
values
  (%(scope_patient_id)s, %(kind)s, %(slot_id)s, %(appointment_id)s, %(new_slot_id)s,
   %(reason)s, %(visit_type)s, %(agent)s)
returning id as proposal_id, kind, status, expires_at, created_at, result_appointment_id
"""

_PROPOSAL = """
select id as proposal_id, kind,
       case when status = 'pending' and expires_at < now() then 'expired' else status end
         as status,
       expires_at, created_at, result_appointment_id
  from public.booking_proposals
 where id = %(proposal_id)s and patient_id = %(scope_patient_id)s
"""


class PgBookingRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def available_slots(
        self,
        ctx: Context,
        *,
        on_date: date,
        facility_id: UUID | None,
        clinician_id: UUID | None,
        clinician_type: ClinicianType | None,
    ) -> list[Slot]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select * from public.get_available_slots(%(on_date)s::date, "
                "%(facility_id)s::uuid, %(clinician_id)s::uuid, "
                "%(clinician_type)s::public.clinician_type) limit 300",
                {
                    "on_date": on_date,
                    "facility_id": facility_id,
                    "clinician_id": clinician_id,
                    "clinician_type": clinician_type,
                },
            )
        return [Slot.model_validate(r) for r in rows]

    async def hold_slot(self, ctx: Context, slot_id: UUID) -> datetime:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select public.hold_slot(%(slot_id)s) as held_until", {"slot_id": slot_id}
            )
        assert row is not None
        held: datetime = row["held_until"]
        return held

    async def slot(self, ctx: Context, slot_id: UUID) -> BookableSlot | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(_SLOT, {"slot_id": slot_id})
        return BookableSlot.model_validate(row) if row else None

    async def appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentBrief | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(_APPOINTMENT, {"appointment_id": appointment_id})
        return AppointmentBrief.model_validate(row) if row else None

    async def create_proposal(
        self,
        ctx: Context,
        *,
        kind: ProposalKind,
        slot_id: UUID | None = None,
        appointment_id: UUID | None = None,
        new_slot_id: UUID | None = None,
        reason: str | None = None,
        visit_type: str | None = None,
    ) -> ProposalStatus:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                _INSERT_PROPOSAL,
                {
                    "kind": kind,
                    "slot_id": slot_id,
                    "appointment_id": appointment_id,
                    "new_slot_id": new_slot_id,
                    "reason": reason,
                    "visit_type": visit_type,
                    "agent": ctx.agent_id[:64],
                },
            )
        assert row is not None
        return ProposalStatus.model_validate(row)

    async def proposal(self, ctx: Context, proposal_id: UUID) -> ProposalStatus | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(_PROPOSAL, {"proposal_id": proposal_id})
        return ProposalStatus.model_validate(row) if row else None


# ---------------------------------------------------------------------------
# Fake
# ---------------------------------------------------------------------------
SAMPLE_SLOT = UUID("ee000000-0000-4000-8000-0000000000a1")
TAKEN_SLOT = UUID("ee000000-0000-4000-8000-0000000000a2")
OLIVIA_UPCOMING_APPOINTMENT = UUID("ee000000-0000-4000-8000-0000000000b1")


class SlotTaken(Exception):
    """Raised like the database does when a slot can no longer be held."""

    sqlstate = "P0001"


class RowRefused(Exception):
    """Raised like the database does for a record outside the caller's scope."""

    sqlstate = "42501"


def _slot(slot_id: UUID, start: datetime, *, bookable: bool) -> BookableSlot:
    return BookableSlot(
        slot_id=slot_id,
        starts_at=start,
        ends_at=start + timedelta(minutes=15),
        local_start=(start + timedelta(hours=10)).replace(tzinfo=None),
        clinician_id=DR_RAO,
        clinician_name="Asha Rao",
        clinician_type="gp",
        specialty="General Practice",
        facility_id=UUID("30000000-0000-4000-8000-000000000001"),
        facility_name="Southbank Family Medical",
        facility_tz="Australia/Brisbane",
        bookable=bookable,
    )


@dataclass
class FakeBookingData:
    slots: dict[UUID, BookableSlot] = field(default_factory=dict)
    appointments: dict[UUID, tuple[UUID, AppointmentBrief]] = field(default_factory=dict)
    proposals: dict[UUID, tuple[UUID, ProposalStatus]] = field(default_factory=dict)
    # slot id -> (patient holding it, held_until)
    holds: dict[UUID, tuple[UUID, datetime]] = field(default_factory=dict)


def sample_booking(now: datetime | None = None) -> FakeBookingData:
    start = (now or datetime.now(UTC)).replace(microsecond=0) + timedelta(days=2)
    slots = {
        SAMPLE_SLOT: _slot(SAMPLE_SLOT, start, bookable=True),
        TAKEN_SLOT: _slot(TAKEN_SLOT, start + timedelta(minutes=15), bookable=False),
    }
    upcoming = AppointmentBrief(
        appointment_id=OLIVIA_UPCOMING_APPOINTMENT,
        status="booked",
        local_start=(start + timedelta(days=1)).replace(tzinfo=None),
        clinician_name="Asha Rao",
        facility_name="Southbank Family Medical",
    )
    done = AppointmentBrief(
        appointment_id=OLIVIA_APPROVED_APPOINTMENT,
        status="completed",
        local_start=datetime(2026, 10, 21, 9, 0),
        clinician_name="Asha Rao",
        facility_name="Southbank Family Medical",
    )
    return FakeBookingData(
        slots=slots,
        appointments={
            OLIVIA_UPCOMING_APPOINTMENT: (OLIVIA, upcoming),
            OLIVIA_APPROVED_APPOINTMENT: (OLIVIA, done),
        },
    )


class FakeBookingRepository:
    """Holds follow public.hold_slot / get_available_slots: a slot held by another
    patient is unavailable until the hold expires; the holder may renew it."""

    def __init__(self, data: FakeBookingData | None = None) -> None:
        self.data = data or sample_booking()

    def _held_by_other(self, slot_id: UUID, patient: UUID | None, now: datetime) -> bool:
        hold = self.data.holds.get(slot_id)
        return hold is not None and hold[1] > now and hold[0] != patient

    def _bookable(self, s: BookableSlot, patient: UUID | None, now: datetime) -> bool:
        return s.bookable and s.starts_at > now and not self._held_by_other(s.slot_id, patient, now)

    async def available_slots(
        self,
        ctx: Context,
        *,
        on_date: date,
        facility_id: UUID | None,
        clinician_id: UUID | None,
        clinician_type: ClinicianType | None,
    ) -> list[Slot]:
        now = datetime.now(UTC)
        return [
            Slot.model_validate(s.model_dump(exclude={"bookable"}))
            for s in self.data.slots.values()
            if s.bookable
            and s.starts_at > now
            and not self._held_by_other(s.slot_id, None, now)  # any live hold hides it
            and s.local_start.date() == on_date
            and (facility_id is None or s.facility_id == facility_id)
            and (clinician_id is None or s.clinician_id == clinician_id)
            and (clinician_type is None or s.clinician_type == clinician_type)
        ]

    async def hold_slot(self, ctx: Context, slot_id: UUID) -> datetime:
        patient = ctx.require_patient()
        now = datetime.now(UTC)
        s = self.data.slots.get(slot_id)
        if s is None or not self._bookable(s, patient, now):
            raise SlotTaken()
        until = now + timedelta(minutes=5)
        self.data.holds[slot_id] = (patient, until)
        return until

    async def slot(self, ctx: Context, slot_id: UUID) -> BookableSlot | None:
        s = self.data.slots.get(slot_id)
        if s is None:
            return None
        return s.model_copy(
            update={"bookable": self._bookable(s, ctx.patient_id, datetime.now(UTC))}
        )

    async def appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentBrief | None:
        found = self.data.appointments.get(appointment_id)
        return found[1] if found and found[0] == ctx.patient_id else None

    async def create_proposal(
        self,
        ctx: Context,
        *,
        kind: ProposalKind,
        slot_id: UUID | None = None,
        appointment_id: UUID | None = None,
        new_slot_id: UUID | None = None,
        reason: str | None = None,
        visit_type: str | None = None,
    ) -> ProposalStatus:
        patient = ctx.require_patient()
        if appointment_id is not None and await self.appointment(ctx, appointment_id) is None:
            raise RowRefused()
        now = datetime.now(UTC)
        state: ProposalState = "pending"
        status = ProposalStatus(
            proposal_id=uuid.uuid4(),
            kind=kind,
            status=state,
            expires_at=now + timedelta(minutes=10),
            created_at=now,
        )
        self.data.proposals[status.proposal_id] = (patient, status)
        return status

    async def proposal(self, ctx: Context, proposal_id: UUID) -> ProposalStatus | None:
        found = self.data.proposals.get(proposal_id)
        return found[1] if found and found[0] == ctx.patient_id else None
