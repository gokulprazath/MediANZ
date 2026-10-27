"""FastAPI application for clinic discovery, insurance checks and booking."""

from __future__ import annotations

import logging
import uuid
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import date
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from healthmcp.discovery.errors import (
    DiscoveryError,
    NeedsServiceClarification,
    QuoteChanged,
)
from healthmcp.discovery.models import (
    AppointmentSummary,
    ApprovedResearchDraft,
    ApproveResearchDraftRequest,
    AvailabilitySlot,
    BookingRequest,
    BookingResponse,
    CancelAppointmentRequest,
    DiscoveryRequest,
    DiscoveryResponse,
    DocumentRegisterRequest,
    InsuranceCheckRequest,
    InsuranceCheckResponse,
    InsuranceDocument,
    RejectResearchDraftRequest,
    ResearchDraftSummary,
    Service,
    SlotHoldRequest,
    SlotHoldResponse,
)
from healthmcp.discovery.repository import DiscoveryRepository, PgDiscoveryRepository
from healthmcp.discovery.research_admin import ResearchAdminService
from healthmcp.discovery.research_repository import (
    PgResearchRepository,
    ResearchRepository,
)
from healthmcp.discovery.service import DiscoveryService
from healthmcp.shared.auth import AuthError, TokenVerifier, VerifiedUser
from healthmcp.shared.config import Settings, load_settings
from healthmcp.shared.context import Context
from healthmcp.shared.db import Database
from healthmcp.shared.errors import HealthMcpError
from healthmcp.shared.repositories.identity import IdentityRepository, PgIdentityRepository

logger = logging.getLogger("healthmcp.discovery")

DEFAULT_AGENT_ID = "clinic-concierge"


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    database: Database | None = getattr(app.state, "database", None)
    owned = database is None
    if database is None:
        if settings.database_url is None:
            raise RuntimeError("DATABASE_URL is required")
        database = Database.create(
            settings.database_url.get_secret_value(),
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
        )
        await database.open()
        app.state.database = database
    if getattr(app.state, "discovery", None) is None:
        app.state.discovery = DiscoveryService(PgDiscoveryRepository(database))
    if getattr(app.state, "identity", None) is None:
        app.state.identity = PgIdentityRepository(database)
    if getattr(app.state, "research_admin", None) is None:
        app.state.research_admin = ResearchAdminService(PgResearchRepository(database))
    if getattr(app.state, "verifier", None) is None:
        app.state.verifier = TokenVerifier(settings)
    try:
        yield
    finally:
        if owned:
            await database.close()


def create_app(
    *,
    settings: Settings | None = None,
    database: Database | None = None,
    repository: DiscoveryRepository | None = None,
    identity: IdentityRepository | None = None,
    verifier: TokenVerifier | None = None,
    research_repository: ResearchRepository | None = None,
) -> FastAPI:
    app = FastAPI(title="MediANZ Discovery", version="1.0.0", lifespan=_lifespan)
    app.state.settings = settings or load_settings()
    app.state.database = database
    app.state.discovery = DiscoveryService(repository) if repository is not None else None
    app.state.identity = identity
    app.state.verifier = verifier
    app.state.research_admin = (
        ResearchAdminService(research_repository) if research_repository is not None else None
    )

    @app.exception_handler(DiscoveryError)
    async def _discovery_error(_: Request, exc: DiscoveryError) -> JSONResponse:
        payload: dict[str, Any] = {"error": exc.code, "message": str(exc)}
        if isinstance(exc, NeedsServiceClarification):
            payload["candidates"] = [
                {
                    "code": candidate.code,
                    "name": candidate.name,
                    "category": candidate.category,
                }
                for candidate in exc.candidates
            ]
        if isinstance(exc, QuoteChanged):
            payload["expected_gap"] = (
                str(exc.expected_gap) if exc.expected_gap is not None else None
            )
            payload["current_gap"] = str(exc.current_gap) if exc.current_gap is not None else None
        return JSONResponse(payload, status_code=exc.status_code)

    @app.exception_handler(HealthMcpError)
    async def _shared_error(_: Request, exc: HealthMcpError) -> JSONResponse:
        status = 403 if exc.code in {"scope_violation", "agent_not_allowed"} else 400
        if exc.code == "not_authenticated":
            status = 401
        return JSONResponse({"error": exc.code, "message": exc.public_message}, status_code=status)

    async def get_context(request: Request) -> Context:
        auth = request.headers.get("authorization", "")
        scheme, _, token = auth.partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")
        try:
            verified = await request.app.state.verifier.verify(token.strip())
        except AuthError as exc:
            logger.info("authentication failed", extra={"reason": exc.reason})
            raise HTTPException(status_code=401, detail="UNAUTHORIZED") from exc
        if not isinstance(verified, VerifiedUser):
            raise HTTPException(status_code=403, detail="USER_TOKEN_REQUIRED")
        agent_id = request.headers.get("x-agent-id", DEFAULT_AGENT_ID).strip()[:64]
        ctx = Context.for_user(
            agent_id=agent_id or DEFAULT_AGENT_ID,
            request_id=str(uuid.uuid4()),
            user_id=verified.user_id,
            claims=verified.claims,
        )
        patient_id = await request.app.state.identity.resolve_patient_id(ctx)
        return replace(ctx, patient_id=patient_id)

    def get_research_admin(request: Request) -> ResearchAdminService:
        service: ResearchAdminService | None = request.app.state.research_admin
        if service is None:
            raise HTTPException(status_code=503, detail="RESEARCH_ADMIN_UNAVAILABLE")
        return service

    async def get_staff_context(request: Request) -> Context:
        auth = request.headers.get("authorization", "")
        scheme, _, token = auth.partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")
        try:
            verified = await request.app.state.verifier.verify(token.strip())
        except AuthError as exc:
            logger.info("authentication failed", extra={"reason": exc.reason})
            raise HTTPException(status_code=401, detail="UNAUTHORIZED") from exc
        if not isinstance(verified, VerifiedUser):
            raise HTTPException(status_code=403, detail="USER_TOKEN_REQUIRED")
        metadata = verified.claims.get("app_metadata")
        if not isinstance(metadata, Mapping) or metadata.get("role") not in {
            "staff",
            "admin",
        }:
            raise HTTPException(status_code=403, detail="STAFF_REQUIRED")
        agent_id = request.headers.get("x-agent-id", "staff-admin").strip()[:64]
        return Context.for_user(
            agent_id=agent_id or "staff-admin",
            request_id=str(uuid.uuid4()),
            user_id=verified.user_id,
            claims=verified.claims,
        )

    def get_discovery(request: Request) -> DiscoveryService:
        service: DiscoveryService | None = request.app.state.discovery
        if service is None:
            raise RuntimeError("discovery service is not configured")
        return service

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/services", response_model=list[Service])
    async def list_services(
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> list[Service]:
        return await service.list_services(ctx)

    @app.post("/v1/discovery", response_model=DiscoveryResponse)
    async def discover(
        body: DiscoveryRequest,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> DiscoveryResponse:
        return await service.discover(ctx, body)

    @app.get("/v1/availability", response_model=list[AvailabilitySlot])
    async def availability(
        on_date: date = Query(alias="date"),
        facility_id: uuid.UUID | None = None,
        clinician_id: uuid.UUID | None = None,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> list[AvailabilitySlot]:
        return await service.availability(
            ctx, on_date=on_date, facility_id=facility_id, clinician_id=clinician_id
        )

    @app.post("/v1/insurance/check", response_model=InsuranceCheckResponse)
    async def check_insurance(
        body: InsuranceCheckRequest,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> InsuranceCheckResponse:
        return await service.check_insurance(ctx, body)

    @app.post("/v1/holds", response_model=SlotHoldResponse)
    async def hold(
        body: SlotHoldRequest,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> SlotHoldResponse:
        return await service.hold(ctx, body.slot_id)

    @app.post("/v1/bookings", response_model=BookingResponse, status_code=201)
    async def book(
        body: BookingRequest,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> BookingResponse:
        return await service.book(ctx, body)

    @app.get("/v1/bookings", response_model=list[AppointmentSummary])
    async def list_bookings(
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> list[AppointmentSummary]:
        return list(await service.list_appointments(ctx))

    @app.get("/v1/bookings/{appointment_id}", response_model=AppointmentSummary)
    async def get_booking(
        appointment_id: uuid.UUID,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> AppointmentSummary:
        return await service.get_appointment(ctx, appointment_id)

    @app.post("/v1/bookings/{appointment_id}/cancel", status_code=204)
    async def cancel_booking(
        appointment_id: uuid.UUID,
        body: CancelAppointmentRequest,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> None:
        await service.cancel(ctx, appointment_id, body.reason)

    @app.get("/v1/research/drafts", response_model=list[ResearchDraftSummary])
    async def list_research_drafts(
        status: Literal["pending", "approved", "rejected", "all"] = "pending",
        limit: int = Query(default=50, ge=1, le=200),
        ctx: Context = Depends(get_staff_context),
        admin: ResearchAdminService = Depends(get_research_admin),
    ) -> list[ResearchDraftSummary]:
        return await admin.list_drafts(ctx, status=None if status == "all" else status, limit=limit)

    @app.post(
        "/v1/research/drafts/{draft_id}/approve",
        response_model=ApprovedResearchDraft,
    )
    async def approve_research_draft(
        draft_id: uuid.UUID,
        body: ApproveResearchDraftRequest | None = None,
        ctx: Context = Depends(get_staff_context),
        admin: ResearchAdminService = Depends(get_research_admin),
    ) -> ApprovedResearchDraft:
        return await admin.approve(ctx, draft_id, valid_from=body.valid_from if body else None)

    @app.post("/v1/research/drafts/{draft_id}/reject", status_code=204)
    async def reject_research_draft(
        draft_id: uuid.UUID,
        body: RejectResearchDraftRequest | None = None,
        ctx: Context = Depends(get_staff_context),
        admin: ResearchAdminService = Depends(get_research_admin),
    ) -> None:
        await admin.reject(ctx, draft_id, reason=body.reason if body else None)

    @app.post("/v1/insurance/documents", response_model=InsuranceDocument, status_code=201)
    async def register_document(
        body: DocumentRegisterRequest,
        ctx: Context = Depends(get_context),
        service: DiscoveryService = Depends(get_discovery),
    ) -> InsuranceDocument:
        return await service.register_document(ctx, body)

    return app


app = create_app()
