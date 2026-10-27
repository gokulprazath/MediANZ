"""Staff review of pending research drafts."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, date, datetime
from uuid import UUID

from healthmcp.discovery.models import (
    ApprovedResearchDraft,
    ResearchDraftSummary,
)
from healthmcp.discovery.research_repository import ResearchRepository
from healthmcp.shared.context import Context


class ResearchAdminService:
    def __init__(
        self,
        repository: ResearchRepository,
        *,
        clock: Callable[[], date] | None = None,
    ) -> None:
        self._repo = repository
        self._today = clock or (lambda: datetime.now(UTC).date())

    async def list_drafts(
        self, ctx: Context, *, status: str | None, limit: int
    ) -> list[ResearchDraftSummary]:
        return await self._repo.list_drafts(ctx, status=status, limit=limit)

    async def approve(
        self, ctx: Context, draft_id: UUID, *, valid_from: date | None = None
    ) -> ApprovedResearchDraft:
        rule_id = await self._repo.approve_draft(
            ctx, draft_id=draft_id, valid_from=valid_from or self._today()
        )
        return ApprovedResearchDraft(draft_id=draft_id, rule_id=rule_id)

    async def reject(self, ctx: Context, draft_id: UUID, *, reason: str | None = None) -> None:
        await self._repo.reject_draft(ctx, draft_id=draft_id, reason=reason)
