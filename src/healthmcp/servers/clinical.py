"""Job-mode data for the clinical servers (transcript, decision, extraction).

Every patient query is pinned to the job token's appointment with
%(scope_appointment_id)s; registries (questions, fields) are reference data.
Transcript text is only ever read from an *approved* transcript, and it is
never written anywhere by these servers: facts store a quote hash only.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from healthmcp.consult_notes.models import Eligibility
from healthmcp.shared.context import Context, current_context
from healthmcp.shared.db import Database, ScopedConnection
from healthmcp.shared.engines.models import ClinicalField, Segment, TypedQuestion
from healthmcp.shared.errors import HealthMcpError, InvalidRequest, ScopeViolation
from healthmcp.shared.repositories.fake_data import DR_RAO, OLIVIA_APPROVED_APPOINTMENT

OpenItemKind = Literal["missing_info", "conflict", "urgent"]
Experiencer = Literal["patient", "family", "other"]
Temporality = Literal["current", "past", "future", "unknown"]


class NotEligible(HealthMcpError):
    code = "not_eligible"
    public_message = "The consult is not eligible for AI processing."


class IdempotencyKeyReused(HealthMcpError):
    code = "idempotency_key_reused"
    public_message = "That idempotency key was already used for a different record."


class NewFact(BaseModel):
    model_config = ConfigDict(frozen=True)

    field: ClinicalField
    value: Any
    unit: str | None
    segment_ids: tuple[UUID, ...]
    quote_hash: str
    char_start: int
    char_end: int
    confidence: float
    negated: bool
    experiencer: Experiencer
    temporality: Temporality
    idempotency_key: str


class SavedRow(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    created: bool  # False: an existing row was returned (retry or duplicate)


class OpenItemRow(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: UUID
    kind: OpenItemKind
    severity: int | None = None
    description: str
    status: Literal["open", "resolved"]
    related_fact_ids: tuple[UUID, ...] = ()
    created_at: datetime


class ClinicalRepository(Protocol):
    async def eligibility(self, ctx: Context) -> Eligibility: ...

    async def approved_segments(self, ctx: Context) -> tuple[UUID | None, list[Segment]]: ...

    async def segments_by_ids(self, ctx: Context, ids: Sequence[UUID]) -> list[Segment]: ...

    async def search_segments(self, ctx: Context, query: str, limit: int) -> list[Segment]: ...

    async def active_questions(self, ctx: Context) -> list[TypedQuestion]: ...

    async def field(self, ctx: Context, field_id: str) -> ClinicalField | None: ...

    async def save_draft_fact(self, ctx: Context, fact: NewFact) -> SavedRow: ...

    async def fact_ids(self, ctx: Context, ids: Sequence[UUID]) -> list[UUID]: ...

    async def save_open_item(
        self,
        ctx: Context,
        *,
        kind: OpenItemKind,
        severity: int | None,
        description: str,
        related_fact_ids: Sequence[UUID],
        idempotency_key: str,
    ) -> SavedRow: ...

    async def open_items(self, ctx: Context, status: str | None) -> list[OpenItemRow]: ...

    async def save_gp_query(
        self,
        ctx: Context,
        *,
        question: str,
        context_fact_ids: Sequence[UUID],
        idempotency_key: str,
    ) -> SavedRow: ...

    async def clinician_preferences(self, ctx: Context) -> dict[str, Any]: ...


def _options(raw: Any) -> Any:
    return json.loads(raw) if isinstance(raw, str) else raw


def _like(query: str) -> str:
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


_SEGMENTS = """
select s.id, s.seq, s.speaker, s.speaker_confidence, s.start_sec, s.end_sec, s.text,
       s.transcript_id
  from public.transcript_segments s
  join public.consult_transcripts t on t.id = s.transcript_id
 where s.appointment_id = %(scope_appointment_id)s
   and t.appointment_id = %(scope_appointment_id)s
   and t.status = 'approved'
"""

_INSERT_FACT = """
insert into public.clinical_facts
  (appointment_id, field_id, field_version, value, unit, code_system, source,
   source_segment_ids, quote_hash, char_start, char_end, confidence, negated, experiencer,
   temporality, idempotency_key, created_by_agent)
values
  (%(scope_appointment_id)s, %(field_id)s, %(field_version)s, %(value)s::jsonb, %(unit)s,
   %(code_system)s, 'transcript', %(segment_ids)s::uuid[], %(quote_hash)s, %(char_start)s,
   %(char_end)s, %(confidence)s, %(negated)s, %(experiencer)s, %(temporality)s, %(key)s,
   %(agent)s)
on conflict (idempotency_key) do nothing
returning id
"""

_DUPLICATE_FACT = """
select id from public.clinical_facts
 where appointment_id = %(scope_appointment_id)s
   and field_id = %(field_id)s
   and status = 'draft'
   and value = %(value)s::jsonb
   and source_segment_ids && %(segment_ids)s::uuid[]
 order by created_at
 limit 1
"""

_INSERT_OPEN_ITEM = """
insert into public.open_items
  (appointment_id, kind, severity, description, related_fact_ids, idempotency_key,
   created_by_agent)
values
  (%(scope_appointment_id)s, %(kind)s, %(severity)s, %(description)s,
   %(related)s::uuid[], %(key)s, %(agent)s)
on conflict (idempotency_key) do nothing
returning id
"""

_INSERT_GP_QUERY = """
insert into public.gp_queries
  (appointment_id, question, context_fact_ids, idempotency_key, created_by_agent)
values
  (%(scope_appointment_id)s, %(question)s, %(facts)s::uuid[], %(key)s, %(agent)s)
on conflict (idempotency_key) do nothing
returning id
"""


class PgClinicalRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def eligibility(self, ctx: Context) -> Eligibility:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select eligible, reasons "
                "from public.get_processing_eligibility(%(scope_appointment_id)s)"
            )
        if row is None:
            return Eligibility(False, ("appointment_not_found",))
        return Eligibility(bool(row["eligible"]), tuple(row["reasons"] or ()))

    async def approved_segments(self, ctx: Context) -> tuple[UUID | None, list[Segment]]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(_SEGMENTS + " order by s.seq")
        if not rows:
            return None, []
        return rows[0]["transcript_id"], [Segment.model_validate(r) for r in rows]

    async def segments_by_ids(self, ctx: Context, ids: Sequence[UUID]) -> list[Segment]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                _SEGMENTS + " and s.id = any(%(ids)s::uuid[]) order by s.seq", {"ids": list(ids)}
            )
        return [Segment.model_validate(r) for r in rows]

    async def search_segments(self, ctx: Context, query: str, limit: int) -> list[Segment]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                _SEGMENTS + " and s.text ilike %(pattern)s escape '\\' "
                "order by s.seq limit %(limit)s",
                {"pattern": _like(query), "limit": limit},
            )
        return [Segment.model_validate(r) for r in rows]

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

    async def field(self, ctx: Context, field_id: str) -> ClinicalField | None:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select id, version, label, value_schema, unit, code_system, topic "
                "from public.clinical_fields where active and id = %(id)s",
                {"id": field_id},
                reference=True,
            )
        return ClinicalField.model_validate(row) if row else None

    async def save_draft_fact(self, ctx: Context, fact: NewFact) -> SavedRow:
        value = json.dumps(fact.value, separators=(",", ":"), sort_keys=True)
        async with self._db.job_tx(ctx) as sc:
            existing = await _by_key(sc, "clinical_facts", fact.idempotency_key)
            if existing is not None:
                return existing
            duplicate = await sc.fetch_one(
                _DUPLICATE_FACT,
                {
                    "field_id": fact.field.id,
                    "value": value,
                    "segment_ids": list(fact.segment_ids),
                },
            )
            if duplicate is not None:
                return SavedRow(id=duplicate["id"], created=False)
            row = await sc.fetch_one(
                _INSERT_FACT,
                {
                    "field_id": fact.field.id,
                    "field_version": fact.field.version,
                    "value": value,
                    "unit": fact.unit,
                    "code_system": fact.field.code_system,
                    "segment_ids": list(fact.segment_ids),
                    "quote_hash": fact.quote_hash,
                    "char_start": fact.char_start,
                    "char_end": fact.char_end,
                    "confidence": round(fact.confidence, 3),
                    "negated": fact.negated,
                    "experiencer": fact.experiencer,
                    "temporality": fact.temporality,
                    "key": fact.idempotency_key,
                    "agent": ctx.agent_id,
                },
            )
            if row is None:  # the key was taken by another appointment's row
                raise IdempotencyKeyReused()
        return SavedRow(id=row["id"], created=True)

    async def fact_ids(self, ctx: Context, ids: Sequence[UUID]) -> list[UUID]:
        """Which of these facts belong to the token's patient (via its appointment)."""
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select f.id from public.clinical_facts f "
                "join public.appointments a on a.id = %(scope_appointment_id)s "
                "where f.patient_id = a.patient_id and f.id = any(%(ids)s::uuid[])",
                {"ids": list(ids)},
            )
        return [r["id"] for r in rows]

    async def save_open_item(
        self,
        ctx: Context,
        *,
        kind: OpenItemKind,
        severity: int | None,
        description: str,
        related_fact_ids: Sequence[UUID],
        idempotency_key: str,
    ) -> SavedRow:
        async with self._db.job_tx(ctx) as sc:
            existing = await _by_key(sc, "open_items", idempotency_key)
            if existing is not None:
                return existing
            row = await sc.fetch_one(
                _INSERT_OPEN_ITEM,
                {
                    "kind": kind,
                    "severity": severity,
                    "description": description,
                    "related": list(related_fact_ids),
                    "key": idempotency_key,
                    "agent": ctx.agent_id,
                },
            )
            if row is None:
                raise IdempotencyKeyReused()
        return SavedRow(id=row["id"], created=True)

    async def open_items(self, ctx: Context, status: str | None) -> list[OpenItemRow]:
        async with self._db.job_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select id, kind, severity, description, status, related_fact_ids, created_at "
                "from public.open_items where appointment_id = %(scope_appointment_id)s "
                "and (%(status)s::text is null or status = %(status)s::text) "
                "order by created_at limit 200",
                {"status": status},
            )
        return [OpenItemRow.model_validate(r) for r in rows]

    async def save_gp_query(
        self,
        ctx: Context,
        *,
        question: str,
        context_fact_ids: Sequence[UUID],
        idempotency_key: str,
    ) -> SavedRow:
        async with self._db.job_tx(ctx) as sc:
            existing = await _by_key(sc, "gp_queries", idempotency_key)
            if existing is not None:
                return existing
            row = await sc.fetch_one(
                _INSERT_GP_QUERY,
                {
                    "question": question,
                    "facts": list(context_fact_ids),
                    "key": idempotency_key,
                    "agent": ctx.agent_id,
                },
            )
            if row is None:
                raise IdempotencyKeyReused()
        return SavedRow(id=row["id"], created=True)

    async def clinician_preferences(self, ctx: Context) -> dict[str, Any]:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select prefs from public.clinician_preferences "
                "where clinician_id = %(scope_clinician_id)s"
            )
        prefs = _options(row["prefs"]) if row else {}
        return dict(prefs or {})


_KEY_LOOKUP = {
    "clinical_facts": "select id from public.clinical_facts",
    "open_items": "select id from public.open_items",
    "gp_queries": "select id from public.gp_queries",
}


async def _by_key(sc: ScopedConnection, table: str, key: str) -> SavedRow | None:
    """The row already saved under this key for this appointment (a retry)."""
    row = await sc.fetch_one(
        _KEY_LOOKUP[table]
        + " where idempotency_key = %(key)s and appointment_id = %(scope_appointment_id)s",
        {"key": key},
    )
    return SavedRow(id=row["id"], created=False) if row else None


# ---------------------------------------------------------------------------
# Fake: Olivia's approved consult (60000000-...-0002), mirroring seed 04.
# ---------------------------------------------------------------------------
SAMPLE_TRANSCRIPT = UUID("ee000000-0000-4000-8000-0000000000d1")


def _seg(n: int, speaker: str, text: str) -> Segment:
    return Segment(
        id=UUID(f"ee000000-0000-4000-8000-0000000000c{n}"),
        seq=n,
        speaker=speaker,
        speaker_confidence=0.95,
        start_sec=float(10 * n),
        end_sec=float(10 * n + 8),
        text=text,
    )


SAMPLE_SEGMENTS: tuple[Segment, ...] = (
    _seg(1, "clinician", "Hi Olivia, what brings you in today?"),
    _seg(2, "patient", "I've been tired for about three weeks and I get headaches."),
    _seg(3, "clinician", "Your blood pressure is 142 over 91 today."),
    _seg(4, "patient", "I have never smoked. I'm allergic to penicillin."),
    _seg(5, "clinician", "Let's start an iron supplement once a day."),
    _seg(6, "clinician", "We'll repeat the blood test in six weeks."),
)

_YES_NO = [{"value": "yes"}, {"value": "no"}, {"value": "not_stated"}]


def _q(qid: str, kind: str, text: str, options: list[dict[str, Any]], threshold: float) -> Any:
    return TypedQuestion.model_validate(
        {
            "id": qid,
            "version": 1,
            "kind": kind,
            "text": text,
            "options": options,
            "threshold": threshold,
        }
    )


SAMPLE_QUESTIONS: tuple[TypedQuestion, ...] = (
    _q("fatigue_reported", "yes_no", "Does the patient report tiredness or fatigue?", _YES_NO, 0.7),
    _q("chest_pain_reported", "yes_no", "Does the patient report chest pain?", _YES_NO, 0.8),
    _q(
        "smoker_status",
        "choice",
        "What is the patient's smoking status?",
        [
            {"value": "current", "label": "Currently smokes"},
            {"value": "former", "label": "Used to smoke, has quit"},
            {"value": "never", "label": "Has never smoked"},
            {"value": "unclear", "label": "Not stated or unclear"},
        ],
        0.7,
    ),
    _q(
        "urgency_level",
        "score",
        "How urgently does something discussed need clinical attention?",
        [
            {"value": "routine", "level": 0, "description": "Routine"},
            {"value": "soon", "level": 1, "description": "Soon: within a few days"},
            {"value": "urgent", "level": 2, "description": "Urgent: needs review today"},
            {"value": "emergency", "level": 3, "description": "Emergency: call 000"},
        ],
        0.8,
    ),
    _q("attr_negated", "yes_no", "Is the finding stated as absent (negated)?", _YES_NO, 0.7),
    _q(
        "attr_hypothetical",
        "yes_no",
        "Is the finding hypothetical or conditional?",
        _YES_NO,
        0.7,
    ),
    _q(
        "attr_experiencer",
        "choice",
        "Who experiences the finding?",
        [
            {"value": "patient", "label": "The patient"},
            {"value": "family", "label": "A family member"},
            {"value": "other", "label": "Someone else"},
            {"value": "unclear", "label": "Unclear"},
        ],
        0.7,
    ),
    _q(
        "attr_temporality",
        "choice",
        "When does the finding apply?",
        [
            {"value": "current", "label": "Now"},
            {"value": "past", "label": "In the past"},
            {"value": "future", "label": "Planned or in the future"},
            {"value": "unclear", "label": "Unclear"},
        ],
        0.7,
    ),
    _q(
        "evidence_segment",
        "choice",
        "Which segment best supports the answer to the question?",
        [{"value": "none", "label": "No segment supports the answer"}, {"value": "unclear"}],
        0.6,
    ),
    _q(
        "presenting_complaint_summary",
        "explain",
        "In one or two sentences, why did the patient come in today?",
        [],
        0.7,
    ),
)

SAMPLE_FIELDS: tuple[ClinicalField, ...] = tuple(
    ClinicalField.model_validate(f)
    for f in (
        {
            "id": "bp_reading",
            "version": 1,
            "label": "Blood pressure",
            "value_schema": {
                "type": "object",
                "properties": {
                    "systolic": {"type": "integer", "minimum": 50, "maximum": 300},
                    "diastolic": {"type": "integer", "minimum": 20, "maximum": 200},
                },
                "required": ["systolic", "diastolic"],
                "additionalProperties": False,
            },
            "unit": "mm[Hg]",
            "code_system": "LOINC",
            "topic": "observation",
        },
        {
            "id": "body_temperature",
            "version": 1,
            "label": "Body temperature",
            "value_schema": {"type": "number", "minimum": 30, "maximum": 45},
            "unit": "Cel",
            "code_system": "LOINC",
            "topic": "observation",
        },
        {
            "id": "smoking_status",
            "version": 1,
            "label": "Smoking status",
            "value_schema": {"type": "string", "enum": ["current", "former", "never"]},
            "code_system": "SNOMED CT-AU",
            "topic": "social_history",
        },
        {
            "id": "current_medication",
            "version": 1,
            "label": "Current medication",
            "value_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 200},
                    "dose": {"type": "string", "maxLength": 100},
                    "frequency": {"type": "string", "maxLength": 100},
                },
                "required": ["name"],
                "additionalProperties": False,
            },
            "code_system": "AMT",
            "topic": "medication",
        },
    )
)


@dataclass
class _FakeFact:
    id: UUID
    appointment_id: UUID
    fact: NewFact


@dataclass
class FakeClinicalData:
    appointment_id: UUID = OLIVIA_APPROVED_APPOINTMENT
    eligible: Eligibility = field(default_factory=lambda: Eligibility(True, ()))
    transcript_id: UUID | None = SAMPLE_TRANSCRIPT
    segments: tuple[Segment, ...] = SAMPLE_SEGMENTS
    questions: tuple[TypedQuestion, ...] = SAMPLE_QUESTIONS
    fields: tuple[ClinicalField, ...] = SAMPLE_FIELDS
    facts: list[_FakeFact] = field(default_factory=list)
    other_patient_facts: set[UUID] = field(default_factory=set)
    open_items: dict[str, OpenItemRow] = field(default_factory=dict)
    gp_queries: dict[str, tuple[UUID, str, tuple[UUID, ...]]] = field(default_factory=dict)
    clinician_prefs: dict[UUID, dict[str, Any]] = field(
        default_factory=lambda: {DR_RAO: {"note_style": "soap", "units": "metric"}}
    )


class FakeClinicalRepository:
    def __init__(self, data: FakeClinicalData | None = None) -> None:
        self.data = data or FakeClinicalData()

    def _mine(self, ctx: Context) -> bool:
        return ctx.appointment_id == self.data.appointment_id

    async def eligibility(self, ctx: Context) -> Eligibility:
        if not self._mine(ctx):
            return Eligibility(False, ("appointment_not_found",))
        return self.data.eligible

    async def approved_segments(self, ctx: Context) -> tuple[UUID | None, list[Segment]]:
        if not self._mine(ctx) or self.data.transcript_id is None:
            return None, []
        return self.data.transcript_id, list(self.data.segments)

    async def segments_by_ids(self, ctx: Context, ids: Sequence[UUID]) -> list[Segment]:
        _, segments = await self.approved_segments(ctx)
        wanted = set(ids)
        return [s for s in segments if s.id in wanted]

    async def search_segments(self, ctx: Context, query: str, limit: int) -> list[Segment]:
        _, segments = await self.approved_segments(ctx)
        q = query.lower()
        return [s for s in segments if q in s.text.lower()][:limit]

    async def active_questions(self, ctx: Context) -> list[TypedQuestion]:
        return list(self.data.questions)

    async def field(self, ctx: Context, field_id: str) -> ClinicalField | None:
        return next((f for f in self.data.fields if f.id == field_id), None)

    async def save_draft_fact(self, ctx: Context, fact: NewFact) -> SavedRow:
        for f in self.data.facts:
            if f.fact.idempotency_key == fact.idempotency_key:
                if f.appointment_id != ctx.appointment_id:
                    raise IdempotencyKeyReused()
                return SavedRow(id=f.id, created=False)
        for f in self.data.facts:
            if (
                f.appointment_id == ctx.appointment_id
                and f.fact.field.id == fact.field.id
                and f.fact.value == fact.value
                and set(f.fact.segment_ids) & set(fact.segment_ids)
            ):
                return SavedRow(id=f.id, created=False)
        assert ctx.appointment_id is not None
        new = _FakeFact(uuid.uuid4(), ctx.appointment_id, fact)
        self.data.facts.append(new)
        return SavedRow(id=new.id, created=True)

    async def fact_ids(self, ctx: Context, ids: Sequence[UUID]) -> list[UUID]:
        mine = {f.id for f in self.data.facts if f.appointment_id == ctx.appointment_id}
        return [i for i in ids if i in mine and i not in self.data.other_patient_facts]

    async def save_open_item(
        self,
        ctx: Context,
        *,
        kind: OpenItemKind,
        severity: int | None,
        description: str,
        related_fact_ids: Sequence[UUID],
        idempotency_key: str,
    ) -> SavedRow:
        found = self.data.open_items.get(idempotency_key)
        if found is not None:
            return SavedRow(id=found.id, created=False)
        if not description.strip():
            raise InvalidRequest()
        row = OpenItemRow(
            id=uuid.uuid4(),
            kind=kind,
            severity=severity,
            description=description,
            status="open",
            related_fact_ids=tuple(related_fact_ids),
            created_at=datetime.now(UTC),
        )
        self.data.open_items[idempotency_key] = row
        return SavedRow(id=row.id, created=True)

    async def open_items(self, ctx: Context, status: str | None) -> list[OpenItemRow]:
        if not self._mine(ctx):
            return []
        return [o for o in self.data.open_items.values() if status is None or o.status == status]

    async def save_gp_query(
        self,
        ctx: Context,
        *,
        question: str,
        context_fact_ids: Sequence[UUID],
        idempotency_key: str,
    ) -> SavedRow:
        found = self.data.gp_queries.get(idempotency_key)
        if found is not None:
            return SavedRow(id=found[0], created=False)
        new_id = uuid.uuid4()
        self.data.gp_queries[idempotency_key] = (new_id, question, tuple(context_fact_ids))
        return SavedRow(id=new_id, created=True)

    async def clinician_preferences(self, ctx: Context) -> dict[str, Any]:
        if ctx.clinician_id is None:
            return {}
        return dict(self.data.clinician_prefs.get(ctx.clinician_id, {}))


# ---------------------------------------------------------------------------
# Checks every clinical tool makes before touching transcript text
# ---------------------------------------------------------------------------
MAX_SEGMENT_IDS = 200


async def eligible_context(repo: ClinicalRepository, appointment_id: UUID | None = None) -> Context:
    """The job's Context, after checking the appointment and its consent (spec 6.1).

    An appointment argument must equal the job token's appointment.
    """
    ctx = current_context()
    ctx.require_appointment(appointment_id)
    result = await repo.eligibility(ctx)
    if not result.eligible:
        raise NotEligible()
    return ctx


async def load_segments(
    repo: ClinicalRepository, ctx: Context, ids: Sequence[UUID]
) -> list[Segment]:
    """The given segments of this appointment's approved transcript, all or nothing."""
    unique = list(dict.fromkeys(ids))
    if not unique:
        raise InvalidRequest("Give at least one segment id.")
    if len(unique) > MAX_SEGMENT_IDS:
        raise InvalidRequest(f"Give at most {MAX_SEGMENT_IDS} segment ids.")
    found = await repo.segments_by_ids(ctx, unique)
    if {s.id for s in found} != set(unique):
        raise ScopeViolation()
    return sorted(found, key=lambda s: s.seq)


def state_text(segments: Sequence[Segment]) -> str:
    """The text sent to an engine (same layout as the consult-notes worker)."""
    return "\n".join(f"{s.speaker or 'speaker'}: {s.text}" for s in segments)
