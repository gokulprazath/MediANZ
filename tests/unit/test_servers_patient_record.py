"""patient_record tools end to end over the Fake repository."""

from __future__ import annotations

from healthmcp.servers.patient_record.tools import NAME, register
from healthmcp.shared.repositories.fake_data import (
    JACK_AUTH_USER,
    OLIVIA,
    OLIVIA_APPROVED_APPOINTMENT,
    OLIVIA_AUTH_USER,
)
from tests.unit.servers_helpers import audit, call, job_headers, make_server, session, user_headers


async def test_patient_sees_own_approved_facts_and_appointments() -> None:
    server = make_server(NAME, register)
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        names = {t.name for t in (await s.list_tools()).tools}
        facts = await call(s, "get_approved_facts", as_of="2026-10-25")
        appts = await call(s, "get_appointments")
    assert names == {
        "get_approved_facts",
        "get_observations",
        "get_eligibility",
        "get_appointments",
        "log_note",
    }
    assert [f["field_id"] for f in facts["facts"]] == ["bp_reading"]
    assert appts["appointments"][0]["appointment_id"] == str(OLIVIA_APPROVED_APPOINTMENT)
    assert {a.tool for a in audit(server).access} >= {"get_approved_facts", "get_appointments"}


async def test_another_patient_sees_nothing_of_olivias() -> None:
    server = make_server(NAME, register)
    async with session(server, user_headers(JACK_AUTH_USER)) as s:
        facts = await call(s, "get_approved_facts")
        appts = await call(s, "get_appointments")
        obs = await call(s, "get_observations")
    assert facts["facts"] == [] and appts["appointments"] == [] and obs["observations"] == []


async def test_observations_keep_sources_apart() -> None:
    server = make_server(NAME, register)
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        bp = await call(s, "get_observations", kind="blood_pressure")
    sources = sorted(o["source"] for o in bp["observations"])
    assert sources == ["measured", "transcript"]


async def test_eligibility_has_no_card_numbers() -> None:
    server = make_server(NAME, register)
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        result = await call(s, "get_eligibility", on_date="2026-10-29")
    assert result["medicare_eligible"] is True
    assert result["insurance"]["plan_name"] == "Silver Plus Combined"
    assert "medicare_number" not in str(result) and "membership" not in str(result)


async def test_job_mode_reads_the_token_patient() -> None:
    server = make_server(NAME, register)
    async with session(server, job_headers(patient_id=OLIVIA)) as s:
        facts = await call(s, "get_approved_facts")
    assert len(facts["facts"]) == 1


async def test_job_without_patient_is_refused() -> None:
    server = make_server(NAME, register)
    async with session(server, job_headers(patient_id=None)) as s:
        result = await call(s, "get_appointments")
    assert "No patient is associated" in result["error"]


async def test_bad_date_range_is_refused() -> None:
    server = make_server(NAME, register)
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        result = await call(s, "get_appointments", date_from="2026-10-10", date_to="2026-10-01")
    assert "date_to" in result["error"]
