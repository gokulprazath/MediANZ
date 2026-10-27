"""Run one scheduled insurance-research batch.

Example:
    uv run python -m healthmcp.discovery.research_job --limit 10
    uv run python -m healthmcp.discovery.research_job --category major_dental --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid

from healthmcp.discovery.models import ResearchRefreshRequest, ResearchRunSummary
from healthmcp.discovery.research import OpenAIResearchExtractor, ResearchWorker
from healthmcp.discovery.research_repository import PgResearchRepository
from healthmcp.shared.config import Settings, load_settings
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database
from healthmcp.shared.engines.registry import EngineRegistry
from healthmcp.shared.guards import DomainAllowlist
from healthmcp.shared.repositories.model_registry import PgModelRegistryRepository


async def run(settings: Settings, request: ResearchRefreshRequest) -> ResearchRunSummary:
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required")
    database = Database.create(
        settings.database_url.get_secret_value(),
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
    )
    await database.open()
    try:
        registry = EngineRegistry(settings, PgModelRegistryRepository(database))
        search = (await registry.search()).engine
        worker = ResearchWorker(
            PgResearchRepository(database),
            search,
            OpenAIResearchExtractor(settings),
            DomainAllowlist(settings.research_domains),
        )
        ctx = Context(
            mode="job",
            agent_id="research-job",
            request_id=str(uuid.uuid4()),
            job_id=f"research-{uuid.uuid4()}",
        )
        return await worker.refresh(ctx, request)
    finally:
        await database.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--plan", action="append", default=[], help="plan id (repeatable)")
    parser.add_argument("--category", help="insurance category, e.g. major_dental")
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--no-fallback", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        request = ResearchRefreshRequest(
            plan_ids=tuple(uuid.UUID(value) for value in args.plan),
            insurance_category=args.category,
            limit=args.limit,
            include_fallback=not args.no_fallback,
            dry_run=args.dry_run,
        )
        summary = asyncio.run(run(load_settings(), request))
    except Exception as exc:
        print(f"research failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary.model_dump(mode="json"), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
