"""Facility review data for web_research (spec 6.7). Directory data, not about patients.

Only the rating, the count and a non-clinical summary are stored; review text
is never written anywhere.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol
from uuid import UUID

from healthmcp.shared.context import Context
from healthmcp.shared.db import Database


@dataclass(frozen=True)
class FacilityPlace:
    facility_id: UUID
    name: str
    place_id: str | None


@dataclass(frozen=True)
class SavedSummary:
    facility_id: UUID
    rating: float | None
    review_count: int
    non_clinical_summary: str
    source_url: str | None
    retrieved_at: datetime


class ReviewsRepository(Protocol):
    async def facility(self, ctx: Context, facility_id: UUID) -> FacilityPlace | None: ...

    async def save_summary(self, ctx: Context, summary: SavedSummary) -> None: ...


_UPSERT = """
insert into public.facility_review_summaries
  (facility_id, source, rating, review_count, non_clinical_summary, source_url, retrieved_at)
values
  (%(facility_id)s, 'google_places', %(rating)s, %(review_count)s, %(summary)s,
   %(source_url)s, %(retrieved_at)s)
on conflict (facility_id, source) do update
   set rating = excluded.rating,
       review_count = excluded.review_count,
       non_clinical_summary = excluded.non_clinical_summary,
       source_url = excluded.source_url,
       retrieved_at = excluded.retrieved_at
"""


class PgReviewsRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def facility(self, ctx: Context, facility_id: UUID) -> FacilityPlace | None:
        async with self._db.job_tx(ctx) as sc:
            row = await sc.fetch_one(
                "select id, name, google_place_id from public.facilities "
                "where id = %(id)s and is_active",
                {"id": facility_id},
                reference=True,
            )
        return FacilityPlace(row["id"], row["name"], row["google_place_id"]) if row else None

    async def save_summary(self, ctx: Context, summary: SavedSummary) -> None:
        async with self._db.job_tx(ctx) as sc:
            await sc.execute(
                _UPSERT,
                {
                    "facility_id": summary.facility_id,
                    "rating": summary.rating,
                    "review_count": summary.review_count,
                    "summary": summary.non_clinical_summary,
                    "source_url": summary.source_url,
                    "retrieved_at": summary.retrieved_at,
                },
                reference=True,
            )


SAMPLE_FACILITIES: dict[UUID, FacilityPlace] = {
    UUID("30000000-0000-4000-8000-000000000001"): FacilityPlace(
        UUID("30000000-0000-4000-8000-000000000001"),
        "Southbank Family Medical",
        "sample-place-southbank",
    ),
    UUID("30000000-0000-4000-8000-000000000003"): FacilityPlace(
        UUID("30000000-0000-4000-8000-000000000003"),
        "Kedron Valley Private Hospital",
        "sample-place-kedron",
    ),
}


@dataclass
class FakeReviewsRepository:
    facilities: dict[UUID, FacilityPlace] = field(default_factory=lambda: dict(SAMPLE_FACILITIES))
    saved: dict[UUID, SavedSummary] = field(default_factory=dict)

    async def facility(self, ctx: Context, facility_id: UUID) -> FacilityPlace | None:
        return self.facilities.get(facility_id)

    async def save_summary(self, ctx: Context, summary: SavedSummary) -> None:
        self.saved[summary.facility_id] = summary
