"""booking tools end to end over the Fake repository."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from healthmcp.servers.booking.repository import (
    OLIVIA_UPCOMING_APPOINTMENT,
    SAMPLE_SLOT,
    TAKEN_SLOT,
    FakeBookingRepository,
)
from healthmcp.servers.booking.tools import NAME, register
from healthmcp.shared.repositories.fake_data import (
    JACK_AUTH_USER,
    OLIVIA_APPROVED_APPOINTMENT,
    OLIVIA_AUTH_USER,
)
from healthmcp.shared.server import HealthServer
from tests.helpers import http_client, mcp_session, running
from tests.unit.servers_helpers import call, job_headers, make_server, session, user_headers


def _server() -> tuple[HealthServer, FakeBookingRepository]:
    repo = FakeBookingRepository()
    server = make_server(NAME, lambda s: register(s, repo))
    return server, repo


async def test_find_hold_and_propose_never_books() -> None:
    server, repo = _server()
    day = (datetime.now(UTC) + timedelta(days=2) + timedelta(hours=10)).date()
    before = dict(repo.data.appointments)
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        slots = await call(s, "get_available_slots", on_date=day.isoformat())
        held = await call(s, "hold_slot", slot_id=str(SAMPLE_SLOT))
        proposal = await call(s, "propose_booking", slot_id=str(SAMPLE_SLOT), visit_type="standard")
        status = await call(s, "get_proposal_status", proposal_id=proposal["proposal_id"])
    assert [x["slot_id"] for x in slots["slots"]] == [str(SAMPLE_SLOT)]
    assert "held_until" in held
    assert proposal["status"] == "pending" and proposal["summary"].startswith("Book Asha Rao")
    assert "Nothing has been booked" in proposal["next_step"]
    assert status["status"] == "pending" and status["result_appointment_id"] is None
    assert repo.data.appointments == before  # spec 7.9: a proposal books nothing


async def test_unavailable_slot_is_refused() -> None:
    server, _ = _server()
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        held = await call(s, "hold_slot", slot_id=str(TAKEN_SLOT))
        proposed = await call(s, "propose_booking", slot_id=str(TAKEN_SLOT))
    assert "no longer available" in held["error"]
    assert "no longer available" in proposed["error"]


async def test_a_slot_held_by_another_patient_is_unavailable_until_the_hold_expires() -> None:
    server, repo = _server()
    day = (datetime.now(UTC) + timedelta(days=2) + timedelta(hours=10)).date().isoformat()
    async with running(server) as transport:
        async with mcp_session(transport, server, user_headers(OLIVIA_AUTH_USER)) as s:
            held = await call(s, "hold_slot", slot_id=str(SAMPLE_SLOT))
            renewed = await call(s, "hold_slot", slot_id=str(SAMPLE_SLOT))
            own = await call(s, "propose_booking", slot_id=str(SAMPLE_SLOT))
        async with mcp_session(transport, server, user_headers(JACK_AUTH_USER)) as s:
            listed = await call(s, "get_available_slots", on_date=day)
            taken = await call(s, "hold_slot", slot_id=str(SAMPLE_SLOT))
            proposed = await call(s, "propose_booking", slot_id=str(SAMPLE_SLOT))
            olivia, _ = repo.data.holds[SAMPLE_SLOT]
            repo.data.holds[SAMPLE_SLOT] = (olivia, datetime.now(UTC) - timedelta(seconds=1))
            after_expiry = await call(s, "hold_slot", slot_id=str(SAMPLE_SLOT))
    assert "held_until" in held and "held_until" in renewed
    assert own["status"] == "pending"
    assert listed["slots"] == []  # like get_available_slots: a live hold hides the slot
    assert "no longer available" in taken["error"]
    assert "no longer available" in proposed["error"]
    assert "held_until" in after_expiry


async def test_cancel_and_reschedule_own_upcoming_appointment() -> None:
    server, _ = _server()
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        cancel = await call(
            s, "propose_cancellation", appointment_id=str(OLIVIA_UPCOMING_APPOINTMENT)
        )
        move = await call(
            s,
            "propose_reschedule",
            appointment_id=str(OLIVIA_UPCOMING_APPOINTMENT),
            new_slot_id=str(SAMPLE_SLOT),
        )
        past = await call(
            s, "propose_cancellation", appointment_id=str(OLIVIA_APPROVED_APPOINTMENT)
        )
    assert cancel["kind"] == "cancel" and move["kind"] == "reschedule"
    assert "Only booked or confirmed" in past["error"]


async def test_other_patients_appointments_and_proposals_are_hidden() -> None:
    server, _ = _server()
    async with running(server) as transport:
        async with mcp_session(transport, server, user_headers(OLIVIA_AUTH_USER)) as s:
            proposal = await call(s, "propose_booking", slot_id=str(SAMPLE_SLOT))
        async with mcp_session(transport, server, user_headers(JACK_AUTH_USER)) as s:
            cancel = await call(
                s, "propose_cancellation", appointment_id=str(OLIVIA_UPCOMING_APPOINTMENT)
            )
            status = await call(s, "get_proposal_status", proposal_id=proposal["proposal_id"])
            unknown = await call(s, "get_proposal_status", proposal_id=str(uuid.uuid4()))
    assert cancel["error"].endswith("Appointment not found.")
    assert status["error"].endswith("Proposal not found.")
    assert unknown["error"].endswith("Proposal not found.")


async def test_reason_length_is_limited() -> None:
    server, _ = _server()
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        result = await s.call_tool(
            "propose_booking", {"slot_id": str(SAMPLE_SLOT), "reason": "x" * 501}
        )
    assert result.is_error


async def test_job_tokens_cannot_use_booking() -> None:
    server, _ = _server()
    async with (
        running(server) as transport,
        http_client(transport, server, job_headers(agent="clinical-doc-agent")) as http,
    ):
        response = await http.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status_code == 403
