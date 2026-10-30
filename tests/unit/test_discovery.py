"""Deterministic discovery, insurance and booking behaviour."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from uuid import UUID, uuid4

import pytest

from healthmcp.discovery.errors import (
    NeedsServiceClarification,
    NotFound,
    QuoteChanged,
    ServiceNotFound,
)
from healthmcp.discovery.insurance import evaluate_insurance, insurance_score
from healthmcp.discovery.models import (
    AcceptanceRule,
    AcceptanceStatus,
    AppointmentSummary,
    BookingRequest,
    CandidateRow,
    ClaimMode,
    CoverageRule,
    CoverageStatus,
    DiscoveryRequest,
    InsuranceCheckRequest,
    PatientPreferences,
    PolicyContext,
    Service,
    SourceType,
    VerificationLevel,
)
from healthmcp.discovery.scoring import rank_clinics
from healthmcp.discovery.service import DiscoveryService
from healthmcp.shared.context import Context

USER = UUID("10000000-0000-4000-8000-000000000001")
PATIENT = UUID("50000000-0000-4000-8000-000000000001")
PLAN = UUID("21000000-0000-4000-8000-000000000002")
INSURER = UUID("20000000-0000-4000-8000-000000000001")
TODAY = date.today()
NOW = datetime.now(UTC)

SERVICE = Service(
    id=UUID("70000000-0000-4000-8000-000000000004"),
    code="root_canal",
    name="Root canal treatment",
    category="dental",
    insurance_category="major_dental",
    required_specialty="Dentistry",
    default_duration_minutes=60,
)

POLICY = PolicyContext(
    policy_id=UUID("60000000-0000-4000-8000-000000000001"),
    plan_id=PLAN,
    insurer_provider_id=INSURER,
    valid_from=TODAY - timedelta(days=400),
)


def coverage(
    *,
    status: CoverageStatus = CoverageStatus.PARTIALLY_COVERED,
    benefit_type: str = "percent",
    benefit_value: Decimal | None = Decimal("60"),
    annual_limit: Decimal | None = None,
    waiting_days: int = 0,
    preauth: bool = False,
    verification: VerificationLevel = VerificationLevel.VERIFIED,
    service_id: UUID | None = SERVICE.id,
    category: str | None = None,
) -> CoverageRule:
    return CoverageRule(
        id=uuid4(),
        plan_id=PLAN,
        service_id=service_id,
        insurance_category=category,
        coverage_status=status,
        benefit_type=benefit_type,  # type: ignore[arg-type]
        benefit_value=benefit_value,
        annual_limit=annual_limit,
        waiting_period_days=waiting_days,
        requires_preauth=preauth,
        verification_level=verification,
        source_type=SourceType.STAFF,
        source_url="https://insurer.example.com/cover",
        source_quote="Major dental is covered at 60% after a 12-month wait.",
        retrieved_at=NOW,
        valid_from=TODAY - timedelta(days=30),
    )


def acceptance(
    *,
    accepted: bool = True,
    claim_mode: ClaimMode = ClaimMode.DIRECT,
    verification: VerificationLevel = VerificationLevel.VERIFIED,
    facility_id: UUID | None = None,
) -> AcceptanceRule:
    return AcceptanceRule(
        id=uuid4(),
        facility_id=facility_id or UUID("30000000-0000-4000-8000-000000000005"),
        insurer_provider_id=INSURER,
        service_id=None,
        insurance_category="major_dental",
        accepted=accepted,
        claim_mode=claim_mode,
        verification_level=verification,
        source_type=SourceType.STAFF,
        source_url="https://clinic.example.com/insurance",
        source_quote="We direct bill this fund.",
        retrieved_at=NOW,
        valid_from=TODAY - timedelta(days=30),
    )


def insurance(
    *,
    rules: tuple[CoverageRule, ...] | None = None,
    acceptances: tuple[AcceptanceRule, ...] | None = None,
    policy: PolicyContext | None = POLICY,
    fee: Decimal | None = Decimal("1200.00"),
    rebate: Decimal | None = Decimal("0.00"),
    appointment_date: date = TODAY,
):
    return evaluate_insurance(
        service=SERVICE,
        appointment_date=appointment_date,
        policy=policy,
        fee=fee,
        medicare_rebate=rebate,
        coverage_rules=rules if rules is not None else (coverage(),),
        acceptance_rules=acceptances if acceptances is not None else (acceptance(),),
    )


def test_verified_direct_billing_calculates_gap() -> None:
    result = insurance()

    assert result.coverage_status == CoverageStatus.PARTIALLY_COVERED
    assert result.acceptance_status == AcceptanceStatus.ACCEPTED
    assert result.claim_mode == ClaimMode.DIRECT
    assert result.insurance_benefit == Decimal("720.00")
    assert result.gap == Decimal("480.00")
    assert result.direct_billing_available is True
    assert result.verification_required is False
    assert result.disclaimer is None
    assert "DIRECT_BILLING_AVAILABLE" in result.reason_codes


def test_manual_claim_has_no_direct_billing() -> None:
    result = insurance(acceptances=(acceptance(claim_mode=ClaimMode.MANUAL),))

    assert result.claimable is True
    assert result.direct_billing_available is False
    assert "PATIENT_CLAIM_REQUIRED" in result.reason_codes


def test_waiting_period_uses_policy_start_and_zero_benefit() -> None:
    result = insurance(
        rules=(coverage(waiting_days=365),),
        policy=PolicyContext(
            policy_id=POLICY.policy_id,
            plan_id=PLAN,
            insurer_provider_id=INSURER,
            valid_from=TODAY - timedelta(days=10),
        ),
    )

    assert result.coverage_status == CoverageStatus.WAITING_PERIOD
    assert result.insurance_benefit == Decimal("0.00")
    assert result.gap == Decimal("1200.00")
    assert "WAITING_PERIOD_365_DAYS" in result.reason_codes


def test_waiting_period_status_is_respected_without_policy_dates() -> None:
    result = insurance(rules=(coverage(status=CoverageStatus.WAITING_PERIOD),))

    assert result.coverage_status == CoverageStatus.WAITING_PERIOD
    assert insurance_score(result) == 0.25


def test_annual_limit_caps_benefit() -> None:
    result = insurance(rules=(coverage(annual_limit=Decimal("100.00")),))

    assert result.insurance_benefit == Decimal("100.00")
    assert result.gap == Decimal("1100.00")


def test_pre_auth_is_reported_and_still_claimable() -> None:
    result = insurance(rules=(coverage(preauth=True),))

    assert result.coverage_status == CoverageStatus.PRE_AUTH_REQUIRED
    assert result.direct_billing_available is True
    assert result.claimable is True
    assert "PRE_AUTH_REQUIRED" in result.reason_codes


def test_no_policy_is_explicit_and_never_covered() -> None:
    result = insurance(policy=None)

    assert result.coverage_status == CoverageStatus.NO_POLICY
    assert result.insurance_benefit == Decimal("0.00")
    assert result.gap == Decimal("1200.00")
    assert result.direct_billing_available is False
    assert result.verification_required is True
    assert "NO_INSURANCE_POLICY" in result.reason_codes


def test_missing_coverage_rule_is_unknown() -> None:
    result = insurance(rules=())

    assert result.coverage_status == CoverageStatus.UNKNOWN
    assert result.verification_required is True
    assert "COVERAGE_NOT_FOUND" in result.reason_codes


def test_missing_acceptance_is_unknown_and_requires_verification() -> None:
    result = insurance(acceptances=())

    assert result.acceptance_status == AcceptanceStatus.UNKNOWN
    assert result.claim_mode == ClaimMode.UNKNOWN
    assert result.verification_required is True
    assert "ACCEPTANCE_NOT_FOUND" in result.reason_codes


def test_not_accepted_blocks_claiming_and_scores_zero() -> None:
    result = insurance(
        acceptances=(acceptance(accepted=False, claim_mode=ClaimMode.NOT_SUPPORTED),)
    )

    assert result.acceptance_status == AcceptanceStatus.NOT_ACCEPTED
    assert result.claimable is False
    assert result.direct_billing_available is False
    assert insurance_score(result) == 0.0


def test_fallback_coverage_is_not_presented_as_verified() -> None:
    result = insurance(rules=(coverage(verification=VerificationLevel.FALLBACK_UNVERIFIED),))

    assert result.verification_level == VerificationLevel.FALLBACK_UNVERIFIED
    assert result.verification_required is True
    assert result.disclaimer is not None
    assert "FALLBACK_COVERAGE_UNVERIFIED" in result.reason_codes


def test_service_specific_rule_beats_category_rule() -> None:
    category_rule = coverage(
        service_id=None,
        category="major_dental",
        benefit_value=Decimal("20"),
        verification=VerificationLevel.PRIMARY_EXTRACTED,
    )
    specific_rule = coverage(service_id=SERVICE.id, benefit_value=Decimal("80"))

    result = insurance(rules=(category_rule, specific_rule))

    assert result.insurance_benefit == Decimal("960.00")


def test_mbs_percent_uses_medicare_rebate() -> None:
    result = insurance(
        rules=(coverage(benefit_type="mbs_percent", benefit_value=Decimal("100")),),
        fee=Decimal("85.00"),
        rebate=Decimal("43.90"),
    )

    assert result.insurance_benefit == Decimal("43.90")
    assert result.gap == Decimal("41.10")


def test_not_covered_has_zero_benefit() -> None:
    result = insurance(rules=(coverage(status=CoverageStatus.NOT_COVERED),))

    assert result.coverage_status == CoverageStatus.NOT_COVERED
    assert result.insurance_benefit == Decimal("0.00")
    assert insurance_score(result) == 0.0


def test_rank_clinics_returns_grouped_cards_category_order_and_flags() -> None:
    facilities = [
        (UUID("30000000-0000-4000-8000-000000000005"), 1.0, 2, Decimal("1200.00")),
        (UUID("30000000-0000-4000-8000-000000000006"), 4.0, 1, Decimal("1100.00")),
        (UUID("30000000-0000-4000-8000-000000000007"), 8.0, 3, Decimal("1450.00")),
    ]
    rows = [
        CandidateRow(
            facility_id=facility_id,
            facility_name=f"Clinic {index}",
            facility_description=f"Clinic {index} description",
            address_line1=f"{index} Test Street",
            suburb="West End",
            state="QLD",
            postcode="4101",
            timezone="Australia/Brisbane",
            distance_km=distance,
            rating=4.5,
            review_count=20,
            clinician_id=uuid4(),
            clinician_name=f"Dr {index}",
            clinician_type="specialist",
            clinician_sex="female",
            specialty="Dentistry",
            languages=("en",),
            offers_telehealth=True,
            service_id=SERVICE.id,
            service_code=SERVICE.code,
            fee=fee,
            medicare_rebate=Decimal("0.00"),
            next_slot_id=uuid4(),
            next_slot_start=NOW + timedelta(days=days),
            next_slot_local=(NOW + timedelta(days=days)).replace(tzinfo=None),
        )
        for index, (facility_id, distance, days, fee) in enumerate(facilities, start=1)
    ]
    acceptances = {
        facility_id: (acceptance(facility_id=facility_id),) for facility_id, _, _, _ in facilities
    }

    cards, total, rankings = rank_clinics(
        service=SERVICE,
        rows=rows,
        coverage_rules=(coverage(),),
        acceptances=acceptances,
        policy=POLICY,
        preferences=PatientPreferences(),
        radius_km=50.0,
        date_to=NOW + timedelta(days=30),
        limit=100,
        now=NOW,
    )

    assert total == 3
    assert len(cards) == 3
    assert {card.rank for card in cards} == {1, 2, 3}
    assert set(rankings) == {
        "overall",
        "nearest",
        "cheapest",
        "soonest",
        "insurance",
        "rating",
    }
    assert rankings["nearest"][0] == facilities[0][0]
    assert rankings["cheapest"][0] == facilities[1][0]
    assert rankings["soonest"][0] == facilities[1][0]
    assert all("BEST_OVERALL" in card.flags for card in [cards[0]])
    assert "NEAREST" in cards[0].flags or "NEAREST" in cards[1].flags
    assert all("DIRECT_BILLING_AVAILABLE" in card.flags for card in cards)


def test_rank_clinics_empty_rows() -> None:
    cards, total, rankings = rank_clinics(
        service=SERVICE,
        rows=[],
        coverage_rules=(),
        acceptances={},
        policy=None,
        preferences=PatientPreferences(),
        radius_km=50.0,
        date_to=NOW,
        limit=100,
        now=NOW,
    )

    assert cards == []
    assert total == 0
    assert rankings == {}


class FakeRepository:
    def __init__(
        self,
        *,
        rows: list[CandidateRow] | None = None,
        candidates: list[Service] | None = None,
    ) -> None:
        self.rows = rows or []
        self.candidates = candidates or []
        self.calls: list[tuple[str, object]] = []
        self.booked_appointment = AppointmentSummary(
            appointment_id=UUID("90000000-0000-4000-8000-000000000001"),
            status="booked",
            scheduled_start=NOW + timedelta(days=2),
            scheduled_end=NOW + timedelta(days=2, hours=1),
            facility_id=UUID("30000000-0000-4000-8000-000000000005"),
            facility_name="West End Dental Studio",
            clinician_id=UUID("40000000-0000-4000-8000-000000000007"),
            clinician_name="Dr Nadia Haddad",
            service_code="root_canal",
            reason=None,
            quoted_fee=Decimal("1200.00"),
            quoted_gap=Decimal("480.00"),
            coverage_status="partially_covered",
            claim_mode="direct",
        )

    async def list_services(self, ctx: Context) -> list[Service]:
        return [SERVICE]

    async def resolve_service(
        self, ctx: Context, service_code: str | None, problem_text: str | None
    ) -> tuple[Service | None, list[Service]]:
        self.calls.append(("resolve_service", (service_code, problem_text)))
        if service_code == SERVICE.code:
            return SERVICE, []
        if service_code:
            return None, []
        if problem_text and "root canal" in problem_text.lower():
            return SERVICE, []
        return None, self.candidates

    async def fetch_candidates(
        self,
        ctx: Context,
        *,
        service: Service,
        latitude: float,
        longitude: float,
        radius_km: float,
        date_from: date,
        date_to: date,
        max_candidates: int,
    ) -> list[CandidateRow]:
        self.calls.append(("fetch_candidates", radius_km))
        return self.rows

    async def fetch_policy(self, ctx: Context, on_date: date) -> PolicyContext | None:
        return POLICY

    async def fetch_coverage_rules(
        self,
        ctx: Context,
        *,
        policy: PolicyContext,
        service: Service,
        on_date: date,
        through: date | None = None,
    ) -> tuple[CoverageRule, ...]:
        return (coverage(),)

    async def fetch_acceptances(
        self,
        ctx: Context,
        *,
        facility_ids: Sequence[UUID],
        policy: PolicyContext,
        service: Service,
        on_date: date,
        through: date | None = None,
    ) -> dict[UUID, tuple[AcceptanceRule, ...]]:
        return {facility_id: (acceptance(facility_id=facility_id),) for facility_id in facility_ids}

    async def fetch_preferences(self, ctx: Context) -> PatientPreferences:
        return PatientPreferences(max_distance_km=20)

    async def service_fee(
        self,
        ctx: Context,
        *,
        facility_id: UUID,
        service: Service,
        on_date: date,
        clinician_id: UUID | None = None,
    ) -> tuple[Decimal | None, Decimal | None]:
        return Decimal("1200.00"), Decimal("0.00")

    async def get_slot(self, ctx: Context, slot_id: UUID):
        from healthmcp.discovery.models import BookingSlot

        start = NOW + timedelta(days=2)
        return BookingSlot(
            slot_id=slot_id,
            facility_id=UUID("30000000-0000-4000-8000-000000000005"),
            clinician_id=UUID("40000000-0000-4000-8000-000000000007"),
            starts_at=start,
            ends_at=start + timedelta(hours=1),
            local_start=start.replace(tzinfo=None),
            local_date=start.date(),
            timezone="Australia/Brisbane",
        )

    async def facility_exists(self, ctx: Context, facility_id: UUID) -> bool:
        return True

    async def fetch_availability(self, ctx: Context, *, on_date: date, facility_id, clinician_id):
        return []

    async def hold_slot(self, ctx: Context, slot_id: UUID) -> datetime:
        return NOW + timedelta(minutes=5)

    async def book_slot(self, ctx: Context, **kwargs) -> UUID:
        self.calls.append(("book_slot", kwargs))
        return self.booked_appointment.appointment_id

    async def get_appointment(self, ctx: Context, appointment_id: UUID) -> AppointmentSummary:
        return self.booked_appointment

    async def list_appointments(self, ctx: Context) -> list[AppointmentSummary]:
        return []

    async def cancel_appointment(
        self, ctx: Context, appointment_id: UUID, reason: str | None
    ) -> None:
        return None

    async def reschedule_appointment(
        self, ctx: Context, appointment_id: UUID, new_slot_id: UUID
    ) -> UUID:
        return appointment_id

    async def register_insurance_document(self, ctx: Context, *, plan_id, storage_path, file_name):
        raise NotImplementedError


def context() -> Context:
    return Context.for_user(
        agent_id="clinic-concierge",
        request_id="request-1",
        user_id=USER,
        claims={"sub": str(USER)},
        patient_id=PATIENT,
    )


@pytest.mark.asyncio
async def test_discover_uses_request_and_preference_radius() -> None:
    repository = FakeRepository(rows=[])
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    result = await service.discover(
        context(),
        DiscoveryRequest(
            service_code=SERVICE.code,
            latitude=-27.48,
            longitude=153.01,
            max_distance_km=50,
        ),
    )

    assert result.service.code == SERVICE.code
    assert result.search_radius_km == 20
    assert result.ranking_version == "clinic-ranking-v1"
    assert ("fetch_candidates", 20) in repository.calls


@pytest.mark.asyncio
async def test_discover_resolves_problem_text_and_adds_description() -> None:
    facility_id = UUID("30000000-0000-4000-8000-000000000005")
    row = CandidateRow(
        facility_id=facility_id,
        facility_name="West End Dental Studio",
        address_line1="88 Boundary Street",
        suburb="West End",
        state="QLD",
        postcode="4101",
        timezone="Australia/Brisbane",
        distance_km=1.2,
        rating=4.7,
        review_count=50,
        clinician_id=UUID("40000000-0000-4000-8000-000000000007"),
        clinician_name="Dr Nadia Haddad",
        clinician_type="specialist",
        specialty="Dentistry",
        languages=("en",),
        service_id=SERVICE.id,
        service_code=SERVICE.code,
        fee=Decimal("1200.00"),
        medicare_rebate=Decimal("0.00"),
        next_slot_id=uuid4(),
        next_slot_start=NOW + timedelta(days=2),
        next_slot_local=(NOW + timedelta(days=2)).replace(tzinfo=None),
    )
    repository = FakeRepository(rows=[row])
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    result = await service.discover(
        context(),
        DiscoveryRequest(
            problem_text="I need a root canal",
            latitude=-27.48,
            longitude=153.01,
        ),
    )

    assert result.returned_count == 1
    assert "Root canal treatment" in result.clinics[0].agent_description or ""
    assert result.clinics[0].rank == 1


@pytest.mark.asyncio
async def test_ambiguous_problem_text_returns_candidates() -> None:
    other = SERVICE.model_copy(
        update={"id": UUID(int=5), "code": "emergency_dental", "name": "Emergency"}
    )
    repository = FakeRepository(candidates=[SERVICE, other])
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    with pytest.raises(NeedsServiceClarification) as exc:
        await service.discover(
            context(),
            DiscoveryRequest(
                problem_text="dentist for tooth pain", latitude=-27.48, longitude=153.01
            ),
        )

    assert exc.value.candidates == (SERVICE, other)


@pytest.mark.asyncio
async def test_a_single_alias_match_needs_no_question() -> None:
    service = DiscoveryService(FakeRepository(candidates=[SERVICE]))  # type: ignore[arg-type]
    result = await service.discover(
        context(),
        DiscoveryRequest(problem_text="I have tooth pain", latitude=-27.48, longitude=153.01),
    )
    assert result.service == SERVICE


@pytest.mark.asyncio
async def test_plain_words_find_the_service_when_no_alias_matches() -> None:
    service = DiscoveryService(FakeRepository())  # type: ignore[arg-type]
    result = await service.discover(
        context(),
        DiscoveryRequest(
            problem_text="Endodontic follow-up please", latitude=-27.48, longitude=153.01
        ),
    )
    assert result.service == SERVICE  # root_canal, from the catalog


@pytest.mark.asyncio
async def test_unrecognised_text_offers_every_service_gp_first() -> None:
    gp = SERVICE.model_copy(
        update={"id": UUID(int=1), "code": "gp_standard", "name": "Standard GP"}
    )

    class Catalog(FakeRepository):
        async def list_services(self, ctx: Context) -> list[Service]:
            return [SERVICE, gp]

    service = DiscoveryService(Catalog())  # type: ignore[arg-type]
    with pytest.raises(NeedsServiceClarification) as exc:
        await service.discover(
            context(), DiscoveryRequest(problem_text="not sure", latitude=-27.48, longitude=153.01)
        )
    assert exc.value.candidates == (gp, SERVICE)


@pytest.mark.asyncio
async def test_unknown_service_raises_not_found() -> None:
    repository = FakeRepository()
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    with pytest.raises(ServiceNotFound):
        await service.discover(
            context(),
            DiscoveryRequest(
                service_code="not_a_service",
                latitude=-27.48,
                longitude=153.01,
            ),
        )


@pytest.mark.asyncio
async def test_check_insurance_without_policy_is_not_an_error() -> None:
    repository = FakeRepository()
    repository.fetch_policy = _no_policy  # type: ignore[method-assign]
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    result = await service.check_insurance(
        context(),
        InsuranceCheckRequest(
            service_code=SERVICE.code,
            facility_id=UUID("30000000-0000-4000-8000-000000000005"),
        ),
    )

    assert result.insurance.coverage_status == CoverageStatus.NO_POLICY


async def _no_policy(ctx: Context, on_date: date) -> None:
    return None


@pytest.mark.asyncio
async def test_book_rejects_a_changed_quote_before_writing() -> None:
    repository = FakeRepository()
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    with pytest.raises(QuoteChanged):
        await service.book(
            context(),
            BookingRequest(
                slot_id=UUID("80000000-0000-4000-8000-000000000001"),
                service_code=SERVICE.code,
                idempotency_key="idempotency-123",
                expected_fee=Decimal("1200.00"),
                expected_gap=Decimal("100.00"),
            ),
        )

    assert not any(name == "book_slot" for name, _ in repository.calls)


@pytest.mark.asyncio
async def test_book_missing_slot_raises_not_found() -> None:
    repository = FakeRepository()
    repository.get_slot = _no_slot  # type: ignore[method-assign]
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    with pytest.raises(NotFound):
        await service.book(
            context(),
            BookingRequest(
                slot_id=UUID("80000000-0000-4000-8000-000000000001"),
                service_code=SERVICE.code,
                idempotency_key="idempotency-123",
            ),
        )


async def _no_slot(ctx: Context, slot_id: UUID) -> None:
    return None


@pytest.mark.asyncio
async def test_book_success_snapshots_the_quote() -> None:
    repository = FakeRepository()
    service = DiscoveryService(repository)  # type: ignore[arg-type]

    result = await service.book(
        context(),
        BookingRequest(
            slot_id=UUID("80000000-0000-4000-8000-000000000001"),
            service_code=SERVICE.code,
            idempotency_key="idempotency-123",
            expected_fee=Decimal("1200.00"),
            expected_gap=Decimal("480.00"),
        ),
    )

    assert result.appointment_id == repository.booked_appointment.appointment_id
    assert result.quoted_gap == Decimal("480.00")
    booked = next(value for name, value in repository.calls if name == "book_slot")
    assert isinstance(booked, dict)
    assert booked["expected_gap"] == Decimal("480.00")
    assert booked["coverage_status"] == CoverageStatus.PARTIALLY_COVERED
