"""Use-case orchestration for discovery, insurance checks and booking."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from uuid import UUID

from healthmcp.discovery.descriptions import describe_clinic
from healthmcp.discovery.errors import (
    NeedsServiceClarification,
    NotFound,
    QuoteChanged,
    ServiceNotFound,
)
from healthmcp.discovery.insurance import evaluate_insurance
from healthmcp.discovery.models import (
    AcceptanceRule,
    AppointmentSummary,
    AvailabilitySlot,
    BookingRequest,
    BookingResponse,
    BookingSlot,
    CoverageRule,
    DiscoveryRequest,
    DiscoveryResponse,
    DocumentRegisterRequest,
    InsuranceCheckRequest,
    InsuranceCheckResponse,
    InsuranceDocument,
    InsuranceResult,
    PolicyContext,
    Service,
    SlotHoldResponse,
)
from healthmcp.discovery.repository import DiscoveryRepository
from healthmcp.discovery.scoring import RANKING_VERSION, rank_clinics
from healthmcp.shared.context import Context

_DEFAULT_WINDOW_DAYS = 30
_TOP_CATEGORY_RESULTS = 10


def _today() -> date:
    return datetime.now(UTC).date()


def _end_of_day(day: date) -> datetime:
    return datetime.combine(day, time.max, tzinfo=UTC)


class DiscoveryService:
    def __init__(self, repository: DiscoveryRepository) -> None:
        self._repo = repository

    async def list_services(self, ctx: Context) -> list[Service]:
        return await self._repo.list_services(ctx)

    async def _resolve(self, ctx: Context, code: str | None, text: str | None) -> Service:
        service, candidates = await self._repo.resolve_service(ctx, code, text)
        if service is not None:
            return service
        if code and text:
            service, candidates = await self._repo.resolve_service(ctx, None, text)
            if service is not None:
                return service
        if candidates:
            raise NeedsServiceClarification(tuple(candidates))
        raise ServiceNotFound()

    async def discover(self, ctx: Context, request: DiscoveryRequest) -> DiscoveryResponse:
        ctx.require_patient()
        service = await self._resolve(ctx, request.service_code, request.problem_text)
        today = _today()
        date_from = request.date_from or today
        date_to = request.date_to or today + timedelta(days=_DEFAULT_WINDOW_DAYS)

        preferences = await self._repo.fetch_preferences(ctx)
        radius = request.max_distance_km
        if preferences.max_distance_km is not None:
            radius = min(radius, float(preferences.max_distance_km))

        policy = await self._repo.fetch_policy(ctx, date_from)
        coverage_rules = (
            await self._repo.fetch_coverage_rules(
                ctx,
                policy=policy,
                service=service,
                on_date=date_from,
                through=date_to,
            )
            if policy
            else ()
        )

        rows = await self._repo.fetch_candidates(
            ctx,
            service=service,
            latitude=request.latitude,
            longitude=request.longitude,
            radius_km=radius,
            date_from=date_from,
            date_to=date_to,
            max_candidates=1000,
        )
        facility_ids = list(dict.fromkeys(row.facility_id for row in rows))
        acceptances = (
            await self._repo.fetch_acceptances(
                ctx,
                facility_ids=facility_ids,
                policy=policy,
                service=service,
                on_date=date_from,
                through=date_to,
            )
            if policy
            else {}
        )

        cards, total, rankings = rank_clinics(
            service=service,
            rows=rows,
            coverage_rules=coverage_rules,
            acceptances=acceptances,
            policy=policy,
            preferences=preferences,
            radius_km=radius,
            date_to=_end_of_day(date_to),
            limit=request.limit,
        )
        cards = [
            card.model_copy(update={"agent_description": describe_clinic(card, service)})
            for card in cards
        ]

        return DiscoveryResponse(
            request_id=ctx.request_id,
            generated_at=datetime.now(UTC),
            service=service,
            search_radius_km=radius,
            candidate_count=total,
            returned_count=len(cards),
            ranking_version=RANKING_VERSION,
            category_rankings={
                category: ids[:_TOP_CATEGORY_RESULTS] for category, ids in rankings.items()
            },
            clinics=tuple(cards),
        )

    async def _policy_for(self, ctx: Context, on_date: date) -> PolicyContext | None:
        return await self._repo.fetch_policy(ctx, on_date)

    async def _quote(
        self,
        ctx: Context,
        *,
        service: Service,
        facility_id: UUID,
        clinician_id: UUID | None,
        on_date: date,
    ) -> InsuranceResult:
        policy = await self._policy_for(ctx, on_date)
        coverage_rules = (
            await self._repo.fetch_coverage_rules(
                ctx, policy=policy, service=service, on_date=on_date
            )
            if policy
            else ()
        )
        if policy:
            acceptance_rules = (
                await self._repo.fetch_acceptances(
                    ctx,
                    facility_ids=[facility_id],
                    policy=policy,
                    service=service,
                    on_date=on_date,
                )
            ).get(facility_id, ())
        else:
            acceptance_rules = ()
        fee, rebate = await self._repo.service_fee(
            ctx,
            facility_id=facility_id,
            service=service,
            on_date=on_date,
            clinician_id=clinician_id,
        )
        return evaluate_insurance(
            service=service,
            appointment_date=on_date,
            policy=policy,
            fee=fee,
            medicare_rebate=rebate,
            coverage_rules=coverage_rules,
            acceptance_rules=acceptance_rules,
        )

    async def check_insurance(
        self, ctx: Context, request: InsuranceCheckRequest
    ) -> InsuranceCheckResponse:
        ctx.require_patient()
        service = await self._resolve(ctx, request.service_code, None)
        if not await self._repo.facility_exists(ctx, request.facility_id):
            raise NotFound("Facility not found")
        on_date = request.appointment_date or _today()
        fee, rebate = await self._repo.service_fee(
            ctx, facility_id=request.facility_id, service=service, on_date=on_date
        )
        if request.fee is not None:
            fee = request.fee
            rebate = min(rebate or Decimal("0.00"), fee)
        policy = await self._policy_for(ctx, on_date)
        if policy is None:
            # Still return a deterministic NO_POLICY result, not an error.
            coverage_rules: tuple[CoverageRule, ...] = ()
            acceptance_rules: tuple[AcceptanceRule, ...] = ()
        else:
            coverage_rules = await self._repo.fetch_coverage_rules(
                ctx, policy=policy, service=service, on_date=on_date
            )
            acceptance_rules = (
                await self._repo.fetch_acceptances(
                    ctx,
                    facility_ids=[request.facility_id],
                    policy=policy,
                    service=service,
                    on_date=on_date,
                )
            ).get(request.facility_id, ())
        return InsuranceCheckResponse(
            service=service,
            facility_id=request.facility_id,
            insurance=evaluate_insurance(
                service=service,
                appointment_date=on_date,
                policy=policy,
                fee=fee,
                medicare_rebate=rebate,
                coverage_rules=coverage_rules,
                acceptance_rules=acceptance_rules,
            ),
        )

    async def availability(
        self,
        ctx: Context,
        *,
        on_date: date,
        facility_id: UUID | None = None,
        clinician_id: UUID | None = None,
    ) -> list[AvailabilitySlot]:
        ctx.require_patient()
        return await self._repo.fetch_availability(
            ctx, on_date=on_date, facility_id=facility_id, clinician_id=clinician_id
        )

    async def hold(self, ctx: Context, slot_id: UUID) -> SlotHoldResponse:
        ctx.require_patient()
        held_until = await self._repo.hold_slot(ctx, slot_id)
        return SlotHoldResponse(slot_id=slot_id, held_until=held_until)

    async def book(self, ctx: Context, request: BookingRequest) -> BookingResponse:
        ctx.require_patient()
        slot = await self._repo.get_slot(ctx, request.slot_id)
        if slot is None:
            raise NotFound("Slot not found")
        service = await self._resolve(ctx, request.service_code, None)
        insurance = await self._quote(
            ctx,
            service=service,
            facility_id=slot.facility_id,
            clinician_id=slot.clinician_id,
            on_date=slot.local_date,
        )
        if request.expected_fee is not None and insurance.fee != request.expected_fee:
            raise QuoteChanged(request.expected_fee, insurance.fee)
        if request.expected_gap is not None and insurance.gap != request.expected_gap:
            raise QuoteChanged(request.expected_gap, insurance.gap)

        appointment_id = await self._repo.book_slot(
            ctx,
            slot_id=slot.slot_id,
            service=service,
            reason=request.reason,
            idempotency_key=request.idempotency_key,
            expected_fee=insurance.fee,
            expected_gap=insurance.gap,
            quoted_medicare_rebate=insurance.medicare_rebate,
            quoted_insurance_benefit=insurance.insurance_benefit,
            coverage_status=insurance.coverage_status,
            claim_mode=insurance.claim_mode,
            verification_level=insurance.verification_level,
        )
        appointment = await self._repo.get_appointment(ctx, appointment_id)
        return BookingResponse(
            appointment_id=appointment.appointment_id,
            status=appointment.status,
            scheduled_start=appointment.scheduled_start,
            facility_id=appointment.facility_id,
            clinician_id=appointment.clinician_id,
            service_code=appointment.service_code or service.code,
            quoted_fee=appointment.quoted_fee,
            quoted_gap=appointment.quoted_gap,
            coverage_status=insurance.coverage_status,
            claim_mode=insurance.claim_mode,
        )

    async def get_appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentSummary:
        ctx.require_patient()
        return await self._repo.get_appointment(ctx, appointment_id)

    async def list_appointments(self, ctx: Context) -> list[AppointmentSummary]:
        ctx.require_patient()
        return await self._repo.list_appointments(ctx)

    async def cancel(self, ctx: Context, appointment_id: UUID, reason: str | None) -> None:
        ctx.require_patient()
        await self._repo.cancel_appointment(ctx, appointment_id, reason)

    async def register_document(
        self, ctx: Context, request: DocumentRegisterRequest
    ) -> InsuranceDocument:
        ctx.require_patient()
        return await self._repo.register_insurance_document(
            ctx,
            plan_id=request.plan_id,
            storage_path=request.storage_path,
            file_name=request.file_name,
        )

    async def quote_for_booking(
        self,
        ctx: Context,
        *,
        service: Service,
        slot: BookingSlot,
    ) -> InsuranceResult:
        return await self._quote(
            ctx,
            service=service,
            facility_id=slot.facility_id,
            clinician_id=slot.clinician_id,
            on_date=slot.local_date,
        )
