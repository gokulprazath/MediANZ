"""Shared test setup. Unit tests run fully offline: any network connection fails."""

from __future__ import annotations

import os
import socket
from pathlib import Path
from typing import Any

import pytest

from healthmcp.shared.config import Settings

ROOT = Path(__file__).resolve().parent.parent
TEST_SUPABASE_URL = "https://testproject.supabase.co"
TEST_JWT_SECRET = "test-supabase-jwt-secret-0123456789abcdef"
TEST_JOB_SECRET = "test-job-token-secret-0123456789abcdefghij"

INTEGRATION = os.environ.get("RUN_INTEGRATION") == "1"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if INTEGRATION:
        return
    skip = pytest.mark.skip(reason="integration test: set RUN_INTEGRATION=1")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def _isolated_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests never see the developer's environment (or .env) and never use the network."""
    if INTEGRATION:
        return
    for name in Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)

    def no_network(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("network access attempted in an offline test")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    monkeypatch.setattr(socket.socket, "connect_ex", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    monkeypatch.setattr(socket, "getaddrinfo", no_network)


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "supabase_url": TEST_SUPABASE_URL,
        "supabase_jwt_secret": TEST_JWT_SECRET,
        "job_token_secret": TEST_JOB_SECRET,
        "data_backend": "fake",
        "agents_config_path": ROOT / "config" / "agents.json",
        "mock_fixtures_dir": ROOT / "tests" / "fixtures",
    }
    values.update(overrides)
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


@pytest.fixture
def settings() -> Settings:
    return make_settings()
