"""Deterministic clinic ranking and flags."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

from healthmcp.discovery.insurance import evaluate_insurance, insurance_score
from healthmcp.discovery.models import (
    AcceptanceRule,
    CandidateRow,
    ClinicCard,
    CoverageRule,
    CoverageStatus,
    FactorScores,
    PatientPreferences,
    PolicyContext,
    ProviderOption,
    Service,
    VerificationLevel,
)

RANKING_VERSION = "clinic-ranking-v1"

WEIGHTS: dict[str, float] = {
    "service": 0.25,
    "insurance": 0.25,
    "availability": 0.15,
    "cost": 0.15,
    "distance": 0.10,
    "preference": 0.05,
    "rating": 0.05,
}

_CATEGORIES = ("overall", "nearest", "cheapest", "soonest", "insurance", "rating")
_CATEGORY_FLAGS = {
    "overall": "BEST_OVERALL",
    "nearest": "NEAREST",
    "cheapest": "CHEAPEST_AFTER_COVER",
    "soonest": "SOONEST_AVAILABLE",
    "insurance": "BEST_INSURANCE_MATCH",
    "rating": "TOP_RATED",
}


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _service_score(row: CandidateRow, service: Service) -> float:
    required = (service.required_specialty or "").strip().lower()
    if not required:
        return 1.0
    actual = (row.specialty or "").strip().lower()
    return 1.0 if required == actual else 0.72


def _availability_score(row: CandidateRow, now: datetime, date_to: datetime) -> float:
    seconds = max((row.next_slot_start - now).total_seconds(), 0.0)
    window = max((date_to - now).total_seconds(), 1.0)
    return _clamp(1.0 - seconds / window)


def _distance_score(distance_km: float, radius_km: float) -> float:
    if radius_km <= 0:
        return 0.5
    return _clamp(1.0 - distance_km / radius_km)


def _preference_score(row: CandidateRow, prefs: PatientPreferences) -> float:
    checks: list[float] = []
    if prefs.preferred_languages:
        checks.append(1.0 if set(row.languages) & set(prefs.preferred_languages) else 0.0)
    if prefs.preferred_clinician_sex:
        checks.append(1.0 if row.clinician_sex == prefs.preferred_clinician_sex else 0.0)
    if prefs.preferred_facility_ids:
        checks.append(1.0 if row.facility_id in prefs.preferred_facility_ids else 0.0)
    if prefs.telehealth_ok:
        checks.append(1.0 if row.offers_telehealth else 0.35)
    return sum(checks) / len(checks) if checks else 0.5


def _rating_score(row: CandidateRow) -> float:
    return _clamp((row.rating or 0.0) / 5.0) if row.rating is not None else 0.5


def _cost_score(gap: Decimal | None, max_gap: Decimal) -> float:
    if gap is None:
        return 0.5
    if max_gap <= 0:
        return 1.0
    return _clamp(1.0 - float(gap / max_gap))


def _weighted(factors: FactorScores) -> float:
    return _clamp(
        factors.service * WEIGHTS["service"]
        + factors.insurance * WEIGHTS["insurance"]
        + factors.availability * WEIGHTS["availability"]
        + factors.cost * WEIGHTS["cost"]
        + factors.distance * WEIGHTS["distance"]
        + factors.preference * WEIGHTS["preference"]
        + factors.rating * WEIGHTS["rating"]
    )


def _base_flags(option: ProviderOption) -> set[str]:
    insurance = option.insurance
    flags: set[str] = set()
    if insurance.direct_billing_available:
        flags.add("DIRECT_BILLING_AVAILABLE")
    if insurance.claim_mode.value == "manual":
        flags.add("PATIENT_CLAIM_REQUIRED")
    if insurance.verification_required:
        flags.add("COVERAGE_UNVERIFIED")
    if insurance.acceptance_status.value == "unknown":
        flags.add("ACCEPTANCE_UNKNOWN")
    if insurance.coverage_status == CoverageStatus.WAITING_PERIOD:
        flags.add("WAITING_PERIOD")
    if insurance.coverage_status == CoverageStatus.NOT_COVERED:
        flags.add("NOT_COVERED")
    if insurance.coverage_status == CoverageStatus.NO_POLICY:
        flags.add("NO_INSURANCE_POLICY")
    if insurance.verification_level == VerificationLevel.FALLBACK_UNVERIFIED:
        flags.add("FALLBACK_COVERAGE_UNVERIFIED")
    return flags


def rank_clinics(
    *,
    service: Service,
    rows: list[CandidateRow],
    coverage_rules: tuple[CoverageRule, ...],
    acceptances: dict[UUID, tuple[AcceptanceRule, ...]],
    policy: PolicyContext | None,
    preferences: PatientPreferences,
    radius_km: float,
    date_to: datetime,
    limit: int,
    now: datetime | None = None,
) -> tuple[list[ClinicCard], int, dict[str, list[UUID]]]:
    if not rows:
        return [], 0, {}
    current = now or datetime.now(UTC)
    if current.tzinfo is None:
        current = current.replace(tzinfo=UTC)

    evaluated: list[tuple[CandidateRow, ProviderOption]] = []
    gaps: list[Decimal] = []
    for row in rows:
        insurance = evaluate_insurance(
            service=service,
            appointment_date=row.next_slot_local.date(),
            policy=policy,
            fee=row.fee,
            medicare_rebate=row.medicare_rebate,
            coverage_rules=coverage_rules,
            acceptance_rules=acceptances.get(row.facility_id, ()),
        )
        factors = FactorScores(
            service=0.0,
            insurance=insurance_score(insurance),
            availability=_availability_score(row, current, date_to),
            cost=0.0,
            distance=_distance_score(row.distance_km, radius_km),
            preference=_preference_score(row, preferences),
            rating=_rating_score(row),
        )
        option = ProviderOption(
            clinician_id=row.clinician_id,
            clinician_name=row.clinician_name,
            specialty=row.specialty,
            languages=row.languages,
            offers_telehealth=row.offers_telehealth,
            next_slot_id=row.next_slot_id,
            next_slot_start=row.next_slot_start,
            next_slot_local=row.next_slot_local,
            fee=row.fee,
            medicare_rebate=row.medicare_rebate,
            insurance=insurance,
            score=0.0,
            factors=factors,
        )
        evaluated.append((row, option))
        if insurance.gap is not None:
            gaps.append(insurance.gap)

    max_gap = max(gaps) if gaps else Decimal("0.00")
    completed: list[tuple[CandidateRow, ProviderOption]] = []
    for row, option in evaluated:
        factors = option.factors.model_copy(
            update={
                "service": _service_score(row, service),
                "cost": _cost_score(option.insurance.gap, max_gap),
            }
        )
        completed.append(
            (row, option.model_copy(update={"factors": factors, "score": _weighted(factors)}))
        )

    by_facility: dict[UUID, list[tuple[CandidateRow, ProviderOption]]] = defaultdict(list)
    for row, option in completed:
        by_facility[row.facility_id].append((row, option))

    cards: list[ClinicCard] = []
    for facility_id, options in by_facility.items():
        options.sort(key=lambda pair: (-pair[1].score, pair[1].next_slot_start))
        row, primary = options[0]
        cards.append(
            ClinicCard(
                facility_id=facility_id,
                facility_name=row.facility_name,
                description=row.facility_description or row.facility_name,
                address_line1=row.address_line1,
                suburb=row.suburb,
                state=row.state,
                postcode=row.postcode,
                timezone=row.timezone,
                latitude=row.latitude,
                longitude=row.longitude,
                distance_km=row.distance_km,
                rating=row.rating,
                review_count=row.review_count,
                service_code=service.code,
                score=primary.score,
                rank=1,
                flags=tuple(sorted(_base_flags(primary))),
                primary_option=primary,
                options=tuple(option for _, option in options),
            )
        )

    cards.sort(key=lambda c: (-c.score, c.distance_km, c.facility_name))
    total_candidates = len(cards)
    cards = cards[:limit]
    if not cards:
        return [], total_candidates, {}

    def sort_key_for(category: str) -> Callable[[ClinicCard], tuple[Any, ...]]:
        if category == "nearest":
            return lambda c: (c.distance_km, -c.score, c.facility_name)
        if category == "cheapest":
            return lambda c: (
                c.primary_option.insurance.gap is None,
                c.primary_option.insurance.gap or Decimal("0"),
                c.facility_name,
            )
        if category == "soonest":
            return lambda c: (c.primary_option.next_slot_start, c.facility_name)
        if category == "insurance":
            return lambda c: (-c.primary_option.factors.insurance, c.facility_name)
        if category == "rating":
            return lambda c: (-(c.rating or 0.0), c.facility_name)
        return lambda c: (-c.score, c.distance_km, c.facility_name)

    rankings: dict[str, list[UUID]] = {}
    for category in _CATEGORIES:
        ordered = sorted(cards, key=sort_key_for(category))
        if category == "insurance" and not any(
            c.primary_option.insurance.verification_level == VerificationLevel.VERIFIED
            for c in ordered
        ):
            continue
        rankings[category] = [c.facility_id for c in ordered]

    category_ranks: dict[UUID, dict[str, int]] = defaultdict(dict)
    for category, facility_ids in rankings.items():
        for index, facility_id in enumerate(facility_ids, start=1):
            category_ranks[facility_id][category] = index

    flags_by_facility: dict[UUID, set[str]] = defaultdict(set)
    for card in cards:
        flags_by_facility[card.facility_id].update(card.flags)
    for category, facility_ids in rankings.items():
        if not facility_ids:
            continue
        flags_by_facility[facility_ids[0]].add(_CATEGORY_FLAGS[category])

    result = [
        card.model_copy(
            update={
                "rank": index,
                "category_ranks": category_ranks[card.facility_id],
                "flags": tuple(sorted(flags_by_facility[card.facility_id])),
            }
        )
        for index, card in enumerate(cards, start=1)
    ]
    return result, total_candidates, rankings
