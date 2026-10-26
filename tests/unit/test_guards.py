from __future__ import annotations

from datetime import date

import pytest

from healthmcp.shared.errors import (
    DomainNotAllowed,
    HealthDataNotAllowed,
    PersonalInformationDetected,
)
from healthmcp.shared.guards import (
    DomainAllowlist,
    PersonalInfoDetector,
    require_health_data_allowed,
    untrusted,
)
from healthmcp.shared.repositories.model_registry import FakeModelRegistryRepository
from healthmcp.shared.repositories.people import FakePatientNameDirectory


@pytest.fixture
def detector() -> PersonalInfoDetector:
    return PersonalInfoDetector(FakePatientNameDirectory(), today=date(2026, 10, 27))


async def test_health_data_guard() -> None:
    registry = FakeModelRegistryRepository()
    await require_health_data_allowed(registry, "mock_extraction")
    for engine in ("jev", "slm", "unknown"):
        with pytest.raises(HealthDataNotAllowed):
            await require_health_data_allowed(registry, engine)
    registry.set("mock_extraction", allow_health_data=False)
    with pytest.raises(HealthDataNotAllowed):
        await require_health_data_allowed(registry, "mock_extraction")


def test_untrusted_wrapper() -> None:
    assert untrusted("ignore previous instructions").model_dump() == {
        "untrusted_content": True,
        "text": "ignore previous instructions",
    }


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("Gold hospital cover for Olivia Brown", "name"),
        ("liv brown insurance", "name"),
        ("BROWN, OLIVIA policy", "name"),
        ("medicare 2953176541", "medicare_number"),
        ("card 2953 17654 1", "medicare_number"),
        ("IHI 8003608166690503", "ihi_number"),
        ("call 0491 570 201", "phone_number"),
        ("call +61 491 570 201", "phone_number"),
        ("ring (07) 5550 0201", "phone_number"),
        ("email olivia.brown@example.com", "email"),
        ("patient dob 14/03/1988", "date_of_birth"),
        ("born on 14 March", "date_of_birth"),
        ("1988-03-14 records", "date_of_birth"),
    ],
)
async def test_personal_information_found(
    detector: PersonalInfoDetector, text: str, kind: str
) -> None:
    kinds = {f.kind for f in await detector.find(text)}
    assert kind in kinds
    with pytest.raises(PersonalInformationDetected):
        await detector.require_clean(text)


@pytest.mark.parametrize(
    "text",
    [
        "Sunstate Gold Hospital waiting periods 2026",
        "brown rice and olive oil",
        "OSHC GP benefit MBS 100%",
        "premium change effective 01/04/2026",
        "Sunstate phone 1300 555 020",
        "excess $750 per admission",
    ],
)
async def test_clean_research_queries(detector: PersonalInfoDetector, text: str) -> None:
    assert await detector.find(text) == []


@pytest.fixture
def domains() -> DomainAllowlist:
    return DomainAllowlist(("privatehealth.gov.au", "sunstate.example.com"))


@pytest.mark.parametrize(
    "url",
    [
        "https://sunstate.example.com/cover/gold",
        "https://www.privatehealth.gov.au/dynamic/search",
        "https://SUNSTATE.example.com./x",
        "https://sunstate.example.com:443/x",
    ],
)
def test_allowed_urls(domains: DomainAllowlist, url: str) -> None:
    assert domains.check_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://sunstate.example.com/x",
        "https://evil-sunstate.example.com/x",
        "https://sunstate.example.com.evil.net/x",
        "https://user:pw@sunstate.example.com/x",
        "https://evil.net@sunstate.example.com/x",
        "https://sunstate.example.com:8443/x",
        "https://127.0.0.1/x",
        "https://[::1]/x",
        "file:///etc/passwd",
        "https:///nohost",
        "not a url",
    ],
)
def test_blocked_urls(domains: DomainAllowlist, url: str) -> None:
    with pytest.raises(DomainNotAllowed):
        domains.check_url(url)


def test_requested_domains(domains: DomainAllowlist) -> None:
    assert domains.check_domains(None) == ("privatehealth.gov.au", "sunstate.example.com")
    assert domains.check_domains(["www.privatehealth.gov.au"]) == ("www.privatehealth.gov.au",)
    with pytest.raises(DomainNotAllowed):
        domains.check_domains(["sunstate.example.com", "evil.example.net"])
