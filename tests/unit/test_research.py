"""Research worker: no patient path, exact quotes, pending drafts only."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest

from healthmcp.discovery.errors import ResearchUnavailable
from healthmcp.discovery.models import (
    AcceptanceExtraction,
    ClaimMode,
    CoverageExtraction,
    CoverageStatus,
    ResearchRefreshRequest,
    ResearchTarget,
    SourceType,
)
from healthmcp.discovery.research import ResearchWorker
from healthmcp.shared.context import Context
from healthmcp.shared.engines.models import EngineInfo, ExtractedPage, SearchResult
from healthmcp.shared.guards import DomainAllowlist

TARGET = ResearchTarget(
    id=UUID("a0000000-0000-4000-8000-000000000001"),
    target_type="plan_coverage",
    plan_id=UUID("21000000-0000-4000-8000-000000000002"),
    service_id=UUID("70000000-0000-4000-8000-000000000004"),
    insurance_category="major_dental",
    source_type=SourceType.PRIVATEHEALTH,
    plan_name="Silver Plus Combined",
    service_name="Root canal treatment",
)
RUN = UUID("b0000000-0000-4000-8000-000000000001")
DRAFT = UUID("c0000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 10, 27, tzinfo=UTC)
TEXT = "Major dental is covered at 60% after a 12-month wait. Annual limit $1,200."


def job_context() -> Context:
    return Context(
        mode="job",
        agent_id="research-refresh",
        request_id="request-1",
        job_id="job-1",
    )


class FakeSearch:
    info = EngineInfo(engine="fake_search", provider="test", model="fixture", model_version="1")

    def __init__(
        self, *, results: list[SearchResult] | None = None, pages: list[ExtractedPage] | None = None
    ) -> None:
        self.results = (
            results
            if results is not None
            else [
                SearchResult(
                    url="https://www.privatehealth.gov.au/plan/silver-plus",
                    title="Silver Plus",
                    content="excerpt",
                )
            ]
        )
        self.pages = (
            pages
            if pages is not None
            else [
                ExtractedPage(
                    url=self.results[0].url
                    if self.results
                    else "https://www.privatehealth.gov.au/",
                    content=TEXT,
                )
            ]
        )
        self.searches: list[tuple[str, tuple[str, ...], int]] = []
        self.extracts: list[list[str]] = []

    async def search(self, query: str, domains: Any, max_results: int = 5) -> list[SearchResult]:
        self.searches.append((query, tuple(domains), max_results))
        return self.results

    async def extract(self, urls: Any) -> list[ExtractedPage]:
        self.extracts.append(list(urls))
        return self.pages


class FakeExtractor:
    def __init__(
        self, *, quote: str = "Major dental is covered at 60% after a 12-month wait."
    ) -> None:
        self.quote = quote
        self.calls: list[tuple[str, str]] = []

    async def coverage(self, *, text: str, context: str) -> CoverageExtraction:
        self.calls.append(("coverage", context))
        return CoverageExtraction(
            coverage_status=CoverageStatus.PARTIALLY_COVERED,
            benefit_type="percent",
            benefit_value=60,
            annual_limit=1200,
            waiting_period_days=365,
            requires_preauth=True,
            evidence_quote=self.quote,
            confidence=0.9,
        )

    async def acceptance(self, *, text: str, context: str) -> AcceptanceExtraction:
        self.calls.append(("acceptance", context))
        return AcceptanceExtraction(
            accepted=True,
            claim_mode=ClaimMode.DIRECT,
            evidence_quote=self.quote,
            confidence=0.9,
        )


class FakeResearchRepository:
    def __init__(self, targets: list[ResearchTarget] | None = None) -> None:
        self.targets = targets if targets is not None else [TARGET]
        self.finished: list[dict[str, Any]] = []
        self.marked: list[dict[str, Any]] = []
        self.coverage_drafts: list[dict[str, Any]] = []
        self.acceptance_drafts: list[dict[str, Any]] = []
        self.started: list[dict[str, Any]] = []

    async def list_targets(
        self, ctx: Context, *, plan_ids: Any, insurance_category: Any, limit: int
    ):
        return self.targets[:limit]

    async def start_run(
        self, ctx: Context, *, target: ResearchTarget, source_url: str | None
    ) -> UUID:
        self.started.append({"target": target, "source_url": source_url})
        return RUN

    async def finish_run(self, ctx: Context, **kwargs: Any) -> None:
        self.finished.append(kwargs)

    async def mark_target(self, ctx: Context, **kwargs: Any) -> None:
        self.marked.append(kwargs)

    async def create_coverage_draft(self, ctx: Context, **kwargs: Any) -> UUID:
        self.coverage_drafts.append(kwargs)
        return DRAFT

    async def create_acceptance_draft(self, ctx: Context, **kwargs: Any) -> UUID:
        self.acceptance_drafts.append(kwargs)
        return DRAFT


def worker(
    repository: FakeResearchRepository,
    *,
    search: FakeSearch | None = None,
    extractor: FakeExtractor | None = None,
) -> ResearchWorker:
    return ResearchWorker(
        repository,  # type: ignore[arg-type]
        search or FakeSearch(),  # type: ignore[arg-type]
        extractor or FakeExtractor(),
        DomainAllowlist(("privatehealth.gov.au",)),
        clock=lambda: NOW,
    )


@pytest.mark.asyncio
async def test_refresh_creates_a_pending_coverage_draft_with_an_exact_quote() -> None:
    repository = FakeResearchRepository()
    extractor = FakeExtractor()
    service = worker(repository, extractor=extractor)

    summary = await service.refresh(job_context(), ResearchRefreshRequest(limit=5))

    assert summary.status == "ok"
    assert summary.targets == 1
    assert summary.pages_fetched == 1
    assert summary.drafts_created == 1
    assert summary.errors == 0
    draft = repository.coverage_drafts[0]
    assert draft["run_id"] == RUN
    assert draft["extraction"].evidence_quote in TEXT
    assert draft["source_url"] == "https://www.privatehealth.gov.au/plan/silver-plus"
    assert draft["content_hash"] == hashlib.sha256(TEXT.encode()).hexdigest()
    assert repository.finished[0]["status"] == "ok"
    assert repository.marked[0]["status"] == "ok"
    assert repository.marked[0]["next_run_at"] == NOW + timedelta(days=1)
    assert extractor.calls[0][0] == "coverage"


@pytest.mark.asyncio
async def test_unlisted_source_is_blocked_without_a_draft() -> None:
    repository = FakeResearchRepository()
    search = FakeSearch(
        results=[
            SearchResult(
                url="https://not-allowed.example.com/plan",
                title="Plan",
                content="excerpt",
            )
        ]
    )
    service = worker(repository, search=search)

    summary = await service.refresh(job_context(), ResearchRefreshRequest())

    assert summary.status == "partial"
    assert summary.drafts_created == 0
    assert summary.errors == 1
    assert repository.coverage_drafts == []
    assert repository.finished[0]["status"] == "blocked"
    assert repository.marked[0]["status"] == "blocked"


@pytest.mark.asyncio
async def test_quote_that_is_not_in_the_page_is_blocked() -> None:
    repository = FakeResearchRepository()
    service = worker(repository, extractor=FakeExtractor(quote="A quote that was invented"))

    summary = await service.refresh(job_context(), ResearchRefreshRequest())

    assert summary.errors == 1
    assert repository.coverage_drafts == []
    assert repository.finished[0]["status"] == "blocked"
    assert "Coverage quote" in repository.finished[0]["notes"][0]


@pytest.mark.asyncio
async def test_dry_run_does_not_search_or_write() -> None:
    repository = FakeResearchRepository()
    search = FakeSearch()
    service = worker(repository, search=search)

    summary = await service.refresh(job_context(), ResearchRefreshRequest(dry_run=True))

    assert summary.targets == 1
    assert summary.pages_fetched == 0
    assert summary.drafts_created == 0
    assert search.searches == []
    assert repository.started == []
    assert repository.coverage_drafts == []


@pytest.mark.asyncio
async def test_user_context_cannot_run_research() -> None:
    repository = FakeResearchRepository()
    service = worker(repository)
    user = Context.for_user(
        agent_id="clinic-concierge",
        request_id="request-1",
        user_id=UUID("10000000-0000-4000-8000-000000000001"),
        claims={"sub": "10000000-0000-4000-8000-000000000001"},
    )

    with pytest.raises(ResearchUnavailable):
        await service.refresh(user, ResearchRefreshRequest())


@pytest.mark.asyncio
async def test_fallback_sources_are_only_used_when_enabled() -> None:
    search = FakeSearch(
        results=[
            SearchResult(
                url="https://www.bupa.com.au/cover/extras",
                title="Extras cover",
                content="excerpt",
            )
        ],
        pages=[ExtractedPage(url="https://www.bupa.com.au/cover/extras", content=TEXT)],
    )
    repository = FakeResearchRepository()
    service = ResearchWorker(
        repository,  # type: ignore[arg-type]
        search,  # type: ignore[arg-type]
        FakeExtractor(),  # type: ignore[arg-type]
        DomainAllowlist(("privatehealth.gov.au", "bupa.com.au")),
        clock=lambda: NOW,
    )

    blocked = await service.refresh(job_context(), ResearchRefreshRequest(include_fallback=False))

    assert blocked.errors == 1
    assert repository.coverage_drafts == []

    allowed = await service.refresh(job_context(), ResearchRefreshRequest(include_fallback=True))

    assert allowed.status == "ok"
    assert repository.coverage_drafts[0]["target"].source_type is SourceType.INSURER_SITE
