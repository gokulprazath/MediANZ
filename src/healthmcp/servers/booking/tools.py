"""booking server (spec 6.6): user mode, the signed-in patient only.

Tools find and hold slots and create proposals. A proposal never books,
cancels or moves anything: the app shows a confirmation card and only the
patient's tap (confirm_booking_proposal) makes the change.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated
from uuid import UUID

from pydantic import Field

from healthmcp.servers.booking.models import (
    ClinicianType,
    Hold,
    Proposal,
    ProposalStatus,
    Slots,
)
from healthmcp.servers.booking.repository import (
    BookingRepository,
    FakeBookingRepository,
    PgBookingRepository,
)
from healthmcp.servers.common import database_errors
from healthmcp.shared.context import current_context
from healthmcp.shared.errors import HealthMcpError, NotFound
from healthmcp.shared.server import HealthServer

NAME = "booking"
CHANGEABLE = frozenset({"booked", "confirmed"})

Reason = Annotated[str, Field(min_length=1, max_length=500)]
VisitType = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")]


class SlotUnavailable(HealthMcpError):
    code = "slot_unavailable"
    public_message = "That slot is no longer available. Look for another slot."


class AppointmentNotChangeable(HealthMcpError):
    code = "appointment_not_changeable"
    public_message = "Only booked or confirmed upcoming appointments can be changed."


def _when(local: datetime) -> str:
    return local.strftime("%a %d %b %Y %H:%M")


def register(server: HealthServer, repo: BookingRepository | None = None) -> None:
    booking: BookingRepository = repo or (
        PgBookingRepository(server.deps.db)
        if server.deps.db is not None
        else FakeBookingRepository()
    )

    async def bookable(slot_id: UUID) -> str:
        """A short description of a slot the patient can book, or SlotUnavailable."""
        slot = await booking.slot(current_context(), slot_id)
        if slot is None or not slot.bookable:
            raise SlotUnavailable()
        return (
            f"{slot.clinician_name} at {slot.facility_name}, "
            f"{_when(slot.local_start)} ({slot.facility_tz})"
        )

    async def changeable(appointment_id: UUID) -> str:
        appt = await booking.appointment(current_context(), appointment_id)
        if appt is None:
            raise NotFound("Appointment not found.")
        if appt.status not in CHANGEABLE:
            raise AppointmentNotChangeable()
        return f"{appt.clinician_name} at {appt.facility_name}, {_when(appt.local_start)}"

    def proposal(status: ProposalStatus, summary: str) -> Proposal:
        return Proposal(
            proposal_id=status.proposal_id,
            kind=status.kind,
            summary=summary,
            status=status.status,
            expires_at=status.expires_at,
        )

    @server.tool()
    async def get_available_slots(
        on_date: date,
        facility_id: UUID | None = None,
        clinician_id: UUID | None = None,
        clinician_type: ClinicianType | None = None,
    ) -> Slots:
        """Free appointment slots on a local date, optionally for one facility or clinician.

        Read only. Times are given in UTC and as facility local time.
        """
        ctx = current_context()
        ctx.require_patient()
        slots = await booking.available_slots(
            ctx,
            on_date=on_date,
            facility_id=facility_id,
            clinician_id=clinician_id,
            clinician_type=clinician_type,
        )
        return Slots(slots=slots)

    @server.tool()
    async def hold_slot(slot_id: UUID) -> Hold:
        """Hold a slot for the patient for 5 minutes while they decide.

        A hold does not book the slot. Use propose_booking next.
        """
        ctx = current_context()
        ctx.require_patient()
        with database_errors(not_found="Slot not found.", invalid=SlotUnavailable.public_message):
            held_until = await booking.hold_slot(ctx, slot_id)
        return Hold(slot_id=slot_id, held_until=held_until)

    @server.tool()
    async def propose_booking(
        slot_id: UUID, reason: Reason | None = None, visit_type: VisitType | None = None
    ) -> Proposal:
        """Prepare a booking for the patient to confirm in the app.

        This does NOT book. It returns a proposal (expires in 10 minutes); the
        app shows a confirmation card and only the patient's Confirm books it.
        """
        ctx = current_context()
        ctx.require_patient()
        what = await bookable(slot_id)
        with database_errors(not_found="Slot not found."):
            status = await booking.create_proposal(
                ctx, kind="book", slot_id=slot_id, reason=reason, visit_type=visit_type
            )
        return proposal(status, f"Book {what}.")

    @server.tool()
    async def propose_cancellation(appointment_id: UUID, reason: Reason | None = None) -> Proposal:
        """Prepare a cancellation of one of the patient's appointments, for them to confirm.

        This does NOT cancel. Only the patient's Confirm in the app cancels.
        """
        ctx = current_context()
        ctx.require_patient()
        what = await changeable(appointment_id)
        with database_errors(not_found="Appointment not found."):
            status = await booking.create_proposal(
                ctx, kind="cancel", appointment_id=appointment_id, reason=reason
            )
        return proposal(status, f"Cancel the appointment with {what}.")

    @server.tool()
    async def propose_reschedule(appointment_id: UUID, new_slot_id: UUID) -> Proposal:
        """Prepare moving one of the patient's appointments to a new slot, for them to confirm.

        This does NOT reschedule. Only the patient's Confirm in the app moves it.
        """
        ctx = current_context()
        ctx.require_patient()
        current = await changeable(appointment_id)
        target = await bookable(new_slot_id)
        with database_errors(not_found="Appointment not found."):
            status = await booking.create_proposal(
                ctx, kind="reschedule", appointment_id=appointment_id, new_slot_id=new_slot_id
            )
        return proposal(status, f"Move the appointment with {current} to {target}.")

    @server.tool()
    async def get_proposal_status(proposal_id: UUID) -> ProposalStatus:
        """Status of one of the patient's proposals, and the resulting appointment once confirmed.

        Read only: it cannot confirm or decline a proposal.
        """
        ctx = current_context()
        ctx.require_patient()
        found = await booking.proposal(ctx, proposal_id)
        if found is None:
            raise NotFound("Proposal not found.")
        return found
