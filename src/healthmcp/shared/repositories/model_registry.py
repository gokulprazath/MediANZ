"""model_registry: which engine implements each capability, and whether it may see health data."""

from __future__ import annotations

from dataclasses import asdict, replace
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict

from healthmcp.shared.db import Database
from healthmcp.shared.repositories.fake_data import MODEL_REGISTRY

Capability = Literal["decision", "extraction", "search", "places"]


class EngineEntry(BaseModel):
    model_config = ConfigDict(frozen=True)

    engine: str
    capability: Capability
    provider: str
    model: str
    model_version: str
    region: str | None
    zero_data_retention: bool
    allow_health_data: bool
    enabled: bool


class ModelRegistryRepository(Protocol):
    async def get(self, engine: str) -> EngineEntry | None: ...

    async def enabled_for(self, capability: Capability) -> list[EngineEntry]: ...


_COLUMNS = (
    "engine, capability, provider, model, model_version, region, zero_data_retention, "
    "allow_health_data, enabled"
)


class PgModelRegistryRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def get(self, engine: str) -> EngineEntry | None:
        async with self._db.infra_tx() as conn:
            cur = await conn.execute(
                f"select {_COLUMNS} from public.model_registry where engine = %s",  # noqa: S608
                [engine],
            )
            row = await cur.fetchone()
        return EngineEntry.model_validate(row) if row else None

    async def enabled_for(self, capability: Capability) -> list[EngineEntry]:
        async with self._db.infra_tx() as conn:
            cur = await conn.execute(
                f"select {_COLUMNS} from public.model_registry "  # noqa: S608
                "where capability = %s and enabled order by engine",
                [capability],
            )
            rows = await cur.fetchall()
        return [EngineEntry.model_validate(r) for r in rows]


class FakeModelRegistryRepository:
    def __init__(self) -> None:
        self._rows = {r.engine: r for r in MODEL_REGISTRY}

    async def get(self, engine: str) -> EngineEntry | None:
        row = self._rows.get(engine)
        return EngineEntry.model_validate(asdict(row)) if row else None

    async def enabled_for(self, capability: Capability) -> list[EngineEntry]:
        return [
            EngineEntry.model_validate(asdict(r))
            for r in sorted(self._rows.values(), key=lambda r: r.engine)
            if r.capability == capability and r.enabled
        ]

    def set(self, engine: str, **changes: object) -> None:
        """Test helper: change a row (e.g. enabled / allow_health_data)."""
        self._rows[engine] = replace(self._rows[engine], **changes)  # type: ignore[arg-type]
