"""Staff research review service and API wiring."""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, cast
from uuid import UUID

from fastapi.testclient import TestClient

from healthmcp.discovery.app import create_app
from healthmcp.discovery.models import ResearchDraftSummary, SourceType
from healthmcp.discovery.research_admin import ResearchAdminService
from healthmcp.shared.auth import AuthError, TokenVerifier, VerifiedUser
from tests.conftest import make_settings
from tests.unit.test_discovery import USER
from tests.unit.test_discovery_api import FakeIdentity, FakeRepository

DRAFT = UUID("c0000000-0000-4000-8000-000000000001")
RULE = UUID("d0000000-0000-4000-8000-000000000001")
TODAY = date(2026, 10, 27)


def draft() -> ResearchDraftSummary:
    return ResearchDraftSummary(
        id=DRAFT,
        kind="coverage",
        status="pending",
        plan_id=UUID("21000000-0000-4000-8000-000000000002"),
        service_id=UUID("70000000-0000-4000-8000-000000000004"),
        insurance_category="major_dental",
        coverage_status="partially_covered",
        source_type=SourceType.PRIVATEHEALTH,
        source_url="https://www.privatehealth.gov.au/plan/silver-plus",
        evidence_quote="Major dental is covered at 60% after a 12-month wait.",
        confidence=0.9,
        created_at=datetime(2026, 10, 27, tzinfo=UTC),
    )


class FakeResearchRepository:
    def __init__(self) -> None:
        self.listed: list[tuple[str | None, int]] = []
        self.approved: list[tuple[UUID, date]] = []
        self.rejected: list[tuple[UUID, str | None]] = []

    async def list_drafts(self, ctx: Any, *, status: str | None, limit: int):
        self.listed.append((status, limit))
        return [draft()]

    async def approve_draft(self, ctx: Any, *, draft_id: UUID, valid_from: date) -> UUID:
        self.approved.append((draft_id, valid_from))
        return RULE

    async def reject_draft(self, ctx: Any, *, draft_id: UUID, reason: str | None) -> None:
        self.rejected.append((draft_id, reason))


class FakeStaffVerifier:
    async def verify(self, token: str) -> VerifiedUser:
        if token not in {"staff", "admin", "user"}:
            raise AuthError("bad token")
        claims: dict[str, Any] = {"sub": str(USER), "role": "authenticated"}
        if token in {"staff", "admin"}:
            claims["app_metadata"] = {"role": token}
        return VerifiedUser(user_id=USER, claims=claims)


def client(repository: FakeResearchRepository) -> TestClient:
    app = create_app(
        settings=make_settings(),
        database=cast(Any, object()),
        repository=cast(Any, FakeRepository()),
        identity=cast(Any, FakeIdentity()),
        verifier=cast(TokenVerifier, FakeStaffVerifier()),
        research_repository=cast(Any, repository),
    )
    return TestClient(app)


def test_approve_defaults_to_the_injected_today() -> None:
    import asyncio

    repository = FakeResearchRepository()
    service = ResearchAdminService(cast(Any, repository), clock=lambda: TODAY)

    result = asyncio.run(
        service.approve(
            cast(Any, object()),
            DRAFT,
        )
    )

    assert result.rule_id == RULE
    assert repository.approved == [(DRAFT, TODAY)]


def test_staff_can_list_approve_and_reject_drafts() -> None:
    repository = FakeResearchRepository()
    with client(repository) as http:
        listed = http.get(
            "/v1/research/drafts",
            headers={"authorization": "Bearer staff"},
            params={"status": "all", "limit": 10},
        )
        approved = http.post(
            f"/v1/research/drafts/{DRAFT}/approve",
            headers={"authorization": "Bearer staff"},
            json={"valid_from": "2026-11-01"},
        )
        rejected = http.post(
            f"/v1/research/drafts/{DRAFT}/reject",
            headers={"authorization": "Bearer staff"},
            json={"reason": "Not the member's plan"},
        )

    assert listed.status_code == 200
    assert listed.json()[0]["id"] == str(DRAFT)
    assert repository.listed == [(None, 10)]
    assert approved.status_code == 200
    assert approved.json() == {"draft_id": str(DRAFT), "rule_id": str(RULE)}
    assert repository.approved == [(DRAFT, date(2026, 11, 1))]
    assert rejected.status_code == 204
    assert repository.rejected == [(DRAFT, "Not the member's plan")]


def test_admin_claim_can_review_drafts() -> None:
    repository = FakeResearchRepository()
    with client(repository) as http:
        response = http.get("/v1/research/drafts", headers={"authorization": "Bearer admin"})

    assert response.status_code == 200


def test_non_staff_cannot_review_drafts() -> None:
    repository = FakeResearchRepository()
    with client(repository) as http:
        response = http.get("/v1/research/drafts", headers={"authorization": "Bearer user"})

    assert response.status_code == 403
    assert response.json()["detail"] == "STAFF_REQUIRED"
    assert repository.listed == []


def test_staff_routes_require_a_token() -> None:
    repository = FakeResearchRepository()
    with client(repository) as http:
        response = http.get("/v1/research/drafts")

    assert response.status_code == 401
