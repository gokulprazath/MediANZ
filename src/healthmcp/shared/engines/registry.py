"""Engine selection from model_registry plus env keys.

Exactly one engine per capability may be enabled (a unique index enforces it).
The selected engine is used or the call fails: no silent fallback to another
engine, including the mocks. If it fails, the error propagates and the job
retries later.

Callers state whether the call will carry patient-derived text
(`health_data=True`); the selected engine must then have
allow_health_data = true, otherwise HealthDataNotAllowed is raised before
anything is sent.

`decision_review` is the SLM answering decision questions: explain questions,
and a second opinion when the decision engine (Jev) is not confident. It is
an explicit step, not a fallback, and it uses the enabled extraction entry, so
the same health-data approval applies.
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
    SlmDecisionEngine,
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

# Enabled extraction engine -> its decision-question implementation.
REVIEW_FACTORIES: Mapping[str, Factory] = {
    "slm": SlmDecisionEngine,
    "mock_extraction": MockDecisionEngine,
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
        review_factories: Mapping[str, Factory] = REVIEW_FACTORIES,
    ) -> None:
        self._settings = settings
        self._registry = registry
        self._factories = factories
        self._review_factories = review_factories
        self._instances: dict[tuple[str, str, str], Any] = {}

    async def _enabled(self, capability: Capability, *, health_data: bool) -> EngineEntry:
        entries = await self._registry.enabled_for(capability)
        if len(entries) != 1:
            raise EngineNotConfigured()
        entry = entries[0]
        if health_data and not entry.allow_health_data:
            raise HealthDataNotAllowed()
        return entry

    def _instance(self, role: str, entry: EngineEntry, factory: Factory) -> Selected[Any]:
        key = (role, entry.engine, entry.model_version)
        if key not in self._instances:
            # A constructor raises EngineNotConfigured when its keys are missing.
            self._instances[key] = factory(entry, self._settings)
        return Selected(self._instances[key], entry)

    async def _select(self, capability: Capability, *, health_data: bool) -> Selected[Any]:
        entry = await self._enabled(capability, health_data=health_data)
        spec = self._factories.get(entry.engine)
        if spec is None or spec[0] != capability:
            raise EngineNotConfigured()
        return self._instance(capability, entry, spec[1])

    async def decision_review(self, *, health_data: bool) -> Selected[DecisionEngine]:
        entry = await self._enabled("extraction", health_data=health_data)
        factory = self._review_factories.get(entry.engine)
        if factory is None:
            raise EngineNotConfigured()
        return cast(Selected[DecisionEngine], self._instance("review", entry, factory))

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
