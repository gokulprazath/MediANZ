"""Domain errors mapped to stable API responses."""

from __future__ import annotations

from healthmcp.discovery.models import Service


class DiscoveryError(Exception):
    code = "discovery_error"
    status_code = 400


class ServiceNotFound(DiscoveryError):
    code = "SERVICE_NOT_FOUND"
    status_code = 404


class NeedsServiceClarification(DiscoveryError):
    code = "NEEDS_SERVICE_CLARIFICATION"
    status_code = 422

    def __init__(self, candidates: tuple[Service, ...] = ()) -> None:
        super().__init__(self.code)
        self.candidates = candidates


class InsurancePolicyMissing(DiscoveryError):
    code = "NO_INSURANCE_POLICY"
    status_code = 404


class SlotUnavailable(DiscoveryError):
    code = "SLOT_TAKEN"
    status_code = 409


class QuoteChanged(DiscoveryError):
    code = "QUOTE_CHANGED"
    status_code = 409

    def __init__(self, expected_gap: object, current_gap: object) -> None:
        super().__init__(self.code)
        self.expected_gap = expected_gap
        self.current_gap = current_gap


class CoverageChanged(DiscoveryError):
    code = "COVERAGE_CHANGED"
    status_code = 409


class Forbidden(DiscoveryError):
    code = "FORBIDDEN"
    status_code = 403


class NotFound(DiscoveryError):
    code = "NOT_FOUND"
    status_code = 404


class ResearchUnavailable(DiscoveryError):
    code = "RESEARCH_UNAVAILABLE"
    status_code = 503
