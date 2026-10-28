"""Process approved consult transcripts into draft facts and key points.

Approving a transcript queues a consult_note_runs row (database trigger); this
worker claims queued runs one at a time and processes them.

Examples:
    uv run python -m healthmcp.consult_notes.worker                  # run until stopped
    uv run python -m healthmcp.consult_notes.worker --once           # drain the queue, exit
    uv run python -m healthmcp.consult_notes.worker --appointment <uuid>   # re-run one consult
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import uuid
from uuid import UUID

from healthmcp.consult_notes.models import RunSummary
from healthmcp.consult_notes.repository import ConsultNotesRepository, PgConsultNotesRepository
from healthmcp.consult_notes.service import ConsultNotesWorker
from healthmcp.shared.config import Settings, load_settings
from healthmcp.shared.db import Database
from healthmcp.shared.engines.registry import EngineRegistry
from healthmcp.shared.logging import configure_logging
from healthmcp.shared.repositories.audit import PgAuditRepository
from healthmcp.shared.repositories.model_registry import PgModelRegistryRepository

logger = logging.getLogger("healthmcp.consult_notes")


async def drain(
    worker: ConsultNotesWorker,
    repository: ConsultNotesRepository,
    *,
    max_attempts: int,
    appointment_id: UUID | None = None,
    limit: int | None = None,
) -> list[RunSummary]:
    """Claim and process runs until the queue is empty (or `limit` runs)."""
    summaries: list[RunSummary] = []
    while limit is None or len(summaries) < limit:
        run = await repository.claim_run(
            worker.dispatcher_context(), max_attempts=max_attempts, appointment_id=appointment_id
        )
        if run is None:
            break
        summaries.append(await worker.handle(run))
    return summaries


async def run(
    settings: Settings, *, once: bool = False, appointment_id: UUID | None = None
) -> list[RunSummary]:
    if settings.database_url is None:
        raise RuntimeError("DATABASE_URL is required")
    database = Database.create(
        settings.database_url.get_secret_value(),
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
    )
    await database.open()
    try:
        repository = PgConsultNotesRepository(database)
        worker = ConsultNotesWorker(
            repository,
            EngineRegistry(settings, PgModelRegistryRepository(database)),
            PgAuditRepository(database),
            window_segments=settings.consult_notes_window_segments,
            concurrency=settings.consult_notes_concurrency,
            review_below=settings.decision_review_below,
        )
        max_attempts = settings.consult_worker_max_attempts
        if appointment_id is not None:
            await repository.requeue(worker.appointment_context(appointment_id))
            return await drain(
                worker, repository, max_attempts=max_attempts, appointment_id=appointment_id
            )
        if once:
            return await drain(worker, repository, max_attempts=max_attempts)

        logger.info("consult notes worker started")
        while True:
            try:
                await drain(worker, repository, max_attempts=max_attempts)
            except Exception:
                # e.g. the database is unreachable: log (type only) and try again later.
                logger.exception("consult notes poll failed")
            await asyncio.sleep(settings.consult_worker_poll_seconds)
    finally:
        await database.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--once", action="store_true", help="drain the queue, then exit")
    parser.add_argument("--appointment", help="re-queue and process one appointment, then exit")
    return parser


def main() -> int:
    args = _parser().parse_args()
    settings = load_settings()
    configure_logging(settings.log_level, log_dir=settings.log_dir, name="consult-worker")
    try:
        appointment_id = uuid.UUID(args.appointment) if args.appointment else None
        summaries = asyncio.run(run(settings, once=args.once, appointment_id=appointment_id))
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        print(f"consult notes worker failed: {type(exc).__name__}", file=sys.stderr)
        return 1
    print(json.dumps([s.model_dump(mode="json") for s in summaries], indent=2))
    return 1 if any(s.status == "failed" for s in summaries) else 0


if __name__ == "__main__":
    raise SystemExit(main())
