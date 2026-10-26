"""Engine selection from model_registry plus env keys.

Exactly one engine per capability may be enabled (a unique index enforces it).
The selected engine is used or the call fails: no silent fallback to another
engine, including the mocks. If it fails, the error propagates and the job
retries later.

Callers state whether the call will carry patient-derived text
(`health_data=True`); the selected engine must then have
allow_health_data = true, otherwise HealthDataNotAllowed is raised before
anything is sent.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Generic, TypeVar, cast

from healthmcp.shared.config import Settings
from healthmcp.shared.engines.decision import (
    DecisionEngine,
    JevEngine,
    LlmAdapterEngine,
    MockDecisionEngine,
)
from healthmcp.shared.engines.extraction import (
    ExtractionEngine,
    MockExtractionEngine,
    OpenAICompatibleEngine,
)
from healthmcp.shared.engines.places import GooglePlacesClient, MockPlacesClient, PlacesClient
from healthmcp.shared.engines.search import MockSearchEngine, SearchEngine, TavilyEngine
from healthmcp.shared.errors import EngineNotConfigured, HealthDataNotAllowed
from healthmcp.shared.repositories.model_registry import (
    Capability,
    EngineEntry,
    ModelRegistryRepository,
)

E = TypeVar("E")
Factory = Callable[[EngineEntry, Settings], Any]

FACTORIES: Mapping[str, tuple[Capability, Factory]] = {
    "jev": ("decision", JevEngine),
    "llm_adapter": ("decision", LlmAdapterEngine),
    "mock_decision": ("decision", MockDecisionEngine),
    "slm": ("extraction", OpenAICompatibleEngine),
    "mock_extraction": ("extraction", MockExtractionEngine),
    "tavily": ("search", TavilyEngine),
    "mock_search": ("search", MockSearchEngine),
    "google_places": ("places", GooglePlacesClient),
    "mock_places": ("places", MockPlacesClient),
}


@dataclass(frozen=True)
class Selected(Generic[E]):
    engine: E
    entry: EngineEntry


class EngineRegistry:
    def __init__(
        self,
        settings: Settings,
        registry: ModelRegistryRepository,
        factories: Mapping[str, tuple[Capability, Factory]] = FACTORIES,
    ) -> None:
        self._settings = settings
        self._registry = registry
        self._factories = factories
        self._instances: dict[tuple[str, str], Any] = {}

    async def _select(self, capability: Capability, *, health_data: bool) -> Selected[Any]:
        entries = await self._registry.enabled_for(capability)
        if len(entries) != 1:
            raise EngineNotConfigured()
        entry = entries[0]
        if health_data and not entry.allow_health_data:
            raise HealthDataNotAllowed()
        spec = self._factories.get(entry.engine)
        if spec is None or spec[0] != capability:
            raise EngineNotConfigured()
        key = (entry.engine, entry.model_version)
        if key not in self._instances:
            # A constructor raises EngineNotConfigured when its keys are missing.
            self._instances[key] = spec[1](entry, self._settings)
        return Selected(self._instances[key], entry)

    async def decision(self, *, health_data: bool) -> Selected[DecisionEngine]:
        return cast(
            Selected[DecisionEngine], await self._select("decision", health_data=health_data)
        )

    async def extraction(self, *, health_data: bool) -> Selected[ExtractionEngine]:
        return cast(
            Selected[ExtractionEngine], await self._select("extraction", health_data=health_data)
        )

    async def search(self) -> Selected[SearchEngine]:
        # Queries are checked for personal information before they reach the engine.
        return cast(Selected[SearchEngine], await self._select("search", health_data=False))

    async def places(self) -> Selected[PlacesClient]:
        return cast(Selected[PlacesClient], await self._select("places", health_data=False))
