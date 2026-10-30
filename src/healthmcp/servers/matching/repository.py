"""Matching reads (spec 6.5). User mode: RLS applies and fees use the signed-in patient."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Protocol
from uuid import UUID

from healthmcp.servers.matching.models import (
    Candidate,
    CandidateSearch,
    FeeEstimate,
    PlanCoverage,
    Preferences,
    ReviewSummary,
)
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database
from healthmcp.shared.guards import untrusted
from healthmcp.shared.repositories.fake_data import DR_RAO, OLIVIA


@dataclass(frozen=True)
class ScoreRow:
    factor: str
    score: float
    scoring_version: str
    computed_at: datetime


class MatchingRepository(Protocol):
    async def preferences(self, ctx: Context) -> Preferences: ...

    async def candidates(self, ctx: Context, search: CandidateSearch) -> list[Candidate]: ...

    async def scores(self, ctx: Context, clinician_id: UUID) -> list[ScoreRow]: ...

    async def visible_rating_count(self, ctx: Context, clinician_id: UUID) -> int: ...

    async def fees(
        self,
        ctx: Context,
        *,
        clinician_id: UUID,
        facility_id: UUID,
        visit_type: str,
        on_date: date,
    ) -> FeeEstimate | None: ...

    async def plan_coverage(self, ctx: Context, on_date: date) -> PlanCoverage: ...

    async def review_summary(self, ctx: Context, facility_id: UUID) -> ReviewSummary | None: ...


_COVERAGE = """
select pl.id as plan_id, pl.plan_name, v.id as plan_version_id, v.valid_from, v.valid_to,
       v.hospital_inclusions, v.hospital_exclusions, v.hospital_restricted, v.excess,
       v.extras_limits, v.waiting_periods, v.gp_benefit, v.source, v.source_url, v.verified_at
  from public.patient_insurance_policies pol
  join public.insurance_plans pl on pl.id = pol.plan_id
  left join public.insurance_plan_versions v
    on v.plan_id = pl.id and v.status = 'verified'
   and daterange(v.valid_from, v.valid_to, '[)') @> %(on_date)s::date
 where pol.patient_id = %(scope_patient_id)s
   and pol.id = public.policy_on(%(scope_patient_id)s, %(on_date)s::date)
"""

_REVIEWS = """
select f.id as facility_id, f.name as facility_name, r.rating, r.review_count,
       r.non_clinical_summary, r.source, r.source_url, r.retrieved_at
  from public.facilities f
  left join public.facility_review_summaries r on r.facility_id = f.id
 where f.id = %(facility_id)s
 order by r.retrieved_at desc nulls last
 limit 1
"""


def coverage_from(row: dict[str, Any] | None) -> PlanCoverage:
    if row is None or row.get("plan_version_id") is None:
        return PlanCoverage(
            available=False,
            plan_id=row["plan_id"] if row else None,
            plan_name=row["plan_name"] if row else None,
        )
    return PlanCoverage(available=True, **row)


class PgMatchingRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def preferences(self, ctx: Context) -> Preferences:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select preferred_languages, preferred_clinician_sex, preferred_facility_ids, "
                "telehealth_ok, max_distance_km from public.patient_gp_preferences "
                "where patient_id = %(scope_patient_id)s"
            )
        return Preferences(**row, stored=True) if row else Preferences()

    async def candidates(self, ctx: Context, search: CandidateSearch) -> list[Candidate]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select * from public.find_gp_candidates(%(date_from)s::date, %(date_to)s::date, "
                "%(lat)s::numeric, %(lng)s::numeric, %(max_km)s::numeric, "
                "%(clinician_type)s::public.clinician_type, %(languages)s::text[], "
                "%(sex)s::text, %(telehealth)s::boolean) limit 100",
                search.model_dump(),
            )
        return [Candidate.model_validate(r) for r in rows]

    async def scores(self, ctx: Context, clinician_id: UUID) -> list[ScoreRow]:
        async with self._db.user_tx(ctx) as sc:
            rows = await sc.fetch_all(
                "select factor, score, scoring_version, computed_at "
                "from public.clinician_match_scores where clinician_id = %(id)s "
                "order by computed_at desc, factor",
                {"id": clinician_id},
            )
        return [
            ScoreRow(r["factor"], float(r["score"]), r["scoring_version"], r["computed_at"])
            for r in rows
        ]

    async def visible_rating_count(self, ctx: Context, clinician_id: UUID) -> int:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select rating_count from public.get_clinician_rating_summary(%(id)s)",
                {"id": clinician_id},
            )
        return int(row["rating_count"]) if row else 0

    async def fees(
        self,
        ctx: Context,
        *,
        clinician_id: UUID,
        facility_id: UUID,
        visit_type: str,
        on_date: date,
    ) -> FeeEstimate | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select fee_schedule_id, mbs_item, fee, medicare_eligible, medicare_rebate, "
                "plan_id, plan_version_id, insurance_benefit, gap "
                "from public.estimate_fees(%(scope_patient_id)s, %(facility_id)s, "
                "%(clinician_id)s, %(visit_type)s, %(on_date)s::date)",
                {
                    "facility_id": facility_id,
                    "clinician_id": clinician_id,
                    "visit_type": visit_type,
                    "on_date": on_date,
                },
            )
        if row is None or row.get("fee_schedule_id") is None:
            return None
        return FeeEstimate.model_validate(row)

    async def plan_coverage(self, ctx: Context, on_date: date) -> PlanCoverage:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(_COVERAGE, {"on_date": on_date})
        return coverage_from(row)

    async def review_summary(self, ctx: Context, facility_id: UUID) -> ReviewSummary | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one(_REVIEWS, {"facility_id": facility_id})
        if row is None:
            return None
        if row["source"] is None:
            return ReviewSummary(
                facility_id=row["facility_id"], facility_name=row["facility_name"], available=False
            )
        return ReviewSummary(available=True, **row)


# ---------------------------------------------------------------------------
# Fake
# ---------------------------------------------------------------------------
SOUTHBANK = UUID("30000000-0000-4000-8000-000000000001")
_COMPUTED = datetime(2026, 10, 28, tzinfo=UTC)


@dataclass
class FakeMatchingData:
    preferences: dict[UUID, Preferences] = field(
        default_factory=lambda: {
            OLIVIA: Preferences(
                preferred_languages=["en"], telehealth_ok=True, max_distance_km=15, stored=True
            )
        }
    )
    candidates: list[Candidate] = field(
        default_factory=lambda: [
            Candidate(
                clinician_id=DR_RAO,
                clinician_name="Asha Rao",
                clinician_type="gp",
                specialty="General Practice",
                sex="female",
                languages=["en", "hi"],
                offers_telehealth=True,
                facility_id=SOUTHBANK,
                facility_name="Southbank Family Medical",
                facility_suburb="South Brisbane",
                distance_km=0.5,
            )
        ]
    )
    scores: dict[UUID, list[ScoreRow]] = field(
        default_factory=lambda: {
            DR_RAO: [
                ScoreRow("availability", 0.82, "v1", _COMPUTED),
                ScoreRow("continuity", 0.90, "v1", _COMPUTED),
                ScoreRow("patient_rating", 1.00, "v1", _COMPUTED),
                ScoreRow("wait_time", 1.00, "v1", _COMPUTED),
            ]
        }
    )
    rating_counts: dict[UUID, int] = field(default_factory=lambda: {DR_RAO: 3})
    searches: list[CandidateSearch] = field(default_factory=list)


class FakeMatchingRepository:
    def __init__(self, data: FakeMatchingData | None = None) -> None:
        self.data = data or FakeMatchingData()

    async def preferences(self, ctx: Context) -> Preferences:
        return self.data.preferences.get(ctx.require_patient(), Preferences())

    async def candidates(self, ctx: Context, search: CandidateSearch) -> list[Candidate]:
        self.data.searches.append(search)
        return [
            c
            for c in self.data.candidates
            if (search.languages is None or set(search.languages) & set(c.languages))
            and (search.sex is None or c.sex == search.sex)
        ]

    async def scores(self, ctx: Context, clinician_id: UUID) -> list[ScoreRow]:
        return list(self.data.scores.get(clinician_id, []))

    async def visible_rating_count(self, ctx: Context, clinician_id: UUID) -> int:
        return self.data.rating_counts.get(clinician_id, 0)

    async def fees(
        self,
        ctx: Context,
        *,
        clinician_id: UUID,
        facility_id: UUID,
        visit_type: str,
        on_date: date,
    ) -> FeeEstimate | None:
        if facility_id != SOUTHBANK or visit_type != "standard":
            return None
        return FeeEstimate(
            mbs_item="23",
            fee=Decimal("85.00"),
            medicare_eligible=ctx.patient_id == OLIVIA,
            medicare_rebate=Decimal("43.90"),
            insurance_benefit=Decimal("0"),
            gap=Decimal("41.10"),
        )

    async def plan_coverage(self, ctx: Context, on_date: date) -> PlanCoverage:
        if ctx.require_patient() != OLIVIA:
            return PlanCoverage(available=False)
        return PlanCoverage(
            available=True,
            plan_id=UUID("21000000-0000-4000-8000-000000000002"),
            plan_name="Silver Plus Combined",
            plan_version_id=UUID("ee000000-0000-4000-8000-0000000000e1"),
            valid_from=date(2026, 1, 1),
            gp_benefit={"covered": False},
            source="phio_dataset",
            verified_at=_COMPUTED,
        )

    async def review_summary(self, ctx: Context, facility_id: UUID) -> ReviewSummary | None:
        if facility_id != SOUTHBANK:
            return None
        return ReviewSummary(
            facility_id=SOUTHBANK,
            facility_name="Southbank Family Medical",
            available=True,
            rating=4.6,
            review_count=128,
            non_clinical_summary=untrusted(
                "Reviewers mention friendly reception staff and short waits."
            ),
            source="google_places",
            retrieved_at=_COMPUTED,
        )
