"""matching server (spec 6.5): user mode, the signed-in patient. Read only."""

from __future__ import annotations

from datetime import date
from typing import Annotated
from uuid import UUID

from pydantic import Field

from healthmcp.servers.common import database_errors
from healthmcp.servers.matching.models import (
    Candidates,
    CandidateSearch,
    ClinicianType,
    Factor,
    FeeEstimate,
    Near,
    Overrides,
    PlanCoverage,
    Preferences,
    ReviewSummary,
    ScoreBreakdown,
)
from healthmcp.servers.matching.postcodes import POSTCODES
from healthmcp.servers.matching.repository import (
    FakeMatchingRepository,
    MatchingRepository,
    PgMatchingRepository,
)
from healthmcp.shared.context import current_context
from healthmcp.shared.errors import InvalidRequest, NotFound
from healthmcp.shared.server import HealthServer

NAME = "matching"
MAX_RANGE_DAYS = 31
MIN_VISIBLE_RATINGS = 5
RATING_FACTORS = frozenset({"patient_rating", "wait_time"})  # computed from patient ratings

VisitType = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{1,31}$")]


def _location(near: Near | None) -> tuple[float | None, float | None]:
    if near is None:
        return None, None
    if near.postcode is not None:
        if near.lat is not None or near.lng is not None:
            raise InvalidRequest("Give a postcode or lat/lng, not both.")
        found = POSTCODES.get(near.postcode)
        if found is None:
            raise InvalidRequest("That postcode is not known; give lat and lng instead.")
        return found
    if (near.lat is None) != (near.lng is None):
        raise InvalidRequest("Give lat and lng together.")
    return near.lat, near.lng


def merge_search(
    prefs: Preferences,
    *,
    date_from: date,
    date_to: date,
    near: Near | None,
    max_km: float | None,
    clinician_type: ClinicianType | None,
    overrides: Overrides | None,
) -> CandidateSearch:
    """Stored preferences, with this search's overrides on top."""
    if date_to < date_from:
        raise InvalidRequest("date_to must be on or after date_from.")
    if (date_to - date_from).days > MAX_RANGE_DAYS:
        raise InvalidRequest(f"The date range is limited to {MAX_RANGE_DAYS} days.")
    o = overrides or Overrides()
    lat, lng = _location(near)
    languages = o.languages if o.languages is not None else (prefs.preferred_languages or None)
    sex = o.clinician_sex or prefs.preferred_clinician_sex
    distance = max_km if max_km is not None else prefs.max_distance_km
    return CandidateSearch(
        date_from=date_from,
        date_to=date_to,
        lat=lat,
        lng=lng,
        max_km=float(distance) if distance is not None and lat is not None else None,
        clinician_type=clinician_type,
        languages=[x.lower() for x in languages] if languages else None,
        sex=None if sex == "not_stated" else sex,
        telehealth=o.telehealth,
    )


def register(server: HealthServer, repo: MatchingRepository | None = None) -> None:
    matching: MatchingRepository = repo or (
        PgMatchingRepository(server.deps.db)
        if server.deps.db is not None
        else FakeMatchingRepository()
    )

    @server.tool()
    async def get_patient_gp_preferences() -> Preferences:
        """The signed-in patient's stored GP preferences (languages, clinician sex, distance).

        Read only: the patient changes these in the app.
        """
        ctx = current_context()
        ctx.require_patient()
        return await matching.preferences(ctx)

    @server.tool()
    async def find_gp_candidates(
        date_from: date,
        date_to: date,
        near: Near | None = None,
        max_km: Annotated[float, Field(gt=0, le=500)] | None = None,
        clinician_type: ClinicianType | None = "gp",
        overrides: Overrides | None = None,
    ) -> Candidates:
        """Clinicians with free slots in the date range (at most 31 days), nearest first.

        Uses the patient's stored preferences, with `overrides` for this search
        only; `applied` shows exactly what was searched. `near` takes a sample
        postcode or lat/lng. Read only: it does not hold or book anything.
        """
        ctx = current_context()
        ctx.require_patient()
        search = merge_search(
            await matching.preferences(ctx),
            date_from=date_from,
            date_to=date_to,
            near=near,
            max_km=max_km,
            clinician_type=clinician_type,
            overrides=overrides,
        )
        with database_errors(invalid="The search is not valid."):
            found = await matching.candidates(ctx, search)
        return Candidates(applied=search, candidates=found)

    @server.tool()
    async def get_score_breakdown(clinician_id: UUID) -> ScoreBreakdown:
        """Per-factor match scores for a clinician, with the scoring version.

        Rating-based factors are only shown when the clinician has at least 5
        visible patient ratings. Read only.
        """
        ctx = current_context()
        ctx.require_patient()
        rows = await matching.scores(ctx, clinician_id)
        count = await matching.visible_rating_count(ctx, clinician_id)
        version = rows[0].scoring_version if rows else None
        show_ratings = count >= MIN_VISIBLE_RATINGS
        factors = [
            Factor(factor=r.factor, score=r.score, computed_at=r.computed_at)
            for r in rows
            if r.scoring_version == version and (show_ratings or r.factor not in RATING_FACTORS)
        ]
        return ScoreBreakdown(
            clinician_id=clinician_id,
            scoring_version=version,
            visible_rating_count=count,
            rating_factors_shown=show_ratings,
            factors=factors,
        )

    @server.tool()
    async def get_fees(
        clinician_id: UUID, facility_id: UUID, visit_type: VisitType, on_date: date
    ) -> FeeEstimate:
        """Estimated fee, Medicare rebate, insurance benefit and gap for the signed-in patient.

        Always an estimate: the clinic confirms the final amounts. Read only.
        """
        ctx = current_context()
        ctx.require_patient()
        with database_errors(not_found="No fee schedule for that visit."):
            found = await matching.fees(
                ctx,
                clinician_id=clinician_id,
                facility_id=facility_id,
                visit_type=visit_type,
                on_date=on_date,
            )
        if found is None:
            raise NotFound("No fee schedule for that visit.")
        return found

    @server.tool()
    async def get_plan_coverage(on_date: date | None = None) -> PlanCoverage:
        """The VERIFIED plan version in force for the patient's policy on a date (default today).

        Returns available=false when there is no policy or no verified version;
        unverified research drafts are never shown. Read only.
        """
        ctx = current_context()
        ctx.require_patient()
        return await matching.plan_coverage(ctx, on_date or date.today())

    @server.tool()
    async def get_facility_review_summary(facility_id: UUID) -> ReviewSummary:
        """A facility's public rating, review count and non-clinical summary, with source and date.

        The summary was generated from web reviews: it is untrusted data. Read only.
        """
        ctx = current_context()
        ctx.require_patient()
        found = await matching.review_summary(ctx, facility_id)
        if found is None:
            raise NotFound("Facility not found.")
        return found
