"""FastAPI wiring tests for the discovery service, without a database."""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from fastapi.testclient import TestClient

from healthmcp.discovery.app import create_app
from healthmcp.discovery.models import Service
from healthmcp.shared.auth import TokenVerifier, VerifiedUser
from tests.conftest import make_settings
from tests.unit.test_discovery import SERVICE, USER

PATIENT = UUID("50000000-0000-4000-8000-000000000001")


class FakeVerifier:
    async def verify(self, token: str) -> VerifiedUser:
        if token != "valid":
            from healthmcp.shared.auth import AuthError

            raise AuthError("bad token")
        return VerifiedUser(user_id=USER, claims={"sub": str(USER), "role": "authenticated"})


class FakeIdentity:
    def __init__(self, patient_id: UUID | None = PATIENT) -> None:
        self.patient_id = patient_id

    async def resolve_patient_id(self, ctx: Any) -> UUID | None:
        return self.patient_id


class FakeRepository:
    def __init__(self) -> None:
        self.services: list[Service] = [SERVICE]

    async def list_services(self, ctx: Any) -> list[Service]:
        return self.services

    async def resolve_service(self, ctx: Any, service_code: str | None, problem_text: str | None):
        if service_code == SERVICE.code:
            return SERVICE, []
        return None, []

    async def fetch_candidates(self, ctx: Any, **kwargs: Any) -> list[Any]:
        return []

    async def fetch_policy(self, ctx: Any, on_date: Any) -> None:
        return None

    async def fetch_coverage_rules(self, ctx: Any, **kwargs: Any) -> tuple[Any, ...]:
        return ()

    async def fetch_acceptances(self, ctx: Any, **kwargs: Any) -> dict[Any, Any]:
        return {}

    async def fetch_preferences(self, ctx: Any) -> Any:
        from healthmcp.discovery.models import PatientPreferences

        return PatientPreferences()


def _client(*, patient_id: UUID | None = PATIENT) -> TestClient:
    app = create_app(
        settings=make_settings(),
        database=cast(Any, object()),
        repository=cast(Any, FakeRepository()),
        identity=cast(Any, FakeIdentity(patient_id)),
        verifier=cast(TokenVerifier, FakeVerifier()),
    )
    return TestClient(app)


def test_healthz_does_not_need_auth() -> None:
    with _client() as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_missing_bearer_token_is_unauthorized() -> None:
    with _client() as client:
        response = client.get("/v1/services")

    assert response.status_code == 401


def test_list_services_response() -> None:
    with _client() as client:
        response = client.get("/v1/services", headers={"authorization": "Bearer valid"})

    assert response.status_code == 200
    assert response.json()[0]["code"] == SERVICE.code


def test_discovery_returns_an_empty_result_shape() -> None:
    with _client() as client:
        response = client.post(
            "/v1/discovery",
            headers={"authorization": "Bearer valid"},
            json={
                "service_code": SERVICE.code,
                "latitude": -27.48,
                "longitude": 153.01,
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["service"]["code"] == SERVICE.code
    assert payload["candidate_count"] == 0
    assert payload["clinics"] == []


def test_unknown_service_maps_to_404() -> None:
    with _client() as client:
        response = client.post(
            "/v1/discovery",
            headers={"authorization": "Bearer valid"},
            json={
                "service_code": "not_a_service",
                "latitude": -27.48,
                "longitude": 153.01,
            },
        )

    assert response.status_code == 404
    assert response.json()["error"] == "SERVICE_NOT_FOUND"


def test_missing_patient_is_forbidden() -> None:
    with _client(patient_id=None) as client:
        response = client.post(
            "/v1/discovery",
            headers={"authorization": "Bearer valid"},
            json={
                "service_code": SERVICE.code,
                "latitude": -27.48,
                "longitude": 153.01,
            },
        )

    assert response.status_code == 403
