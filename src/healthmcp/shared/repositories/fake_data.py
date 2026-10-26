"""In-memory fixtures for the Fake repositories. Same ids as supabase/seed/.

Only what the shared library needs so far; later phases add to this module
as their repositories arrive.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID


@dataclass(frozen=True)
class FakePatient:
    id: UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    email: str
    medicare_number: str | None


# seed/01_sample_data.sql section 6
PATIENTS: tuple[FakePatient, ...] = (
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000001"),
        "Olivia",
        "Brown",
        "Liv",
        "olivia.brown@example.com",
        "2953176541",
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000002"),
        "Jack",
        "Wilson",
        None,
        "jack.wilson@example.com",
        "3164287652",
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000003"),
        "Priya",
        "Sharma",
        None,
        "priya.sharma@example.com",
        None,
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000004"),
        "Wei",
        "Chen",
        None,
        "wei.chen@example.com",
        None,
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000005"),
        "Aroha",
        "Ngata",
        None,
        "aroha.ngata@example.com",
        "4275398763",
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000006"),
        "Lukas",
        "Becker",
        None,
        "lukas.becker@example.com",
        None,
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000007"),
        "Mia",
        "Brown",
        None,
        "olivia.brown+mia@example.com",
        "2953176541",
    ),
    FakePatient(
        UUID("50000000-0000-4000-8000-000000000008"),
        "Ahmed",
        "Hassan",
        None,
        "ahmed.hassan@example.com",
        "5386409874",
    ),
)

OLIVIA = PATIENTS[0].id
JACK = PATIENTS[1].id
PRIYA = PATIENTS[2].id
LUKAS = PATIENTS[5].id

DR_RAO = UUID("40000000-0000-4000-8000-000000000001")
DR_WILLIAMS = UUID("40000000-0000-4000-8000-000000000003")
OLIVIA_APPROVED_APPOINTMENT = UUID("60000000-0000-4000-8000-000000000002")

# Auth user ids exist only in the hosted project (logins are created in the
# dashboard and linked by seed/02). These stand-ins are used by the Fakes and
# tests; the "aa" prefix keeps them apart from seed and test-namespace ids.
FAKE_AUTH_USERS: dict[UUID, UUID] = {
    UUID("aa000000-0000-4000-8000-000000000001"): OLIVIA,
    UUID("aa000000-0000-4000-8000-000000000002"): JACK,
    UUID("aa000000-0000-4000-8000-000000000003"): PRIYA,
    UUID("aa000000-0000-4000-8000-000000000004"): LUKAS,
}
OLIVIA_AUTH_USER = UUID("aa000000-0000-4000-8000-000000000001")
JACK_AUTH_USER = UUID("aa000000-0000-4000-8000-000000000002")
# A clinician login (asha.rao@example.com): signed in, but no patient profile.
DR_RAO_AUTH_USER = UUID("aa000000-0000-4000-8000-000000000011")


@dataclass(frozen=True)
class FakeEngineRow:
    engine: str
    capability: str
    provider: str
    model: str
    model_version: str
    region: str | None
    zero_data_retention: bool
    allow_health_data: bool
    enabled: bool


# migrations/20261027000000_agent_layer.sql section 3 + seed/04 section 4
MODEL_REGISTRY: tuple[FakeEngineRow, ...] = (
    FakeEngineRow(
        "jev", "decision", "TypeSafe AI", "system-one", "unknown", None, False, False, False
    ),
    FakeEngineRow(
        "llm_adapter",
        "decision",
        "TypeSafe AI",
        "system-one-llm",
        "unknown",
        None,
        False,
        False,
        False,
    ),
    FakeEngineRow(
        "slm", "extraction", "openai-compat", "unknown", "unknown", None, False, False, False
    ),
    FakeEngineRow("tavily", "search", "Tavily", "search-api", "v1", None, False, False, False),
    FakeEngineRow(
        "google_places", "places", "Google", "places-api-new", "v1", None, False, False, False
    ),
    FakeEngineRow(
        "mock_decision", "decision", "healthmcp", "mock-keywords", "1", "local", True, True, True
    ),
    FakeEngineRow(
        "mock_extraction", "extraction", "healthmcp", "mock-regex", "1", "local", True, True, True
    ),
    FakeEngineRow(
        "mock_search", "search", "healthmcp", "mock-fixtures", "1", "local", True, True, True
    ),
    FakeEngineRow(
        "mock_places", "places", "healthmcp", "mock-fixtures", "1", "local", True, True, True
    ),
)
