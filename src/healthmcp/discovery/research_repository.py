"""Database access for the scheduled insurance research pipeline."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from typing import Any, Protocol
from uuid import UUID

from healthmcp.discovery.models import (
    AcceptanceExtraction,
    ClaimMode,
    CoverageExtraction,
    CoverageStatus,
    ResearchDraftSummary,
    ResearchTarget,
    SourceType,
)
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database


class ResearchRepository(Protocol):
    async def list_targets(
        self,
        ctx: Context,
        *,
        plan_ids: Sequence[UUID],
        insurance_category: str | None,
        limit: int,
    ) -> list[ResearchTarget]: ...

    async def start_run(
        self, ctx: Context, *, target: ResearchTarget, source_url: str | None
    ) -> UUID: ...

    async def finish_run(
        self,
        ctx: Context,
        *,
        run_id: UUID,
        status: str,
        pages_fetched: int,
        drafts_created: int,
        errors: int,
        notes: Sequence[str],
        source_url: str | None,
    ) -> None: ...

    async def mark_target(
        self,
        ctx: Context,
        *,
        target_id: UUID,
        status: str,
        error: str | None,
        next_run_at: datetime,
    ) -> None: ...

    async def create_coverage_draft(
        self,
        ctx: Context,
        *,
        run_id: UUID,
        target: ResearchTarget,
        extraction: CoverageExtraction,
        source_url: str,
        content_hash: str,
    ) -> UUID: ...

    async def create_acceptance_draft(
        self,
        ctx: Context,
        *,
        run_id: UUID,
        target: ResearchTarget,
        extraction: AcceptanceExtraction,
        source_url: str,
        content_hash: str,
    ) -> UUID: ...

    async def list_drafts(
        self, ctx: Context, *, status: str | None, limit: int
    ) -> list[ResearchDraftSummary]: ...

    async def approve_draft(self, ctx: Context, *, draft_id: UUID, valid_from: date) -> UUID: ...

    async def reject_draft(self, ctx: Context, *, draft_id: UUID, reason: str | None) -> None: ...


def _target(row: dict[str, Any]) -> ResearchTarget:
    return ResearchTarget(
        id=row["id"],
        target_type=row["target_type"],
        plan_id=row["plan_id"],
        facility_id=row["facility_id"],
        insurer_provider_id=row["insurer_provider_id"],
        service_id=row["service_id"],
        insurance_category=row["insurance_category"],
        url=row["url"],
        source_type=SourceType(row["source_type"]),
        priority=row["priority"],
        plan_name=row["plan_name"],
        facility_name=row["facility_name"],
        insurer_name=row["insurer_name"],
        service_name=row["service_name"],
    )


def _draft(row: dict[str, Any]) -> ResearchDraftSummary:
    return ResearchDraftSummary(
        id=row["id"],
        kind=row["kind"],
        status=row["status"],
        plan_id=row["plan_id"],
        facility_id=row["facility_id"],
        insurer_provider_id=row["insurer_provider_id"],
        service_id=row["service_id"],
        insurance_category=row["insurance_category"],
        coverage_status=(
            CoverageStatus(row["coverage_status"]) if row["coverage_status"] is not None else None
        ),
        accepted=row["accepted"],
        claim_mode=ClaimMode(row["claim_mode"]) if row["claim_mode"] is not None else None,
        source_type=SourceType(row["source_type"]),
        source_url=row["source_url"],
        evidence_quote=row["evidence_quote"],
        confidence=float(row["confidence"]),
        created_at=row["created_at"],
    )


class PgResearchRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def list_targets(
        self,
        ctx: Context,
        *,
        plan_ids: Sequence[UUID],
        insurance_category: str | None,
        limit: int,
    ) -> list[ResearchTarget]:
        async with self._db.scoped(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select rt.id, rt.target_type, rt.plan_id, rt.facility_id,
                       rt.insurer_provider_id, rt.service_id, rt.insurance_category,
                       rt.url, rt.source_type, rt.priority,
                       p.plan_name, f.name as facility_name,
                       ip.name as insurer_name, s.name as service_name
                  from public.research_targets rt
                  left join public.insurance_plans p on p.id = rt.plan_id
                  left join public.facilities f on f.id = rt.facility_id
                  left join public.insurance_providers ip on ip.id = rt.insurer_provider_id
                  left join public.service_catalog s on s.id = rt.service_id
                 where rt.active
                   and (rt.next_run_at <= now() or %(plan_ids)s::uuid[] <> '{}')
                   and (%(plan_ids)s::uuid[] = '{}' or rt.plan_id = any(%(plan_ids)s::uuid[]))
                   and (%(category)s::text is null
                        or rt.insurance_category = %(category)s)
                 order by rt.priority desc, rt.next_run_at, rt.id
                 limit %(limit)s
                """,
                {
                    "plan_ids": list(plan_ids),
                    "category": insurance_category,
                    "limit": limit,
                },
                reference=True,
            )
        return [_target(row) for row in rows]

    async def start_run(
        self, ctx: Context, *, target: ResearchTarget, source_url: str | None
    ) -> UUID:
        async with self._db.scoped(ctx) as sc:
            row = await sc.fetch_one(
                """
                insert into public.research_runs (target_id, job_id, source_url, status)
                values (%(target_id)s, %(job_id)s, %(source_url)s, 'running')
                returning id
                """,
                {
                    "target_id": target.id,
                    "job_id": ctx.job_id,
                    "source_url": source_url,
                },
                reference=True,
            )
        if not row:
            raise RuntimeError("research run was not created")
        return UUID(str(row["id"]))

    async def finish_run(
        self,
        ctx: Context,
        *,
        run_id: UUID,
        status: str,
        pages_fetched: int,
        drafts_created: int,
        errors: int,
        notes: Sequence[str],
        source_url: str | None,
    ) -> None:
        async with self._db.scoped(ctx) as sc:
            await sc.execute(
                """
                update public.research_runs
                   set status = %(status)s,
                       pages_fetched = %(pages)s,
                       drafts_created = %(drafts)s,
                       errors = %(errors)s,
                       notes = %(notes)s,
                       source_url = coalesce(%(source_url)s, source_url),
                       finished_at = now()
                 where id = %(run_id)s
                """,
                {
                    "run_id": run_id,
                    "status": status,
                    "pages": pages_fetched,
                    "drafts": drafts_created,
                    "errors": errors,
                    "notes": list(notes),
                    "source_url": source_url,
                },
                reference=True,
            )

    async def mark_target(
        self,
        ctx: Context,
        *,
        target_id: UUID,
        status: str,
        error: str | None,
        next_run_at: datetime,
    ) -> None:
        async with self._db.scoped(ctx) as sc:
            await sc.execute(
                """
                update public.research_targets
                   set last_status = %(status)s,
                       last_error = %(error)s,
                       last_run_at = now(),
                       next_run_at = %(next_run_at)s
                 where id = %(target_id)s
                """,
                {
                    "target_id": target_id,
                    "status": status,
                    "error": error,
                    "next_run_at": next_run_at,
                },
                reference=True,
            )

    async def create_coverage_draft(
        self,
        ctx: Context,
        *,
        run_id: UUID,
        target: ResearchTarget,
        extraction: CoverageExtraction,
        source_url: str,
        content_hash: str,
    ) -> UUID:
        async with self._db.scoped(ctx) as sc:
            row = await sc.fetch_one(
                """
                insert into public.research_drafts (
                  run_id, target_id, kind, plan_id, facility_id, insurer_provider_id,
                  service_id, insurance_category, coverage_status, benefit_type,
                  benefit_value, annual_limit, waiting_period_days, requires_preauth,
                  source_type, source_url, evidence_quote, content_hash, confidence
                ) values (
                  %(run_id)s, %(target_id)s, 'coverage', %(plan_id)s, null, null,
                  %(service_id)s, %(category)s, %(status)s, %(benefit_type)s,
                  %(benefit_value)s, %(annual_limit)s, %(waiting)s, %(preauth)s,
                  %(source_type)s, %(source_url)s, %(quote)s, %(content_hash)s, %(confidence)s
                )
                returning id
                """,
                {
                    "run_id": run_id,
                    "target_id": target.id,
                    "plan_id": target.plan_id,
                    "service_id": target.service_id,
                    "category": target.insurance_category,
                    "status": extraction.coverage_status.value,
                    "benefit_type": extraction.benefit_type,
                    "benefit_value": extraction.benefit_value,
                    "annual_limit": extraction.annual_limit,
                    "waiting": extraction.waiting_period_days,
                    "preauth": extraction.requires_preauth,
                    "source_type": target.source_type.value,
                    "source_url": source_url,
                    "quote": extraction.evidence_quote,
                    "content_hash": content_hash,
                    "confidence": extraction.confidence,
                },
                reference=True,
            )
        if not row:
            raise RuntimeError("coverage draft was not created")
        return UUID(str(row["id"]))

    async def create_acceptance_draft(
        self,
        ctx: Context,
        *,
        run_id: UUID,
        target: ResearchTarget,
        extraction: AcceptanceExtraction,
        source_url: str,
        content_hash: str,
    ) -> UUID:
        async with self._db.scoped(ctx) as sc:
            row = await sc.fetch_one(
                """
                insert into public.research_drafts (
                  run_id, target_id, kind, facility_id, insurer_provider_id,
                  service_id, insurance_category, accepted, claim_mode,
                  source_type, source_url, evidence_quote, content_hash, confidence
                ) values (
                  %(run_id)s, %(target_id)s, 'acceptance', %(facility_id)s,
                  %(insurer)s, %(service_id)s, %(category)s, %(accepted)s, %(claim_mode)s,
                  %(source_type)s, %(source_url)s, %(quote)s, %(content_hash)s, %(confidence)s
                )
                returning id
                """,
                {
                    "run_id": run_id,
                    "target_id": target.id,
                    "facility_id": target.facility_id,
                    "insurer": target.insurer_provider_id,
                    "service_id": target.service_id,
                    "category": target.insurance_category,
                    "accepted": extraction.accepted,
                    "claim_mode": extraction.claim_mode.value,
                    "source_type": target.source_type.value,
                    "source_url": source_url,
                    "quote": extraction.evidence_quote,
                    "content_hash": content_hash,
                    "confidence": extraction.confidence,
                },
                reference=True,
            )
        if not row:
            raise RuntimeError("acceptance draft was not created")
        return UUID(str(row["id"]))

    async def list_drafts(
        self, ctx: Context, *, status: str | None, limit: int
    ) -> list[ResearchDraftSummary]:
        async with self._db.scoped(ctx) as sc:
            rows = await sc.fetch_all(
                """
                select id, kind, status, plan_id, facility_id, insurer_provider_id,
                       service_id, insurance_category, coverage_status, accepted,
                       claim_mode, source_type, source_url, evidence_quote, confidence,
                       created_at
                  from public.research_drafts
                 where (%(status)s::text is null or status = %(status)s)
                 order by created_at desc, id
                 limit %(limit)s
                """,
                {"status": status, "limit": limit},
                reference=True,
            )
        return [_draft(row) for row in rows]

    async def approve_draft(self, ctx: Context, *, draft_id: UUID, valid_from: date) -> UUID:
        async with self._db.scoped(ctx) as sc:
            row = await sc.fetch_one(
                "select public.approve_research_draft(%(draft_id)s, %(valid_from)s) as id",
                {"draft_id": draft_id, "valid_from": valid_from},
                reference=False,
            )
        if not row:
            raise RuntimeError("research draft was not approved")
        return UUID(str(row["id"]))

    async def reject_draft(self, ctx: Context, *, draft_id: UUID, reason: str | None) -> None:
        async with self._db.scoped(ctx) as sc:
            await sc.execute(
                "select public.reject_research_draft(%(draft_id)s, %(reason)s)",
                {"draft_id": draft_id, "reason": reason},
                reference=False,
            )
