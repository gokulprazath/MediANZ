"""Patient record reads (spec 6.4).

Every query is pinned to the request's patient with %(scope_patient_id)s: in
user mode that is current_patient_id() (resolved at the gate, and RLS applies
on top); in job mode it is the job token's patient.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Protocol
from uuid import UUID

from healthmcp.servers.patient_record.models import (
    FIELD_KINDS,
    AppointmentRow,
    ApprovedFact,
    Eligibility,
    InsuranceInForce,
    Observation,
    ObservationKind,
    Residency,
)
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database, Row
from healthmcp.shared.repositories.fake_data import OLIVIA, OLIVIA_APPROVED_APPOINTMENT


class PatientRecordRepository(Protocol):
    async def approved_facts(
        self, ctx: Context, *, topic: str | None, as_of: date, include_history: bool
    ) -> list[ApprovedFact]: ...

    async def observations(
        self,
        ctx: Context,
        *,
        kind: ObservationKind | None,
        date_from: date | None,
        date_to: date | None,
    ) -> list[Observation]: ...

    async def eligibility(self, ctx: Context, on_date: date) -> Eligibility: ...

    async def appointments(
        self,
        ctx: Context,
        *,
        date_from: date | None,
        date_to: date | None,
        status: str | None,
    ) -> list[AppointmentRow]: ...


_FACTS = """
select f.id as fact_id, f.appointment_id, f.field_id, f.field_version, cf.label, cf.topic,
       f.value, f.unit, f.code_system, f.status, f.negated, f.experiencer, f.temporality,
       f.valid_from, f.valid_to, f.superseded_by
  from public.clinical_facts f
  join public.clinical_fields cf on cf.id = f.field_id and cf.version = f.field_version
 where f.patient_id = %(scope_patient_id)s
   and (f.status = 'approved' or (%(history)s and f.status = 'superseded'))
   and (%(topic)s::text is null or cf.topic = %(topic)s)
   and f.valid_from <= %(as_of)s::date
   and (%(history)s or f.valid_to is null or f.valid_to > %(as_of)s::date)
 order by cf.topic, f.field_id, f.valid_from desc
 limit 500
"""

_VITALS = """
select v.id, v.appointment_id, v.recorded_at, v.temperature_c, v.spo2_percent,
       v.bp_systolic, v.bp_diastolic, v.height_cm, v.weight_kg, v.bmi
  from public.visit_vitals v
 where v.patient_id = %(scope_patient_id)s
   and (%(date_from)s::date is null or v.recorded_at::date >= %(date_from)s::date)
   and (%(date_to)s::date is null or v.recorded_at::date <= %(date_to)s::date)
 order by v.recorded_at desc
 limit 500
"""

_OBSERVATION_FACTS = """
select f.id as fact_id, f.appointment_id, f.field_id, f.value, f.unit,
       a.scheduled_start as observed_at
  from public.clinical_facts f
  join public.clinical_fields cf on cf.id = f.field_id and cf.version = f.field_version
  join public.appointments a on a.id = f.appointment_id
 where f.patient_id = %(scope_patient_id)s
   and f.status = 'approved'
   and cf.topic = 'observation'
   and (%(date_from)s::date is null or a.scheduled_start::date >= %(date_from)s::date)
   and (%(date_to)s::date is null or a.scheduled_start::date <= %(date_to)s::date)
 order by a.scheduled_start desc
 limit 500
"""

_RESIDENCY = """
select rs.code, rs.category::text as category, rs.name, rs.medicare_eligible,
       pr.valid_from, pr.valid_to
  from public.patient_residency pr
  join public.residency_statuses rs on rs.id = pr.residency_status_id
 where pr.patient_id = %(scope_patient_id)s
   and daterange(pr.valid_from, pr.valid_to, '[)') @> %(on_date)s::date
"""

_MEDICARE_CARD = """
select (p.medicare_number is not null
        and (p.medicare_expiry is null or p.medicare_expiry >= %(on_date)s::date)) as valid
  from public.patients p
 where p.id = %(scope_patient_id)s
"""

_POLICY = """
select pol.id as policy_id, pl.id as plan_id, pl.plan_name, pl.cover_type::text as cover_type,
       pl.tier, ip.name as insurer_name, pol.valid_from, pol.valid_to
  from public.patient_insurance_policies pol
  join public.insurance_plans pl on pl.id = pol.plan_id
  join public.insurance_providers ip on ip.id = pl.provider_id
 where pol.patient_id = %(scope_patient_id)s
   and pol.id = public.policy_on(%(scope_patient_id)s, %(on_date)s::date)
"""

_APPOINTMENTS = """
select a.id as appointment_id, a.status::text as status, a.scheduled_start, a.scheduled_end,
       (a.scheduled_start at time zone f.timezone) as local_start, f.timezone, a.visit_type,
       a.clinician_id, c.first_name || ' ' || c.last_name as clinician_name,
       c.clinician_type::text as clinician_type, a.facility_id, f.name as facility_name,
       f.suburb as facility_suburb
  from public.appointments a
  join public.facilities f on f.id = a.facility_id
  join public.clinicians c on c.id = a.clinician_id
 where a.patient_id = %(scope_patient_id)s
   and (%(date_from)s::date is null
        or (a.scheduled_start at time zone f.timezone)::date >= %(date_from)s::date)
   and (%(date_to)s::date is null
        or (a.scheduled_start at time zone f.timezone)::date <= %(date_to)s::date)
   and (%(status)s::text is null or a.status::text = %(status)s::text)
 order by a.scheduled_start desc
 limit 200
"""


def vitals_observations(row: Row) -> list[Observation]:
    """One measured vitals row -> one observation per measurement taken."""
    base: dict[str, Any] = {
        "observed_at": row["recorded_at"],
        "source": "measured",
        "appointment_id": row["appointment_id"],
    }
    out: list[Observation] = []

    def add(kind: ObservationKind, value: Any, unit: str) -> None:
        if value is not None:
            out.append(Observation(kind=kind, value=value, unit=unit, **base))

    add("temperature", _num(row.get("temperature_c")), "Cel")
    add("spo2", _num(row.get("spo2_percent")), "%")
    if row.get("bp_systolic") is not None:
        add(
            "blood_pressure",
            {"systolic": int(row["bp_systolic"]), "diastolic": int(row["bp_diastolic"])},
            "mm[Hg]",
        )
    add("height", _num(row.get("height_cm")), "cm")
    add("weight", _num(row.get("weight_kg")), "kg")
    add("bmi", _num(row.get("bmi")), "kg/m2")
    return out


def fact_observation(row: Row) -> Observation:
    return Observation(
        kind=FIELD_KINDS.get(row["field_id"], "other"),
        field_id=row["field_id"],
        value=row["value"],
        unit=row.get("unit"),
        observed_at=row["observed_at"],
        source="transcript",
        appointment_id=row["appointment_id"],
        fact_id=row["fact_id"],
    )


def _num(value: Any) -> float | None:
    return None if value is None else float(value)


def _filter_kind(rows: Sequence[Observation], kind: ObservationKind | None) -> list[Observation]:
    return [o for o in rows if kind is None or o.kind == kind]


class PgPatientRecordRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def approved_facts(
        self, ctx: Context, *, topic: str | None, as_of: date, include_history: bool
    ) -> list[ApprovedFact]:
        async with self._db.scoped(ctx) as sc:
            rows = await sc.fetch_all(
                _FACTS, {"topic": topic, "as_of": as_of, "history": include_history}
            )
        return [ApprovedFact.model_validate(r) for r in rows]

    async def observations(
        self,
        ctx: Context,
        *,
        kind: ObservationKind | None,
        date_from: date | None,
        date_to: date | None,
    ) -> list[Observation]:
        params = {"date_from": date_from, "date_to": date_to}
        async with self._db.scoped(ctx) as sc:
            vitals = await sc.fetch_all(_VITALS, params)
            facts = await sc.fetch_all(_OBSERVATION_FACTS, params)
        measured = [o for r in vitals for o in vitals_observations(r)]
        spoken = [fact_observation(r) for r in facts]
        return _filter_kind(measured, kind) + _filter_kind(spoken, kind)

    async def eligibility(self, ctx: Context, on_date: date) -> Eligibility:
        params = {"on_date": on_date}
        async with self._db.scoped(ctx) as sc:
            residency = await sc.fetch_one(_RESIDENCY, params)
            card = await sc.fetch_one(_MEDICARE_CARD, params)
            policy = await sc.fetch_one(_POLICY, params)
        res = Residency.model_validate(residency) if residency else None
        return Eligibility(
            date=on_date,
            residency=res,
            medicare_eligible=bool(res and res.medicare_eligible),
            medicare_card_valid=bool(card and card["valid"]),
            insurance=InsuranceInForce.model_validate(policy) if policy else None,
        )

    async def appointments(
        self,
        ctx: Context,
        *,
        date_from: date | None,
        date_to: date | None,
        status: str | None,
    ) -> list[AppointmentRow]:
        async with self._db.scoped(ctx) as sc:
            rows = await sc.fetch_all(
                _APPOINTMENTS, {"date_from": date_from, "date_to": date_to, "status": status}
            )
        return [AppointmentRow.model_validate(r) for r in rows]


# ---------------------------------------------------------------------------
# Fake (DATA_BACKEND=fake and unit tests): a small slice of the seed data.
# ---------------------------------------------------------------------------
_T0 = datetime(2026, 10, 20, 0, 0, tzinfo=UTC)


@dataclass
class FakePatientRecordData:
    facts: dict[UUID, list[ApprovedFact]] = field(default_factory=dict)
    vitals: dict[UUID, list[Row]] = field(default_factory=dict)
    observation_facts: dict[UUID, list[Row]] = field(default_factory=dict)
    eligibility: dict[UUID, Eligibility] = field(default_factory=dict)
    appointments: dict[UUID, list[AppointmentRow]] = field(default_factory=dict)


def sample_patient_record() -> FakePatientRecordData:
    appt = OLIVIA_APPROVED_APPOINTMENT
    bp = ApprovedFact(
        fact_id=UUID("ee000000-0000-4000-8000-0000000000f1"),
        appointment_id=appt,
        field_id="bp_reading",
        field_version=1,
        label="Blood pressure",
        topic="observation",
        value={"systolic": 142, "diastolic": 91},
        unit="mm[Hg]",
        code_system="LOINC",
        status="approved",
        valid_from=date(2026, 10, 20),
    )
    return FakePatientRecordData(
        facts={OLIVIA: [bp]},
        vitals={
            OLIVIA: [
                {
                    "appointment_id": appt,
                    "recorded_at": _T0.replace(hour=9),
                    "temperature_c": 36.8,
                    "spo2_percent": 98,
                    "bp_systolic": 138,
                    "bp_diastolic": 88,
                    "height_cm": None,
                    "weight_kg": 68.0,
                    "bmi": None,
                }
            ]
        },
        observation_facts={
            OLIVIA: [
                {
                    "fact_id": bp.fact_id,
                    "appointment_id": appt,
                    "field_id": "bp_reading",
                    "value": bp.value,
                    "unit": bp.unit,
                    "observed_at": _T0.replace(hour=9),
                }
            ]
        },
        eligibility={
            OLIVIA: Eligibility(
                date=date(2026, 10, 20),
                residency=Residency(
                    code="AU_CITIZEN",
                    category="citizen",
                    name="Australian citizen",
                    medicare_eligible=True,
                    valid_from=date(1988, 3, 14),
                ),
                medicare_eligible=True,
                medicare_card_valid=True,
                insurance=InsuranceInForce(
                    policy_id=UUID("22000000-0000-4000-8000-000000000001"),
                    plan_id=UUID("21000000-0000-4000-8000-000000000002"),
                    plan_name="Silver Plus Combined",
                    cover_type="combined",
                    tier="silver",
                    insurer_name="Sunstate Health Fund",
                    valid_from=date(2024, 1, 1),
                ),
            )
        },
        appointments={
            OLIVIA: [
                AppointmentRow(
                    appointment_id=appt,
                    status="completed",
                    scheduled_start=_T0.replace(hour=23),
                    scheduled_end=_T0.replace(hour=23, minute=15),
                    local_start=datetime(2026, 10, 21, 9, 0),
                    timezone="Australia/Brisbane",
                    visit_type="standard",
                    clinician_id=UUID("40000000-0000-4000-8000-000000000001"),
                    clinician_name="Asha Rao",
                    clinician_type="gp",
                    facility_id=UUID("30000000-0000-4000-8000-000000000001"),
                    facility_name="Southbank Family Medical",
                    facility_suburb="South Brisbane",
                )
            ]
        },
    )


class FakePatientRecordRepository:
    def __init__(self, data: FakePatientRecordData | None = None) -> None:
        self.data = data or sample_patient_record()

    async def approved_facts(
        self, ctx: Context, *, topic: str | None, as_of: date, include_history: bool
    ) -> list[ApprovedFact]:
        out = []
        for f in self.data.facts.get(ctx.require_patient(), []):
            if f.status == "superseded" and not include_history:
                continue
            if topic is not None and f.topic != topic:
                continue
            if f.valid_from > as_of:
                continue
            if not include_history and f.valid_to is not None and f.valid_to <= as_of:
                continue
            out.append(f)
        return out

    async def observations(
        self,
        ctx: Context,
        *,
        kind: ObservationKind | None,
        date_from: date | None,
        date_to: date | None,
    ) -> list[Observation]:
        patient = ctx.require_patient()

        def in_range(at: datetime) -> bool:
            d = at.date()
            return (date_from is None or d >= date_from) and (date_to is None or d <= date_to)

        measured = [
            o
            for r in self.data.vitals.get(patient, [])
            if in_range(r["recorded_at"])
            for o in vitals_observations(r)
        ]
        spoken = [
            fact_observation(r)
            for r in self.data.observation_facts.get(patient, [])
            if in_range(r["observed_at"])
        ]
        return _filter_kind(measured, kind) + _filter_kind(spoken, kind)

    async def eligibility(self, ctx: Context, on_date: date) -> Eligibility:
        found = self.data.eligibility.get(ctx.require_patient())
        if found is None:
            return Eligibility(date=on_date, medicare_eligible=False, medicare_card_valid=False)
        return found.model_copy(update={"date": on_date})

    async def appointments(
        self,
        ctx: Context,
        *,
        date_from: date | None,
        date_to: date | None,
        status: str | None,
    ) -> list[AppointmentRow]:
        out = []
        for a in self.data.appointments.get(ctx.require_patient(), []):
            d = a.local_start.date()
            if date_from is not None and d < date_from:
                continue
            if date_to is not None and d > date_to:
                continue
            if status is not None and a.status != status:
                continue
            out.append(a)
        return out
