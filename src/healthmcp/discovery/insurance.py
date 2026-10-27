"""Deterministic insurance/claim evaluation.

No model is involved here. The same inputs always produce the same result.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

from healthmcp.discovery.models import (
    VERIFY_WARNING,
    AcceptanceRule,
    AcceptanceStatus,
    ClaimMode,
    CoverageRule,
    CoverageStatus,
    InsuranceResult,
    PolicyContext,
    Service,
    SourceType,
    VerificationLevel,
)

_ZERO = Decimal("0.00")
_CENT = Decimal("0.01")

_VERIFICATION_ORDER = {
    VerificationLevel.VERIFIED: 3,
    VerificationLevel.PRIMARY_EXTRACTED: 2,
    VerificationLevel.FALLBACK_UNVERIFIED: 1,
}


def _in_force(valid_from: date, valid_to: date | None, appointment_date: date) -> bool:
    return valid_from <= appointment_date and (valid_to is None or appointment_date < valid_to)


def _rule_rank(rule: CoverageRule | AcceptanceRule, service: Service) -> tuple[int, int, int, int]:
    specific = 1 if rule.service_id == service.id else 0
    verified = _VERIFICATION_ORDER.get(rule.verification_level, 0)
    retrieved = int(rule.retrieved_at.timestamp()) if rule.retrieved_at else 0
    return (specific, verified, retrieved, int(rule.valid_from.toordinal()))


def select_coverage_rule(
    rules: tuple[CoverageRule, ...], service: Service, appointment_date: date
) -> CoverageRule | None:
    eligible = [
        r
        for r in rules
        if _in_force(r.valid_from, r.valid_to, appointment_date)
        and (r.service_id == service.id or r.insurance_category == service.insurance_category)
    ]
    if not eligible:
        return None
    return max(eligible, key=lambda r: _rule_rank(r, service))


def select_acceptance_rule(
    rules: tuple[AcceptanceRule, ...], service: Service, appointment_date: date
) -> AcceptanceRule | None:
    eligible = [
        r
        for r in rules
        if _in_force(r.valid_from, r.valid_to, appointment_date)
        and (r.service_id == service.id or r.insurance_category == service.insurance_category)
    ]
    if not eligible:
        return None
    return max(eligible, key=lambda r: _rule_rank(r, service))


def _money(value: Decimal | None) -> Decimal | None:
    if value is None:
        return None
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def _benefit(
    rule: CoverageRule,
    status: CoverageStatus,
    fee: Decimal | None,
    medicare_rebate: Decimal | None,
) -> Decimal | None:
    if fee is None or status not in {
        CoverageStatus.COVERED,
        CoverageStatus.PARTIALLY_COVERED,
        CoverageStatus.PRE_AUTH_REQUIRED,
    }:
        return _ZERO
    if rule.benefit_type == "none" or rule.benefit_value is None:
        return _ZERO
    if rule.benefit_type == "fixed":
        amount = rule.benefit_value
        cap = max(fee - (medicare_rebate or _ZERO), _ZERO)
    elif rule.benefit_type == "percent":
        amount = fee * rule.benefit_value / Decimal(100)
        cap = max(fee - (medicare_rebate or _ZERO), _ZERO)
    elif rule.benefit_type == "mbs_percent":
        # The rebate is the MBS benchmark here, not a separate payment.
        amount = (medicare_rebate or _ZERO) * rule.benefit_value / Decimal(100)
        cap = fee
    else:
        return _ZERO
    amount = max(amount, _ZERO)
    if rule.annual_limit is not None:
        amount = min(amount, rule.annual_limit)
    amount = min(amount, cap)
    return _money(amount)


def _verification(
    coverage: CoverageRule | None, acceptance: AcceptanceRule | None
) -> VerificationLevel | None:
    levels = [r.verification_level for r in (coverage, acceptance) if r is not None]
    if not levels:
        return None
    return min(levels, key=lambda level: _VERIFICATION_ORDER.get(level, 0))


def _source(
    coverage: CoverageRule | None, acceptance: AcceptanceRule | None
) -> tuple[str | None, str | None, datetime | None]:
    for rule in (coverage, acceptance):
        if rule is not None and rule.source_url:
            return rule.source_url, rule.source_quote, rule.retrieved_at
    return None, None, None


def _acceptance(
    rule: AcceptanceRule | None,
) -> tuple[AcceptanceStatus, ClaimMode]:
    if rule is None:
        return AcceptanceStatus.UNKNOWN, ClaimMode.UNKNOWN
    if not rule.accepted:
        return AcceptanceStatus.NOT_ACCEPTED, ClaimMode.NOT_SUPPORTED
    return AcceptanceStatus.ACCEPTED, rule.claim_mode


def _waiting(rule: CoverageRule, policy: PolicyContext | None, appointment_date: date) -> bool:
    if policy is None:
        return False
    if rule.coverage_status == CoverageStatus.WAITING_PERIOD:
        return True
    if rule.waiting_period_days <= 0:
        return False
    eligible_from = policy.valid_from + timedelta(days=rule.waiting_period_days)
    return appointment_date < eligible_from


def evaluate_insurance(
    *,
    service: Service,
    appointment_date: date,
    policy: PolicyContext | None,
    fee: Decimal | None,
    medicare_rebate: Decimal | None,
    coverage_rules: tuple[CoverageRule, ...],
    acceptance_rules: tuple[AcceptanceRule, ...],
) -> InsuranceResult:
    coverage_rule = select_coverage_rule(coverage_rules, service, appointment_date)
    acceptance_rule = select_acceptance_rule(acceptance_rules, service, appointment_date)
    acceptance, claim_mode = _acceptance(acceptance_rule)
    reasons: list[str] = []

    if policy is None:
        coverage_status = CoverageStatus.NO_POLICY
        reasons.append("NO_INSURANCE_POLICY")
    elif coverage_rule is None:
        coverage_status = CoverageStatus.UNKNOWN
        reasons.append("COVERAGE_NOT_FOUND")
    elif _waiting(coverage_rule, policy, appointment_date):
        coverage_status = CoverageStatus.WAITING_PERIOD
        reasons.append(f"WAITING_PERIOD_{coverage_rule.waiting_period_days}_DAYS")
    else:
        coverage_status = coverage_rule.coverage_status
        reasons.append(f"COVERAGE_{coverage_status.value.upper()}")
        if coverage_rule.requires_preauth:
            coverage_status = CoverageStatus.PRE_AUTH_REQUIRED
            reasons.append("PRE_AUTH_REQUIRED")
        annual_limit = coverage_rule.annual_limit
        if annual_limit is not None and annual_limit <= 0:
            coverage_status = CoverageStatus.LIMIT_REACHED
            reasons.append("ANNUAL_LIMIT_REACHED")

    if acceptance_rule is None:
        reasons.append("ACCEPTANCE_NOT_FOUND")
    elif not acceptance_rule.accepted:
        reasons.append("CLINIC_NOT_ACCEPTED")
    elif acceptance_rule.claim_mode == ClaimMode.DIRECT:
        reasons.append("DIRECT_BILLING_AVAILABLE")
    elif acceptance_rule.claim_mode == ClaimMode.MANUAL:
        reasons.append("PATIENT_CLAIM_REQUIRED")
    elif acceptance_rule.claim_mode == ClaimMode.NOT_SUPPORTED:
        reasons.append("CLAIM_NOT_SUPPORTED")

    verification = _verification(coverage_rule, acceptance_rule)
    verification_required = (
        policy is None
        or coverage_rule is None
        or acceptance_rule is None
        or verification != VerificationLevel.VERIFIED
    )
    source_url, source_quote, retrieved_at = _source(coverage_rule, acceptance_rule)
    if verification_required:
        reasons.append("USER_VERIFICATION_REQUIRED")
    if verification == VerificationLevel.FALLBACK_UNVERIFIED:
        reasons.append("FALLBACK_COVERAGE_UNVERIFIED")

    benefit = (
        _benefit(coverage_rule, coverage_status, fee, medicare_rebate)
        if coverage_rule is not None
        else _ZERO
    )
    gap = None
    if fee is not None:
        medicare_applies = coverage_rule is not None and coverage_rule.benefit_type != "mbs_percent"
        gap = max(
            fee - ((medicare_rebate or _ZERO) if medicare_applies else _ZERO) - (benefit or _ZERO),
            _ZERO,
        )

    direct = (
        coverage_status
        in {
            CoverageStatus.COVERED,
            CoverageStatus.PARTIALLY_COVERED,
            CoverageStatus.PRE_AUTH_REQUIRED,
        }
        and acceptance == AcceptanceStatus.ACCEPTED
        and claim_mode == ClaimMode.DIRECT
    )

    return InsuranceResult(
        coverage_status=coverage_status,
        acceptance_status=acceptance,
        claim_mode=claim_mode,
        verification_level=verification,
        verification_required=verification_required,
        direct_billing_available=direct,
        fee=_money(fee),
        medicare_rebate=_money(medicare_rebate),
        insurance_benefit=_money(benefit),
        gap=_money(gap),
        reason_codes=tuple(reasons),
        source_url=source_url,
        source_quote=source_quote,
        coverage_as_of=retrieved_at,
        disclaimer=VERIFY_WARNING if verification_required else None,
    )


def insurance_score(result: InsuranceResult) -> float:
    """A 0..1 score used by ranking. Unknown is neutral-low, never covered."""
    if result.acceptance_status == AcceptanceStatus.NOT_ACCEPTED:
        return 0.0
    if result.coverage_status in {CoverageStatus.NOT_COVERED, CoverageStatus.LIMIT_REACHED}:
        return 0.0
    if result.coverage_status == CoverageStatus.WAITING_PERIOD:
        return 0.25
    if result.coverage_status in {CoverageStatus.NO_POLICY, CoverageStatus.UNKNOWN}:
        return 0.4
    if result.verification_level == VerificationLevel.VERIFIED:
        if result.direct_billing_available:
            return 1.0
        if result.claim_mode == ClaimMode.MANUAL:
            return 0.9
        if result.claim_mode == ClaimMode.UNKNOWN:
            return 0.7
        return 0.5
    if result.verification_level == VerificationLevel.PRIMARY_EXTRACTED:
        return 0.65
    return 0.5


def fallback_source_type(level: VerificationLevel) -> SourceType:
    return (
        SourceType.PRIVATEHEALTH
        if level == VerificationLevel.PRIMARY_EXTRACTED
        else SourceType.INSURER_SITE
    )
