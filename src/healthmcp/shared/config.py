"""Settings loaded from the environment (and `.env` at runtime). See `.env.example`."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_RESEARCH_DOMAINS = (
    "privatehealth.gov.au,data.gov.au,sunstate.example.com,harbourside.example.com,"
    "campuscover.example.com,wanderer.example.com"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", frozen=True
    )

    # Supabase (development project only)
    supabase_url: str = ""
    supabase_anon_key: SecretStr | None = None
    supabase_service_role_key: SecretStr | None = None
    supabase_jwt_secret: SecretStr | None = None
    database_url: SecretStr | None = None
    job_token_secret: SecretStr | None = None
    smoke_olivia_password: SecretStr | None = None

    # Engines (all optional: mock engines need none of these)
    jev_api_url: str = ""
    jev_api_key: SecretStr | None = None
    jev_docs_path: str = ""
    slm_base_url: str = ""
    slm_api_key: SecretStr | None = None
    slm_model: str = ""
    tavily_api_key: SecretStr | None = None
    google_places_api_key: SecretStr | None = None

    allowed_research_domains: str = DEFAULT_RESEARCH_DOMAINS

    # Agent layer (LangGraph + MCP gateway). The LLM is optional: endpoints return 503
    # until one is configured, and tests inject a model.
    agent_gateway_url: str = "http://127.0.0.1:3100/mcp"
    agent_gateway_timeout_seconds: float = Field(default=30.0, gt=0)
    agent_llm_base_url: str = ""
    agent_llm_api_key: SecretStr | None = None
    agent_llm_model: str = ""
    agent_llm_temperature: float = Field(default=0.0, ge=0, le=2)
    agent_max_steps: int = Field(default=8, ge=1, le=20)
    agent_action_ttl_seconds: int = Field(default=300, ge=30, le=900)
    agent_port: int = Field(default=3108, ge=1, le=65535)

    # Runtime
    data_backend: Literal["pg", "fake"] = "pg"
    agents_config_path: Path = Path("config/agents.json")
    mock_fixtures_dir: Path = Path("tests/fixtures")
    host: str = "127.0.0.1"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    max_request_bytes: int = Field(default=256 * 1024, ge=1024, le=10 * 1024 * 1024)
    rate_limit_per_minute: int = Field(default=120, ge=1)
    db_pool_min_size: int = Field(default=1, ge=0)
    db_pool_max_size: int = Field(default=5, ge=1)
    jwks_cache_seconds: int = Field(default=300, ge=0)

    @field_validator("supabase_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @property
    def research_domains(self) -> tuple[str, ...]:
        return tuple(
            d.strip().lower().rstrip(".")
            for d in self.allowed_research_domains.split(",")
            if d.strip()
        )

    @property
    def agent_model(self) -> str:
        return self.agent_llm_model or self.slm_model

    @property
    def agent_base_url(self) -> str:
        return self.agent_llm_base_url or self.slm_base_url

    @property
    def agent_api_key(self) -> SecretStr | None:
        return self.agent_llm_api_key or self.slm_api_key

    @property
    def supabase_issuer(self) -> str | None:
        return f"{self.supabase_url}/auth/v1" if self.supabase_url else None

    @property
    def jwks_url(self) -> str | None:
        return f"{self.supabase_url}/auth/v1/.well-known/jwks.json" if self.supabase_url else None


def load_settings() -> Settings:
    return Settings()
