"""SQL behaviour of 20261028000000_consult_key_points.sql (queue, key points, RLS)."""

from __future__ import annotations

import psycopg
import pytest

from .conftest import (
    LUKAS_APPT,
    LUKAS_PENDING_TRANSCRIPT,
    OLIVIA_APPROVED_APPT,
    OLIVIA_APPROVED_TRANSCRIPT,
    Db,
)

pytestmark = pytest.mark.integration


def _segment_ids(db: Db, appointment_id: str) -> list[str]:
    db.as_admin()
    return [
        str(r["id"])
        for r in db.q(
            "select id from public.transcript_segments where appointment_id = %s order by seq",
            [appointment_id],
        )
    ]


def _insert_key_point(db: Db, key: str, question_id: str = "fatigue_reported") -> str:
    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    return str(
        db.val(
            """insert into public.consult_key_points
                 (transcript_id, appointment_id, question_id, question_version, kind, answer,
                  probability, threshold, meets_threshold, source_segment_ids, engine,
                  model_version, idempotency_key, created_by_agent)
               values (%s, %s, %s, 1, 'yes_no', 'yes', 0.9, 0.7, true, %s::uuid[],
                       'mock_decision', '1', %s, 'consult-notes')
               returning id""",
            [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, question_id, segs[1:2], key],
        )
    )


def _reset_olivia_run(db: Db) -> None:
    db.as_admin()
    db.q(
        "update public.consult_note_runs set status = 'queued', attempts = 0, "
        "started_at = null, finished_at = null where transcript_id = %s",
        [OLIVIA_APPROVED_TRANSCRIPT],
    )


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------
def test_approving_a_transcript_queues_one_run(db: Db) -> None:
    db.as_admin()
    assert (
        db.val(
            "select count(*) from public.consult_note_runs where transcript_id = %s",
            [LUKAS_PENDING_TRANSCRIPT],
        )
        == 0
    )
    db.as_user("lukas")
    db.q("select public.approve_transcript(%s)", [LUKAS_PENDING_TRANSCRIPT])
    db.as_admin()
    run = db.one(
        "select status, attempts, appointment_id::text from public.consult_note_runs "
        "where transcript_id = %s",
        [LUKAS_PENDING_TRANSCRIPT],
    )
    assert run == {"status": "queued", "attempts": 0, "appointment_id": LUKAS_APPT}


def test_already_approved_transcripts_were_backfilled(db: Db) -> None:
    db.as_admin()
    assert (
        db.val(
            "select count(*) from public.consult_note_runs where transcript_id = %s",
            [OLIVIA_APPROVED_TRANSCRIPT],
        )
        == 1
    )


def test_claim_complete_and_attempt_limit(db: Db) -> None:
    _reset_olivia_run(db)
    db.as_role("service_role")
    run = db.one(
        "select id::text, status, attempts from public.claim_consult_note_run(3, %s)",
        [OLIVIA_APPROVED_APPT],
    )
    assert (run["status"], run["attempts"]) == ("running", 1)
    # A running run is not claimed twice.
    assert db.q("select * from public.claim_consult_note_run(3, %s)", [OLIVIA_APPROVED_APPT]) == []

    # Wrong appointment: the worker cannot complete another appointment's run.
    assert (
        db.val("select public.complete_consult_note_run(%s, %s, 1, 1, 0)", [run["id"], LUKAS_APPT])
        is False
    )
    assert (
        db.val(
            "select public.complete_consult_note_run(%s, %s, 2, 3, 1)",
            [run["id"], OLIVIA_APPROVED_APPT],
        )
        is True
    )
    db.as_admin()
    done = db.one(
        "select status, facts_count, key_points_count, open_items_count "
        "from public.consult_note_runs where id = %s",
        [run["id"]],
    )
    assert done == {
        "status": "done",
        "facts_count": 2,
        "key_points_count": 3,
        "open_items_count": 1,
    }

    # Failed runs are retried later, but never past the attempt limit.
    db.q(
        "update public.consult_note_runs set status = 'failed', attempts = 3, "
        "finished_at = now() - interval '1 hour' where id = %s",
        [run["id"]],
    )
    db.as_role("service_role")
    assert db.q("select * from public.claim_consult_note_run(3, %s)", [OLIVIA_APPROVED_APPT]) == []
    assert db.val("select public.requeue_consult_note_run(%s)", [OLIVIA_APPROVED_APPT]) == 1
    again = db.one(
        "select attempts from public.claim_consult_note_run(3, %s)", [OLIVIA_APPROVED_APPT]
    )
    assert again["attempts"] == 1


def test_fail_stores_an_error_code_only(db: Db) -> None:
    _reset_olivia_run(db)
    db.as_role("service_role")
    run_id = db.val("select id from public.claim_consult_note_run(3, %s)", [OLIVIA_APPROVED_APPT])
    db.q(
        "select public.fail_consult_note_run(%s, %s, %s)",
        [run_id, OLIVIA_APPROVED_APPT, "Patient said: chest pain"],
    )
    db.as_admin()
    assert (
        db.val("select last_error from public.consult_note_runs where id = %s", [run_id])
        == "internal_error"
    )


def test_app_users_cannot_drive_the_queue(db: Db) -> None:
    db.as_user("olivia")
    for sql in (
        "select * from public.claim_consult_note_run(3, null)",
        f"select public.requeue_consult_note_run('{OLIVIA_APPROVED_APPT}')",
    ):
        err = db.savepoint_error(sql)
        assert isinstance(err, psycopg.errors.InsufficientPrivilege)
    err = db.savepoint_error(
        "update public.consult_note_runs set status = 'done' where appointment_id = %s",
        [OLIVIA_APPROVED_APPT],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)


def test_run_status_visible_to_participants_only(db: Db) -> None:
    sql = "select count(*) from public.consult_note_runs where appointment_id = %s"
    for who, expected in (("olivia", 1), ("rao", 1), ("jack", 0), ("williams", 0)):
        db.as_user(who)
        assert db.val(sql, [OLIVIA_APPROVED_APPT]) == expected, who


# ---------------------------------------------------------------------------
# Key points
# ---------------------------------------------------------------------------
def test_agents_insert_drafts_only(db: Db) -> None:
    kp = _insert_key_point(db, "test-kp-draft-0001")
    db.as_admin()
    row = db.one(
        "select status, patient_id::text from public.consult_key_points where id = %s", [kp]
    )
    assert row["status"] == "draft"
    assert row["patient_id"] == "50000000-0000-4000-8000-000000000001"

    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    err = db.savepoint_error(
        """insert into public.consult_key_points
             (transcript_id, appointment_id, question_id, question_version, kind, answer,
              probability, threshold, meets_threshold, source_segment_ids, status,
              reviewed_by, reviewed_at, idempotency_key)
           values (%s, %s, 'fatigue_reported', 1, 'yes_no', 'yes', 0.9, 0.7, true,
                   %s::uuid[], 'approved', gen_random_uuid(), now(), 'test-kp-approved-0001')""",
        [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, segs[:1]],
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)
    err = db.savepoint_error(
        "update public.consult_key_points set status = 'approved' where id = %s", [kp]
    )
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)


def test_key_point_answers_are_option_values(db: Db) -> None:
    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    err = db.savepoint_error(
        """insert into public.consult_key_points
             (transcript_id, appointment_id, question_id, question_version, kind, answer,
              probability, threshold, meets_threshold, source_segment_ids, idempotency_key)
           values (%s, %s, 'fatigue_reported', 1, 'yes_no', 'the patient said yes', 0.9, 0.7,
                   true, %s::uuid[], 'test-kp-freetext-01')""",
        [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, segs[:1]],
    )
    assert isinstance(err, psycopg.errors.CheckViolation)


def test_key_point_visibility(db: Db) -> None:
    kp = _insert_key_point(db, "test-kp-visible-0001")
    sql = "select count(*) from public.consult_key_points where id = %s"
    for who, expected in (("rao", 1), ("staff", 1), ("olivia", 0), ("williams", 0), ("jack", 0)):
        db.as_user(who)
        assert db.val(sql, [kp]) == expected, who

    db.as_user("rao")
    db.q("select public.approve_key_point(%s)", [kp])
    db.as_user("olivia")
    assert db.val(sql, [kp]) == 1  # the patient sees approved key points


def test_review_permissions(db: Db) -> None:
    kp = _insert_key_point(db, "test-kp-review-0001")
    for who in ("olivia", "williams"):
        db.as_user(who)
        err = db.savepoint_error("select public.approve_key_point(%s)", [kp])
        assert isinstance(err, psycopg.errors.InsufficientPrivilege), who

    db.as_role("service_role")
    err = db.savepoint_error("select public.approve_key_point(%s)", [kp])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_user("rao")
    err = db.savepoint_error("select public.edit_and_approve_key_point(%s, 'maybe')", [kp])
    assert isinstance(err, psycopg.errors.RaiseException)
    db.q("select public.edit_and_approve_key_point(%s, 'no')", [kp])
    db.as_admin()
    row = db.one(
        "select status, answer, answer_edited, reviewed_by is not null as reviewed "
        "from public.consult_key_points where id = %s",
        [kp],
    )
    assert row == {"status": "approved", "answer": "no", "answer_edited": True, "reviewed": True}

    other = _insert_key_point(db, "test-kp-review-0002", "medication_started")
    db.as_user("rao")
    db.q("select public.reject_key_point(%s)", [other])
    err = db.savepoint_error("select public.approve_key_point(%s)", [other])
    assert isinstance(err, psycopg.errors.RaiseException)


def test_consent_withdrawal_removes_drafts_and_unlinks_approved(db: Db) -> None:
    draft = _insert_key_point(db, "test-kp-cascade-0001")
    approved = _insert_key_point(db, "test-kp-cascade-0002", "medication_started")
    db.as_user("rao")
    db.q("select public.approve_key_point(%s)", [approved])

    db.as_user("olivia")
    db.q("select public.withdraw_recording_consent(%s, 'test')", [OLIVIA_APPROVED_APPT])

    db.as_admin()
    assert db.val("select count(*) from public.consult_key_points where id = %s", [draft]) == 0
    row = db.one(
        "select transcript_id, source_segment_ids, source_removed_at is not null as removed "
        "from public.consult_key_points where id = %s",
        [approved],
    )
    assert row == {"transcript_id": None, "source_segment_ids": [], "removed": True}
    assert (
        db.val(
            "select count(*) from public.consult_note_runs where transcript_id = %s",
            [OLIVIA_APPROVED_TRANSCRIPT],
        )
        == 0
    )


# ---------------------------------------------------------------------------
# 20261028010000: second opinions and explain questions
# ---------------------------------------------------------------------------
def _explain_question(db: Db, qid: str = "test_plan_summary") -> str:
    db.as_admin()
    db.q(
        "insert into public.decision_questions (id, version, kind, text, options, threshold) "
        "values (%s, 1, 'explain', 'What plan was agreed?', '[]', 0.7)",
        [qid],
    )
    return qid


def _insert_explain_point(
    db: Db, key: str, text: str | None = "Iron daily; bloods in 3 months."
) -> str:
    qid = _explain_question(db)
    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    return str(
        db.val(
            """insert into public.consult_key_points
                 (transcript_id, appointment_id, question_id, question_version, kind, answer,
                  answer_text, probability, threshold, meets_threshold, source_segment_ids,
                  engine, model_version, answer_source, idempotency_key, created_by_agent)
               values (%s, %s, %s, 1, 'explain', 'answered', %s, 0.8, 0.7, false, %s::uuid[],
                       'slm', '1', 'slm', %s, 'consult-notes')
               returning id""",
            [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, qid, text, segs[:1], key],
        )
    )


def test_explain_questions_have_no_options(db: Db) -> None:
    db.as_admin()
    err = db.savepoint_error(
        "insert into public.decision_questions (id, version, kind, text, options, threshold) "
        """values ('test_bad_explain', 1, 'explain', '?', '[{"value":"yes"}]', 0.7)"""
    )
    assert isinstance(err, psycopg.errors.CheckViolation)
    assert _explain_question(db) == "test_plan_summary"


def test_answer_text_only_on_answered_explain_points(db: Db) -> None:
    kp = _insert_explain_point(db, "test-kp-explain-0001")
    db.as_admin()
    assert db.val("select answer_text from public.consult_key_points where id = %s", [kp])

    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    err = db.savepoint_error(
        """insert into public.consult_key_points
             (transcript_id, appointment_id, question_id, question_version, kind, answer,
              probability, threshold, meets_threshold, source_segment_ids, idempotency_key)
           values (%s, %s, 'test_plan_summary', 1, 'explain', 'answered', 0.8, 0.7, false,
                   %s::uuid[], 'test-kp-explain-0002')""",
        [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, segs[:1]],
    )
    assert isinstance(err, psycopg.errors.CheckViolation)  # answered without text
    err = db.savepoint_error(
        """insert into public.consult_key_points
             (transcript_id, appointment_id, question_id, question_version, kind, answer,
              answer_text, probability, threshold, meets_threshold, source_segment_ids,
              idempotency_key)
           values (%s, %s, 'fatigue_reported', 1, 'yes_no', 'yes', 'because', 0.9, 0.7, true,
                   %s::uuid[], 'test-kp-explain-0003')""",
        [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, segs[:1]],
    )
    assert isinstance(err, psycopg.errors.CheckViolation)  # text on a yes/no answer


def test_other_opinion_is_all_or_nothing(db: Db) -> None:
    segs = _segment_ids(db, OLIVIA_APPROVED_APPT)
    db.as_role("service_role")
    err = db.savepoint_error(
        """insert into public.consult_key_points
             (transcript_id, appointment_id, question_id, question_version, kind, answer,
              probability, threshold, meets_threshold, source_segment_ids,
              other_opinion_answer, idempotency_key)
           values (%s, %s, 'fatigue_reported', 1, 'yes_no', 'yes', 0.9, 0.7, false,
                   %s::uuid[], 'no', 'test-kp-opinion-0001')""",
        [OLIVIA_APPROVED_TRANSCRIPT, OLIVIA_APPROVED_APPT, segs[:1]],
    )
    assert isinstance(err, psycopg.errors.CheckViolation)


def test_edit_and_approve_key_point_text(db: Db) -> None:
    kp = _insert_explain_point(db, "test-kp-explain-0010")
    for who in ("olivia", "williams"):
        db.as_user(who)
        err = db.savepoint_error("select public.edit_and_approve_key_point_text(%s, 'x')", [kp])
        assert isinstance(err, psycopg.errors.InsufficientPrivilege), who
    db.as_role("service_role")
    err = db.savepoint_error("select public.edit_and_approve_key_point_text(%s, 'x')", [kp])
    assert isinstance(err, psycopg.errors.InsufficientPrivilege)

    db.as_user("rao")
    # Explain points have no option values, and other kinds take no text.
    err = db.savepoint_error("select public.edit_and_approve_key_point(%s, 'yes')", [kp])
    assert isinstance(err, psycopg.errors.RaiseException)
    yes_no = _insert_key_point(db, "test-kp-explain-0011")
    db.as_user("rao")
    err = db.savepoint_error("select public.edit_and_approve_key_point_text(%s, 'x')", [yes_no])
    assert isinstance(err, psycopg.errors.RaiseException)

    db.q("select public.edit_and_approve_key_point_text(%s, '  Iron daily.  ')", [kp])
    db.as_admin()
    row = db.one(
        "select status, answer, answer_text, answer_edited from public.consult_key_points "
        "where id = %s",
        [kp],
    )
    assert row == {
        "status": "approved",
        "answer": "answered",
        "answer_text": "Iron daily.",
        "answer_edited": True,
    }
