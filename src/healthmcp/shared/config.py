"""Settings loaded from the environment (and `.env` at runtime). See `.env.example`."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

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
    jev_api_url: str = ""  # optional TypeSafe base URL; empty uses the SDK default
    jev_api_key: SecretStr | None = None
    jev_model: str = "jev-latest"
    slm_base_url: str = ""
    slm_api_key: SecretStr | None = None
    slm_model: str = ""
    # Nemotron-style hybrid models reason before answering unless told not to; on a
    # 20-segment extraction that was ~6k reasoning tokens (~30s) against ~100 tokens (~2s).
    # Set false for an endpoint that rejects `chat_template_kwargs`.
    slm_disable_thinking: bool = True
    # Per call. Serverless models can queue for a while under load (seen: 45-85 s).
    slm_timeout_seconds: float = Field(default=60.0, gt=0, le=300)
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
    # The patient agents' "today" and the zone they give dates in (the sample clinics are in QLD).
    agent_time_zone: str = "Australia/Brisbane"

    # Consult-notes worker (SLM facts + decision-engine key points from approved transcripts)
    consult_notes_window_segments: int = Field(default=20, ge=1, le=200)
    consult_notes_concurrency: int = Field(default=4, ge=1, le=32)
    consult_worker_poll_seconds: float = Field(default=10.0, gt=0, le=3600)
    consult_worker_max_attempts: int = Field(default=3, ge=1, le=10)
    # Decision-engine answers below this probability also get the SLM's opinion (then the GP).
    decision_review_below: float = Field(default=0.6, ge=0, le=1)

    # Runtime
    data_backend: Literal["pg", "fake"] = "pg"
    agents_config_path: Path = Path("config/agents.json")
    mock_fixtures_dir: Path = Path("tests/fixtures")
    host: str = "127.0.0.1"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_dir: Path | None = None  # also write <log_dir>/<service>.log (same redaction)
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
    def slm_extra_body(self) -> dict[str, Any] | None:
        """Extra request body for every SLM call (None sends nothing extra)."""
        if not self.slm_disable_thinking:
            return None
        return {"chat_template_kwargs": {"enable_thinking": False}}

    @property
    def agent_extra_body(self) -> dict[str, Any] | None:
        """The SLM's extra body, only while the agent falls back to the SLM's model."""
        return None if self.agent_llm_model else self.slm_extra_body

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
