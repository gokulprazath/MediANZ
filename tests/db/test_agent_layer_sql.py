"""SQL behaviour of 20261027000000/20261027010000 and seed 04 (spec 4.10)."""

from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from decimal import Decimal

import psycopg
import pytest

from .conftest import (
    DR_NGUYEN,
    DR_RAO,
    DR_WILLIAMS,
    JACK,
    LUKAS_APPT,
    LUKAS_PENDING_TRANSCRIPT,
    OLIVIA,
    OLIVIA_APPROVED_APPT,
    OLIVIA_APPROVED_TRANSCRIPT,
    PADDINGTON,
    PRIYA,
    SOUTHBANK,
    Db,
)

pytestmark = pytest.mark.integration

SOUTHBANK_LAT, SOUTHBANK_LNG = -27.4775, 153.0208


def _segment_ids(db: Db, appointment_id: str) -> list[str]:
    db.as_admin()
    return [
        str(r["id"])
        for r in db.q(
            "select id from public.transcript_segments where appointment_id = %s order by seq",
            [appointment_id],
        )
    ]


def _insert_draft_fact(db: Db, key: str, field_id: str = "current_medication") -> str:
    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    return str(
        db.val(
            """insert into public.clinical_facts
                 (appointment_id, field_id, field_version, value, source, source_segment_ids,
                  quote_hash, char_start, char_end, confidence, engine, model_version,
                  idempotency_key, created_by_agent)
               values (%s, %s, 1, %s, 'transcript', %s::uuid[], %s, 0, 10, 0.9, 'mock_extraction',
                       '1', %s, 'clinical-doc-agent')
               returning id""",
            [
                OLIVIA_APPROVED_APPT,
                field_id,
                json.dumps({"name": "iron supplement", "frequency": "once a day"}),
                segs[2:3],
                hashlib.sha256(b"start an iron supplement").hexdigest(),
                key,
            ],
        )
    )


# ---------------------------------------------------------------------------
# Consent-version gate (4.1)
# ---------------------------------------------------------------------------
def test_eligible_with_v2_consents_and_approved_transcript(db: Db) -> None:
    row = db.one("select * from public.get_processing_eligibility(%s)", [OLIVIA_APPROVED_APPT])
    assert row == {"eligible": True, "reasons": []}


def test_v1_consent_is_not_eligible(db: Db) -> None:
    db.q(
        "update public.recording_consents set consent_text_version = 'v1' "
        "where appointment_id = %s and party = 'clinician'",
        [OLIVIA_APPROVED_APPT],
    )
    row = db.one("select * from public.get_processing_eligibility(%s)", [OLIVIA_APPROVED_APPT])
    assert row["eligible"] is False
    assert row["reasons"] == ["clinician_consent_version_excludes_ai"]


def test_withdrawn_consent_and_unapproved_transcript_are_not_eligible(db: Db) -> None:
    withdrawn = db.one(
        "select * from public.get_processing_eligibility('60000000-0000-4000-8000-000000000006')"
    )
    assert withdrawn["eligible"] is False
    assert "patient_consent_withdrawn" in withdrawn["reasons"]
    assert "no_approved_transcript" in withdrawn["reasons"]

    pending = db.one("select * from public.get_processing_eligibility(%s)", [LUKAS_APPT])
    assert pending["eligible"] is False
    assert "no_approved_transcript" in pending["reasons"]


def test_unknown_consent_version_is_rejected(db: Db) -> None:
    err = db.savepoint_error(
        "update public.recording_consents set consent_text_version = 'v99' where appointment_id = %s",
        [OLIVIA_APPROVED_APPT],
    )
    assert isinstance(err, psycopg.errors.ForeignKeyViolation)


def test_app_users_cannot_call_eligibility(db: Db) -> None:
    db.as_user("olivia")
    err = db.savepoint_error(
        "select * from public.get_processing_eligibility(%s)", [OLIVIA_APPROVED_APPT]
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)


# ---------------------------------------------------------------------------
# Segments on approval (4.2)
# ---------------------------------------------------------------------------
def test_seed_backfilled_segments_match_transcript_offsets(db: Db) -> None:
    rows = db.q(
        """select s.seq, s.speaker, s.text,
                  substr(t.transcript_text, s.char_start + 1, s.char_end - s.char_start) as span
             from public.transcript_segments s
             join public.consult_transcripts t on t.id = s.transcript_id
            where s.transcript_id = %s order by s.seq""",
        [OLIVIA_APPROVED_TRANSCRIPT],
    )
    assert [r["seq"] for r in rows] == [1, 2, 3, 4, 5]
    assert [r["speaker"] for r in rows] == [
        "clinician",
        "patient",
        "clinician",
        "patient",
        "clinician",
    ]
    assert all(r["span"] == r["text"] for r in rows)


def test_approving_a_transcript_without_segments_splits_sentences(db: Db) -> None:
    assert (
        db.val(
            "select count(*) from public.transcript_segments where transcript_id = %s",
            [LUKAS_PENDING_TRANSCRIPT],
        )
        == 0
    )
    db.as_user("lukas")
    db.q("select public.approve_transcript(%s)", [LUKAS_PENDING_TRANSCRIPT])
    db.as_admin()
    rows = db.q(
        """select s.seq, s.speaker, s.text,
                  substr(t.transcript_text, s.char_start + 1, s.char_end - s.char_start) as span
             from public.transcript_segments s
             join public.consult_transcripts t on t.id = s.transcript_id
            where s.transcript_id = %s order by s.seq""",
        [LUKAS_PENDING_TRANSCRIPT],
    )
    assert len(rows) >= 5
    assert rows[0]["speaker"] == "Dr Williams"
    assert rows[0]["text"] == "So you rolled your ankle playing football on Saturday?"
    assert rows[1]["speaker"] == "Lukas"
    assert all(r["span"] == r["text"] for r in rows)
    assert not any(r["text"].startswith(("Dr Williams:", "Lukas:")) for r in rows)


def test_segments_visible_to_patient_and_treating_clinician_only(db: Db) -> None:
    for who, expected in (("olivia", 5), ("rao", 5), ("williams", 0), ("jack", 0)):
        db.as_user(who)
        count = db.val(
            "select count(*) from public.transcript_segments where appointment_id = %s",
            [OLIVIA_APPROVED_APPT],
        )
        assert count == expected, who


# ---------------------------------------------------------------------------
# Deletion cascade (4.5)
# ---------------------------------------------------------------------------
def test_consent_withdrawal_removes_derived_data_and_strips_approved_sources(db: Db) -> None:
    draft = _insert_draft_fact(db, "test-cascade-draft-0001")
    to_approve = _insert_draft_fact(db, "test-cascade-approve-0001", field_id="follow_up")
    db.as_role("service_role")
    db.q(
        "insert into public.open_items (appointment_id, kind, severity, description, idempotency_key) "
        "values (%s, 'urgent', 2, 'Check iron result', 'test-cascade-item-0001')",
        [OLIVIA_APPROVED_APPT],
    )
    db.q(
        "insert into public.gp_queries (appointment_id, question, idempotency_key) "
        "values (%s, 'Dose confirmed?', 'test-cascade-query-0001')",
        [OLIVIA_APPROVED_APPT],
    )
    db.as_user("rao")
    db.q("select public.approve_fact(%s)", [to_approve])

    db.as_user("olivia")
    db.q("select public.withdraw_recording_consent(%s, 'test')", [OLIVIA_APPROVED_APPT])

    db.as_admin()
    assert db.val("select count(*) from public.clinical_facts where id = %s", [draft]) == 0
    assert (
        db.val(
            "select count(*) from public.open_items where appointment_id = %s",
            [OLIVIA_APPROVED_APPT],
        )
        == 0
    )
    assert (  # open questions go; answered ones (seed 07) stay, as in spec 4.4
        db.val(
            "select count(*) from public.gp_queries where appointment_id = %s and status = 'open'",
            [OLIVIA_APPROVED_APPT],
        )
        == 0
    )
    kept = db.one(
        "select status, source_segment_ids, quote_hash, source_removed_at "
        "from public.clinical_facts where id = %s",
        [to_approve],
    )
    assert kept["status"] == "approved"
    assert kept["source_segment_ids"] == []
    assert kept["quote_hash"] is None
    assert kept["source_removed_at"] is not None
    assert (
        db.val(
            "select count(*) from public.transcript_segments where appointment_id = %s",
            [OLIVIA_APPROVED_APPT],
        )
        == 0
    )


def test_urgent_open_item_creates_notification(db: Db) -> None:
    db.as_role("service_role")
    db.q(
        "insert into public.open_items (appointment_id, kind, severity, description, idempotency_key) "
        "values (%s, 'urgent', 3, 'Needs review', 'test-notify-0001')",
        [OLIVIA_APPROVED_APPT],
    )
    db.as_admin()
    row = db.one(
        "select facility_id, kind from public.notifications where appointment_id = %s",
        [OLIVIA_APPROVED_APPT],
    )
    assert str(row["facility_id"]) == SOUTHBANK
    assert row["kind"] == "urgent_open_item"


# ---------------------------------------------------------------------------
# Agents cannot approve (4.4 / 4.6)
# ---------------------------------------------------------------------------
def test_agents_can_only_insert_drafts(db: Db) -> None:
    fact = _insert_draft_fact(db, "test-guard-draft-0001")
    db.as_role("service_role")
    err = db.savepoint_error(
        "update public.clinical_facts set status = 'approved' where id = %s", [fact]
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)
    err = db.savepoint_error("delete from public.clinical_facts where id = %s", [fact])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)
    err = db.savepoint_error("select public.approve_fact(%s)", [fact])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)
    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    err = db.savepoint_error(
        """insert into public.clinical_facts
             (appointment_id, field_id, field_version, value, source, source_segment_ids, status,
              approved_by, approved_at)
           values (%s, 'allergy', 1, '{"substance":"x"}', 'transcript', %s::uuid[], 'approved',
                   gen_random_uuid(), now())""",
        [OLIVIA_APPROVED_APPT, segs[:1]],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)


def test_only_treating_clinician_or_staff_review(db: Db) -> None:
    fact = _insert_draft_fact(db, "test-review-0001")
    for who in ("olivia", "williams"):
        db.as_user(who)
        err = db.savepoint_error("select public.approve_fact(%s)", [fact])
        assert isinstance(err, psycopg.errors.InsufficientPrivilege), who
    db.as_user("staff")
    db.q(
        "select public.edit_and_approve_fact(%s, %s)",
        [fact, json.dumps({"name": "ferrous sulfate"})],
    )
    db.as_admin()
    row = db.one(
        "select status, value_edited, approved_by from public.clinical_facts where id = %s", [fact]
    )
    assert row["status"] == "approved" and row["value_edited"] is True
    assert str(row["approved_by"]) == "ee000000-0000-4000-8000-000000000021"


def test_supersede_closes_old_fact(db: Db) -> None:
    fact = _insert_draft_fact(db, "test-supersede-0001")
    db.as_user("rao")
    db.q("select public.approve_fact(%s)", [fact])
    new_id = db.val("select public.supersede_fact(%s, %s)", [fact, json.dumps({"name": "iron 2"})])
    db.as_admin()
    old = db.one(
        "select status, superseded_by, valid_to from public.clinical_facts where id = %s", [fact]
    )
    new = db.one("select status, source from public.clinical_facts where id = %s", [new_id])
    assert old["status"] == "superseded" and old["superseded_by"] == new_id
    assert old["valid_to"] is not None
    assert new == {"status": "approved", "source": "clinician_entered"}


# ---------------------------------------------------------------------------
# RLS on facts, open items, GP queries (4.4)
# ---------------------------------------------------------------------------
def test_patient_sees_approved_facts_only_and_clinician_sees_own_appointments(db: Db) -> None:
    draft = _insert_draft_fact(db, "test-rls-draft-0001")
    approved = _insert_draft_fact(db, "test-rls-approved-0001", field_id="follow_up")
    db.as_role("service_role")
    db.q(
        "insert into public.open_items (appointment_id, kind, description, idempotency_key) "
        "values (%s, 'missing_info', 'Dose not stated', 'test-rls-item-0001')",
        [OLIVIA_APPROVED_APPT],
    )
    db.as_user("rao")
    db.q("select public.approve_fact(%s)", [approved])

    db.as_user("olivia")
    visible = {str(r["id"]) for r in db.q("select id from public.clinical_facts")}
    assert approved in visible and draft not in visible
    assert db.val("select count(*) from public.open_items") == 0

    db.as_user("rao")
    visible = {str(r["id"]) for r in db.q("select id from public.clinical_facts")}
    assert {draft, approved} <= visible
    # Her own appointments' items (the worker adds more on a live project).
    assert (
        db.val(
            "select count(*) from public.open_items where idempotency_key = 'test-rls-item-0001'"
        )
        == 1
    )

    db.as_user("williams")
    assert db.val("select count(*) from public.clinical_facts") == 0
    assert db.val("select count(*) from public.open_items") == 0

    db.as_user("jack")
    assert db.val("select count(*) from public.clinical_facts") == 0


# ---------------------------------------------------------------------------
# Append-only logs (3.3)
# ---------------------------------------------------------------------------
LOG_TABLES = ("agent_access_log", "decision_log", "agent_notes", "web_research_log")


def test_logs_written_only_through_functions_as_mcp_server(db: Db) -> None:
    db.as_role("mcp_server")
    access_id = db.val(
        "select public.log_agent_access('patient-assistant', 'user', gen_random_uuid(), null, %s, "
        "null, 'booking', 'hold_slot', true, null, 12)",
        [OLIVIA],
    )
    db.val(
        "select public.log_decision('clinical-doc-agent', 'job-1', %s, 'decision', 'decide_batch', "
        "'mock_decision', 'mock', '1', 'chest_pain_reported@1', '{}'::jsonb, %s, '{}'::jsonb, 0.9, 5)",
        [OLIVIA_APPROVED_APPT, "0" * 64],
    )
    db.val(
        "select public.log_agent_note('clinical-doc-agent', 'job', null, 'job-1', null, 'decision', 'n')"
    )
    db.val("select public.log_web_research('job-2', 'web_search', null, '{}', '{}', 0, 'pii')")
    assert access_id is not None
    err = db.savepoint_error(
        "insert into public.agent_access_log (agent_id, mode, server, tool, ok, latency_ms) "
        "values ('x', 'job', 's', 't', true, 1)"
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    for role in ("authenticated", "service_role", "anon"):
        db.as_role(role)
        err = db.savepoint_error(
            "select public.log_agent_note('x', 'job', null, null, null, 's', 'n')"
        )
        assert isinstance(err, psycopg.errors.InsufficientPrivilege), role


@pytest.mark.parametrize("table", LOG_TABLES)
@pytest.mark.parametrize("role", ["authenticated", "service_role", "mcp_server", "owner"])
def test_logs_cannot_be_updated_or_deleted(db: Db, table: str, role: str) -> None:
    db.as_role("mcp_server")
    db.val(
        "select public.log_agent_access('a', 'job', null, 'j', null, null, 's', 't', true, null, 1)"
    )
    db.val(
        "select public.log_decision('a', 'j', null, 's', 't', 'e', null, null, null, null, null, null, null, 1)"
    )
    db.val("select public.log_agent_note('a', 'job', null, 'j', null, 's', 'n')")
    db.val("select public.log_web_research('j', 'web_search', null, null, null, 0, null)")
    if role == "owner":
        db.as_admin()
    else:
        db.as_role(role)
    for sql in (
        f"update public.{table} set created_at = now()",
        f"delete from public.{table}",
        f"truncate public.{table}",
    ):
        err = db.savepoint_error(sql)
        assert isinstance(err, psycopg.errors.InsufficientPrivilege), (role, sql)


# ---------------------------------------------------------------------------
# Booking proposals (4.7)
# ---------------------------------------------------------------------------
def _free_slot(db: Db, clinician: str = DR_RAO, skip: int = 0) -> str:
    db.as_admin()
    return str(
        db.val(
            "select id from public.appointment_slots where clinician_id = %s and status = 'available' "
            "and starts_at > now() + interval '1 day' order by starts_at offset %s limit 1",
            [clinician, skip],
        )
    )


def test_proposal_does_not_book_and_only_owner_confirms(db: Db) -> None:
    slot = _free_slot(db)
    before = db.val("select count(*) from public.appointments")
    db.as_user("olivia")
    proposal = db.val(
        "insert into public.booking_proposals (patient_id, kind, slot_id, reason, created_by_agent) "
        "values (%s, 'book', %s, 'Check-up', 'patient-assistant') returning id",
        [OLIVIA, slot],
    )
    db.as_admin()
    assert db.val("select count(*) from public.appointments") == before
    assert (
        db.val("select status from public.appointment_slots where id = %s", [slot]) == "available"
    )

    db.as_user("jack")
    err = db.savepoint_error("select public.confirm_booking_proposal(%s)", [proposal])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_role("service_role")
    err = db.savepoint_error("select public.confirm_booking_proposal(%s)", [proposal])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_user("olivia")
    appt = db.val("select public.confirm_booking_proposal(%s)", [proposal])
    db.as_admin()
    row = db.one(
        "select status, result_appointment_id from public.booking_proposals where id = %s",
        [proposal],
    )
    assert row == {"status": "confirmed", "result_appointment_id": appt}
    assert str(db.val("select patient_id from public.appointments where id = %s", [appt])) == OLIVIA


def test_patient_cannot_propose_for_someone_else(db: Db) -> None:
    slot = _free_slot(db)
    db.as_user("olivia")
    err = db.savepoint_error(
        "insert into public.booking_proposals (patient_id, kind, slot_id) values (%s, 'book', %s)",
        [JACK, slot],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)
    db.as_admin()
    jacks_appt = db.val("select id from public.appointments where patient_id = %s limit 1", [JACK])
    db.as_user("olivia")
    err = db.savepoint_error(
        "insert into public.booking_proposals (patient_id, kind, appointment_id) values (%s, 'cancel', %s)",
        [OLIVIA, jacks_appt],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)


def test_expired_proposal_cannot_be_confirmed(db: Db) -> None:
    slot = _free_slot(db)
    db.as_user("olivia")
    proposal = db.val(
        "insert into public.booking_proposals (patient_id, kind, slot_id) values (%s, 'book', %s) returning id",
        [OLIVIA, slot],
    )
    db.as_admin()
    db.q(
        "update public.booking_proposals set expires_at = now() - interval '1 minute' where id = %s",
        [proposal],
    )
    db.as_user("olivia")
    err = db.savepoint_error("select public.confirm_booking_proposal(%s)", [proposal])
    assert "expired" in str(err)


# ---------------------------------------------------------------------------
# find_gp_candidates (4.8)
# ---------------------------------------------------------------------------
def _candidates(db: Db, who: str, **kw: object) -> list[dict[str, object]]:
    db.as_user(who)
    args = {
        "p_date_from": date.today(),
        "p_date_to": date.today() + timedelta(days=21),
        "p_lat": None,
        "p_lng": None,
        "p_max_km": None,
        "p_languages": None,
        "p_sex": None,
        "p_telehealth": None,
    }
    args.update(kw)
    return db.q(
        """select * from public.find_gp_candidates(
             %(p_date_from)s::date, %(p_date_to)s::date, %(p_lat)s::numeric, %(p_lng)s::numeric,
             %(p_max_km)s::numeric, 'gp'::public.clinician_type, %(p_languages)s::text[],
             %(p_sex)s::text, %(p_telehealth)s::boolean)""",
        args,
    )


def test_find_gp_candidates_hard_filters(db: Db) -> None:
    everyone = _candidates(db, "olivia")
    ids = {str(r["clinician_id"]) for r in everyone}
    assert DR_RAO in ids and DR_NGUYEN in ids
    assert DR_WILLIAMS not in ids  # not accepting new patients; Olivia has never seen her
    assert all(r["next_slot_id"] is not None for r in everyone)
    assert "40000000-0000-4000-8000-000000000004" not in ids  # specialist, not a GP

    vietnamese = {str(r["clinician_id"]) for r in _candidates(db, "olivia", p_languages=["vi"])}
    assert vietnamese == {DR_NGUYEN}

    female = {str(r["clinician_id"]) for r in _candidates(db, "olivia", p_sex="female")}
    assert DR_NGUYEN not in female and DR_RAO in female

    near = _candidates(db, "olivia", p_lat=SOUTHBANK_LAT, p_lng=SOUTHBANK_LNG, p_max_km=5)
    assert near and all(r["distance_km"] is not None and r["distance_km"] <= 5 for r in near)
    assert "30000000-0000-4000-8000-000000000004" not in {str(r["facility_id"]) for r in near}

    # Existing patients can still see a GP who is closed to new patients.
    priya = {str(r["clinician_id"]) for r in _candidates(db, "priya")}
    assert DR_WILLIAMS in priya or not _has_williams_slots(db)


def _has_williams_slots(db: Db) -> bool:
    db.as_admin()
    return bool(
        db.val(
            "select count(*) from public.appointment_slots where clinician_id = %s "
            "and status = 'available' and starts_at > now() "
            "and starts_at < now() + interval '21 days'",
            [DR_WILLIAMS],
        )
    )


def test_find_gp_candidates_rejects_long_ranges(db: Db) -> None:
    db.as_user("olivia")
    err = db.savepoint_error(
        "select * from public.find_gp_candidates(current_date, current_date + 60)"
    )
    assert "31 days" in str(err)


# ---------------------------------------------------------------------------
# estimate_fees (4.8): residency and policy in force on the date
# ---------------------------------------------------------------------------
def _fees(
    db: Db, who: str, patient: str, facility: str, clinician: str, on: date
) -> dict[str, object]:
    db.as_user(who)
    return db.one(
        "select * from public.estimate_fees(%s, %s, %s, 'standard', %s)",
        [patient, facility, clinician, on],
    )


def test_estimate_fees_medicare_patient_with_hospital_cover(db: Db) -> None:
    rao = _fees(db, "olivia", OLIVIA, SOUTHBANK, DR_RAO, date.today())
    assert rao["fee"] == Decimal("90.00")  # Dr Rao's own fee overrides the clinic fee
    assert rao["medicare_eligible"] is True and rao["medicare_rebate"] == Decimal("43.90")
    assert rao["insurance_benefit"] == 0 and rao["gap"] == Decimal("46.10")
    assert rao["is_estimate"] is True

    nguyen = _fees(db, "olivia", OLIVIA, SOUTHBANK, DR_NGUYEN, date.today())
    assert nguyen["fee"] == Decimal("85.00")

    # Before Southbank stopped bulk billing.
    old = _fees(db, "olivia", OLIVIA, SOUTHBANK, DR_NGUYEN, date.today() - timedelta(days=200))
    assert old["fee"] == Decimal("43.90") and old["gap"] == 0


def test_estimate_fees_uses_residency_and_policy_on_the_date(db: Db) -> None:
    today = _fees(db, "priya", PRIYA, PADDINGTON, DR_WILLIAMS, date.today())
    assert today["medicare_eligible"] is False and today["medicare_rebate"] == 0
    assert today["insurance_benefit"] == Decimal("37.32")  # visitor cover: 85% of 43.90
    assert today["gap"] == Decimal("57.68")

    student = _fees(db, "priya", PRIYA, PADDINGTON, DR_WILLIAMS, date.today() - timedelta(days=150))
    assert student["medicare_eligible"] is False
    assert student["insurance_benefit"] == Decimal("43.90")  # OSHC: 100% of the MBS fee
    assert student["gap"] == Decimal("51.10")
    assert student["plan_id"] != today["plan_id"]


def test_estimate_fees_only_for_yourself(db: Db) -> None:
    db.as_user("olivia")
    err = db.savepoint_error(
        "select * from public.estimate_fees(%s, %s, %s, 'standard', current_date)",
        [PRIYA, PADDINGTON, DR_WILLIAMS],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)


def test_drafts_plan_versions_hidden_and_only_staff_verify(db: Db) -> None:
    db.as_user("olivia")
    assert db.val("select count(*) from public.insurance_plan_versions where status = 'draft'") == 0
    draft = "82000000-0000-4000-8000-000000000007"
    err = db.savepoint_error("select public.verify_plan_version(%s)", [draft])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_role("service_role")
    err = db.savepoint_error(
        "insert into public.insurance_plan_versions (plan_id, valid_from, source, status, verified_at) "
        "values ('21000000-0000-4000-8000-000000000002', current_date, 'insurer_site', 'verified', now())"
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_user("staff")
    db.q("select public.verify_plan_version(%s)", [draft])
    db.as_admin()
    old = db.one(
        "select valid_to from public.insurance_plan_versions "
        "where id = '82000000-0000-4000-8000-000000000001'"
    )
    assert old["valid_to"] == date.today()


# ---------------------------------------------------------------------------
# Registries (4.3)
# ---------------------------------------------------------------------------
def test_question_option_rules(db: Db) -> None:
    err = db.savepoint_error(
        "insert into public.decision_questions (id, version, kind, text, options, threshold) "
        "values ('bad_choice', 1, 'choice', 'q', '[{\"value\":\"a\"},{\"value\":\"b\"}]', 0.5)"
    )
    assert isinstance(err, psycopg.errors.CheckViolation)
    err = db.savepoint_error(
        "insert into public.decision_questions (id, version, kind, text, options, threshold) "
        "values ('bad_yes_no', 1, 'yes_no', 'q', '[{\"value\":\"yes\"},{\"value\":\"no\"}]', 0.5)"
    )
    assert isinstance(err, psycopg.errors.CheckViolation)
    err = db.savepoint_error(
        "insert into public.decision_questions (id, version, kind, text, options, threshold) "
        "values ('bad_score', 1, 'score', 'q', '[{\"value\":\"a\",\"level\":0},"
        '{"value":"b","level":1,"description":"B"}]\', 0.5)'
    )
    assert isinstance(err, psycopg.errors.CheckViolation)


def test_only_one_enabled_engine_per_capability(db: Db) -> None:
    err = db.savepoint_error("update public.model_registry set enabled = true where engine = 'jev'")
    assert isinstance(err, psycopg.errors.UniqueViolation)


def test_mentions_patient_name(db: Db) -> None:
    db.as_role("mcp_server")
    assert (
        db.val("select public.text_mentions_patient_name('gp near olivia brown west end')") is True
    )
    assert db.val("select public.text_mentions_patient_name('LIV BROWN')") is True
    assert db.val("select public.text_mentions_patient_name('brown rice recipes')") is False
