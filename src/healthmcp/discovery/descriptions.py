"""Deterministic fallback descriptions used when the agent is unavailable."""

from __future__ import annotations

from decimal import Decimal

from healthmcp.discovery.models import ClinicCard, CoverageStatus, Service


def _money(value: Decimal | None) -> str:
    return f"${value:,.2f}" if value is not None else "an unknown amount"


def _coverage_sentence(card: ClinicCard) -> str:
    insurance = card.primary_option.insurance
    if insurance.coverage_status == CoverageStatus.NOT_COVERED:
        return (
            "The available information indicates this service is not covered; "
            "confirm with your insurer."
        )
    if insurance.coverage_status == CoverageStatus.WAITING_PERIOD:
        return "A waiting period may apply; confirm with your insurer."
    if insurance.coverage_status in {CoverageStatus.UNKNOWN, CoverageStatus.NO_POLICY}:
        return "Coverage is not verified; confirm with your insurer and the clinic."
    if insurance.direct_billing_available:
        return "The clinic may be able to bill your insurer directly; confirm before booking."
    if insurance.claim_mode.value == "manual":
        return (
            "You may need to pay and claim from your insurer; confirm the process with the clinic."
        )
    return "Confirm the benefit and claim method with your insurer and clinic."


def describe_clinic(card: ClinicCard, service: Service) -> str:
    option = card.primary_option
    local = option.next_slot_local.strftime("%a %d %b at %I:%M %p").replace(" 0", " ")
    parts = [
        f"{card.facility_name} is {card.distance_km:.1f} km away in {card.suburb}",
        f"and offers {service.name}.",
        f"The next available appointment is {local}.",
    ]
    if option.insurance.gap is not None:
        parts.append(f"Estimated out-of-pocket cost is {_money(option.insurance.gap)}.")
    parts.append(_coverage_sentence(card))
    return " ".join(parts)
