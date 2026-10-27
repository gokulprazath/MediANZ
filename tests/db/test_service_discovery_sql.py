"""SQL behaviour of 20261027020000 and seed 05."""

from __future__ import annotations

import psycopg
import pytest

from .conftest import OLIVIA, Db

pytestmark = pytest.mark.integration

ROOT_CANAL = "70000000-0000-4000-8000-000000000004"
WEST_END_DENTAL = "30000000-0000-4000-8000-000000000005"
DENTIST = "40000000-0000-4000-8000-000000000007"
SILVER_PLUS = "21000000-0000-4000-8000-000000000002"


def test_seed_has_dental_services_clinics_and_prices(db: Db) -> None:
    db.as_admin()
    assert db.val("select count(*) from public.service_catalog") >= 7
    assert (
        db.val("select count(*) from public.clinician_services where service_id = %s", [ROOT_CANAL])
        == 6
    )
    assert (
        db.val("select count(*) from public.service_prices where service_id = %s", [ROOT_CANAL])
        == 6
    )
    assert (
        db.val(
            "select count(*) from public.facilities where id between %s and %s",
            [WEST_END_DENTAL, "30000000-0000-4000-8000-000000000010"],
        )
        == 6
    )


def test_coverage_rules_are_scoped_to_the_patients_own_plan(db: Db) -> None:
    db.as_user("olivia")
    assert (
        db.val(
            "select count(*) from public.insurance_service_rules where plan_id = %s",
            ["21000000-0000-4000-8000-000000000001"],
        )
        == 1
    )
    assert (
        db.val(
            "select count(*) from public.insurance_service_rules where plan_id = %s",
            [SILVER_PLUS],
        )
        == 0
    )

    db.as_user("staff")
    assert db.val("select count(*) from public.insurance_service_rules") >= 10


def test_jobs_cannot_verify_but_staff_can(db: Db) -> None:
    db.as_role("service_role")
    rule_id = db.val(
        """
        insert into public.insurance_service_rules
          (plan_id, service_id, coverage_status, benefit_type, benefit_value,
           source_type, source_url, source_quote)
        values (%s, %s, 'partially_covered', 'percent', 50,
                'privatehealth', 'https://www.privatehealth.gov.au/test',
                'Major dental is covered at 50 percent.')
        returning id
        """,
        [SILVER_PLUS, ROOT_CANAL],
    )
    assert (
        db.val(
            "select verification_level from public.insurance_service_rules where id = %s",
            [rule_id],
        )
        == "primary_extracted"
    )

    err = db.savepoint_error(
        "update public.insurance_service_rules "
        "set verification_level = 'verified', verified_at = now() where id = %s",
        [rule_id],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_user("staff")
    db.q("select public.verify_insurance_rule(%s)", [rule_id])
    db.as_admin()
    row = db.one(
        "select verification_level, verified_at from public.insurance_service_rules where id = %s",
        [rule_id],
    )
    assert row["verification_level"] == "verified"
    assert row["verified_at"] is not None


def test_patient_books_a_dental_service_with_a_quote_snapshot(db: Db) -> None:
    db.as_admin()
    slot_id = db.val(
        """
        select id from public.appointment_slots
         where facility_id = %s and clinician_id = %s
           and status = 'available' and starts_at > now()
         order by starts_at limit 1
        """,
        [WEST_END_DENTAL, DENTIST],
    )

    db.as_user("olivia")
    params = [
        slot_id,
        ROOT_CANAL,
        "Persistent tooth pain",
        "db-test-booking-1",
        1200.00,
        1200.00,
        0.00,
        0.00,
        "not_covered",
        "direct",
        "verified",
    ]
    appointment_id = db.val(
        "select public.book_service_slot(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        params,
    )
    again = db.val(
        "select public.book_service_slot(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        params,
    )
    assert again == appointment_id

    row = db.one(
        """
        select patient_id, service_id, quoted_fee, quoted_gap, coverage_status,
               claim_mode, coverage_verification_level, idempotency_key
          from public.appointments where id = %s
        """,
        [appointment_id],
    )
    assert str(row["patient_id"]) == OLIVIA
    assert str(row["service_id"]) == ROOT_CANAL
    assert row["quoted_fee"] == 1200
    assert row["quoted_gap"] == 1200
    assert row["coverage_status"] == "not_covered"
    assert row["claim_mode"] == "direct"
    assert row["coverage_verification_level"] == "verified"
    assert row["idempotency_key"] == "db-test-booking-1"


def test_booking_rejects_a_stale_quote(db: Db) -> None:
    db.as_admin()
    slot_id = db.val(
        """
        select id from public.appointment_slots
         where facility_id = %s and clinician_id = %s
           and status = 'available' and starts_at > now()
         order by starts_at limit 1
        """,
        [WEST_END_DENTAL, DENTIST],
    )

    db.as_user("olivia")
    err = db.savepoint_error(
        "select public.book_service_slot(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        [
            slot_id,
            ROOT_CANAL,
            "Persistent tooth pain",
            "db-test-booking-stale",
            999.00,
            999.00,
            0.00,
            0.00,
            "not_covered",
            "direct",
            "verified",
        ],
    )
    assert isinstance(err, psycopg.errors.RaiseException)
    assert "Quote has changed" in str(err)
    db.as_admin()
    assert (
        db.val("select status from public.appointment_slots where id = %s", [slot_id])
        == "available"
    )
