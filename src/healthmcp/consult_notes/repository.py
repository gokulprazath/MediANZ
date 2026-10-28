"""Database access for the consult-notes worker.

Everything runs in job mode through `Database.job_tx`, so every
patient query is pinned to the appointment of the claimed run by
%(scope_appointment_id)s. Only the queue claim and the registries are
`reference=True` (they return ids or registry rows, not patient data).
"""

from __future__ import annotations

import json
from typing import Any, Protocol
from uuid import UUID

from psycopg.types.json import Jsonb

from healthmcp.consult_notes.models import ClaimedRun, Eligibility, NoteResults, SavedCounts
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database
from healthmcp.shared.engines.models import ClinicalField, Segment, TypedQuestion


class ConsultNotesRepository(Protocol):
    async def claim_run(
        self, ctx: Context, *, max_attempts: int, appointment_id: UUID | None = None
    ) -> ClaimedRun | None: ...

    async def requeue(self, ctx: Context) -> int: ...

    async def eligibility(self, ctx: Context) -> Eligibility: ...

    async def segments(self, ctx: Context, transcript_id: UUID) -> list[Segment]: ...

    async def active_fields(self, ctx: Context) -> list[ClinicalField]: ...

    async def active_questions(self, ctx: Context) -> list[TypedQuestion]: ...

    async def finish(
        self, ctx: Context, run_id: UUID, results: NoteResults, *, agent_id: str
    ) -> SavedCounts: ...

    async def fail_run(self, ctx: Context, run_id: UUID, error_code: str) -> None: ...


_INSERT_FACT = """
insert into public.clinical_facts
  (appointment_id, field_id, field_version, value, unit, code_system, source,
   source_segment_ids, quote_hash, char_start, char_end, confidence, engine, model_version,
   idempotency_key, created_by_agent)
values
  (%(scope_appointment_id)s, %(field_id)s, %(field_version)s, %(value)s, %(unit)s,
   %(code_system)s, 'transcript', %(segment_ids)s::uuid[], %(quote_hash)s, %(char_start)s,
   %(char_end)s, %(confidence)s, %(engine)s, %(model_version)s, %(key)s, %(agent)s)
on conflict (idempotency_key) do nothing
"""

_INSERT_KEY_POINT = """
insert into public.consult_key_points
  (transcript_id, appointment_id, question_id, question_version, kind, answer, answer_label,
   answer_text, level, probability, threshold, meets_threshold, source_segment_ids, engine,
   model_version, answer_source, other_opinion_answer, other_opinion_probability,
   other_opinion_engine, idempotency_key, created_by_agent)
values
  (%(transcript_id)s, %(scope_appointment_id)s, %(question_id)s, %(question_version)s,
   %(kind)s, %(answer)s, %(answer_label)s, %(answer_text)s, %(level)s, %(probability)s,
   %(threshold)s, %(meets_threshold)s, %(segment_ids)s::uuid[], %(engine)s, %(model_version)s,
   %(answer_source)s, %(other_answer)s, %(other_probability)s, %(other_engine)s, %(key)s,
   %(agent)s)
on conflict (idempotency_key) do nothing
"""

_INSERT_OPEN_ITEM = """
insert into public.open_items
  (appointment_id, kind, severity, description, idempotency_key, created_by_agent)
values
  (%(scope_appointment_id)s, %(kind)s, %(severity)s, %(description)s, %(key)s, %(agent)s)
on conflict (idempotency_key) do nothing
"""


def _options(raw: Any) -> Any:
    return json.loads(raw) if isinstance(raw, str) else raw


class PgConsultNotesRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def claim_run(
        self, ctx: Context, *, max_attempts: int, appointment_id: UUID | None = None
    ) -> ClaimedRun | None:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select id, transcript_id, appointment_id, attempts "
                "from public.claim_consult_note_run(%(max_attempts)s::integer, "
                "%(appointment_id)s::uuid)",
                {"max_attempts": max_attempts, "appointment_id": appointment_id},
                reference=True,
            )
        if row is None:
            return None
        return ClaimedRun(
            id=row["id"],
            transcript_id=row["transcript_id"],
            appointment_id=row["appointment_id"],
            attempts=int(row["attempts"]),
        )

    async def requeue(self, ctx: Context) -> int:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select public.requeue_consult_note_run(%(scope_appointment_id)s) as n"
            )
        return int(row["n"]) if row else 0

    async def eligibility(self, ctx: Context) -> Eligibility:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select eligible, reasons "
                "from public.get_processing_eligibility(%(scope_appointment_id)s)"
            )
        if row is None:
            return Eligibility(False, ("appointment_not_found",))
        return Eligibility(bool(row["eligible"]), tuple(row["reasons"] or ()))

    async def segments(self, ctx: Context, transcript_id: UUID) -> list[Segment]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select id, seq, speaker, speaker_confidence, start_sec, end_sec, text "
                "from public.transcript_segments "
                "where appointment_id = %(scope_appointment_id)s "
                "and transcript_id = %(transcript_id)s order by seq",
                {"transcript_id": transcript_id},
            )
        return [Segment.model_validate(r) for r in rows]

    async def active_fields(self, ctx: Context) -> list[ClinicalField]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select id, version, label, value_schema, unit, code_system, topic "
                "from public.clinical_fields where active order by id",
                reference=True,
            )
        return [ClinicalField.model_validate(r) for r in rows]

    async def active_questions(self, ctx: Context) -> list[TypedQuestion]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select id, version, kind, text, options, threshold "
                "from public.decision_questions where active order by id",
                reference=True,
            )
        return [
            TypedQuestion.model_validate(
                {**r, "options": _options(r["options"]), "threshold": float(r["threshold"])}
            )
            for r in rows
        ]

    async def finish(
        self, ctx: Context, run_id: UUID, results: NoteResults, *, agent_id: str
    ) -> SavedCounts:
        """Insert everything and mark the run done, in one transaction."""
        async with self._db.job_tx(ctx) as sc:
            facts = 0
            for f in results.facts:
                facts += await sc.execute(
                    _INSERT_FACT,
                    {
                        "field_id": f.field_id,
                        "field_version": f.field_version,
                        "value": Jsonb(f.value),
                        "unit": f.unit,
                        "code_system": f.code_system,
                        "segment_ids": list(f.segment_ids),
                        "quote_hash": f.quote_hash,
                        "char_start": f.char_start,
                        "char_end": f.char_end,
                        "confidence": round(f.confidence, 3),
                        "engine": f.engine,
                        "model_version": f.model_version,
                        "key": f.idempotency_key,
                        "agent": agent_id,
                    },
                )
            key_points = 0
            for k in results.key_points:
                other = k.other_opinion
                key_points += await sc.execute(
                    _INSERT_KEY_POINT,
                    {
                        "transcript_id": k.transcript_id,
                        "question_id": k.question_id,
                        "question_version": k.question_version,
                        "kind": k.kind,
                        "answer": k.answer,
                        "answer_label": k.answer_label,
                        "answer_text": k.answer_text,
                        "level": k.level,
                        "probability": round(k.probability, 3),
                        "threshold": round(k.threshold, 3),
                        "meets_threshold": k.meets_threshold,
                        "segment_ids": list(k.segment_ids),
                        "engine": k.engine,
                        "model_version": k.model_version,
                        "answer_source": k.answer_source,
                        "other_answer": other.answer if other else None,
                        "other_probability": round(other.probability, 3) if other else None,
                        "other_engine": other.engine if other else None,
                        "key": k.idempotency_key,
                        "agent": agent_id,
                    },
                )
            open_items = 0
            for o in results.open_items:
                open_items += await sc.execute(
                    _INSERT_OPEN_ITEM,
                    {
                        "kind": o.kind,
                        "severity": o.severity,
                        "description": o.description,
                        "key": o.idempotency_key,
                        "agent": agent_id,
                    },
                )
            await sc.execute(
                "select public.complete_consult_note_run(%(run_id)s::uuid, "
                "%(scope_appointment_id)s, %(facts)s::integer, %(key_points)s::integer, "
                "%(open_items)s::integer)",
                {
                    "run_id": run_id,
                    "facts": len(results.facts),
                    "key_points": len(results.key_points),
                    "open_items": len(results.open_items),
                },
            )
        return SavedCounts(facts=facts, key_points=key_points, open_items=open_items)

    async def fail_run(self, ctx: Context, run_id: UUID, error_code: str) -> None:
        async with self._db.job_tx(ctx) as sc:
            await sc.execute(
                "select public.fail_consult_note_run(%(run_id)s::uuid, "
                "%(scope_appointment_id)s, %(error_code)s)",
                {"run_id": run_id, "error_code": error_code},
            )
