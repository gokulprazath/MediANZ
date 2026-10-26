"""Web search and page extraction.

Implementations:
  TavilyEngine      Tavily search API (AsyncTavilyClient). Not a model.
  MockSearchEngine  Fixture files under MOCK_FIXTURES_DIR/search/*.json.

Domain allowlisting and the personal-information check happen in the tools
before an engine is called; engines only receive already-checked input.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

from pydantic import TypeAdapter

from healthmcp.shared.config import Settings
from healthmcp.shared.engines.base import validated_call
from healthmcp.shared.engines.models import EngineInfo, ExtractedPage, SearchResult
from healthmcp.shared.errors import EngineNotConfigured
from healthmcp.shared.repositories.model_registry import EngineEntry

_RESULTS = TypeAdapter(list[SearchResult])
_PAGES = TypeAdapter(list[ExtractedPage])


class SearchEngine(Protocol):
    info: EngineInfo

    async def search(
        self, query: str, domains: Sequence[str], max_results: int = 5
    ) -> list[SearchResult]: ...

    async def extract(self, urls: Sequence[str]) -> list[ExtractedPage]: ...


def _info(entry: EngineEntry) -> EngineInfo:
    return EngineInfo(
        engine=entry.engine,
        provider=entry.provider,
        model=entry.model,
        model_version=entry.model_version,
    )


def _on_domains(url: str, domains: Sequence[str]) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == d or host.endswith("." + d) for d in domains)


class TavilyEngine:
    def __init__(self, entry: EngineEntry, settings: Settings) -> None:
        if settings.tavily_api_key is None:
            raise EngineNotConfigured("TAVILY_API_KEY is not set.")
        from tavily import AsyncTavilyClient

        self.info = _info(entry)
        self._client = AsyncTavilyClient(api_key=settings.tavily_api_key.get_secret_value())

    async def search(
        self, query: str, domains: Sequence[str], max_results: int = 5
    ) -> list[SearchResult]:
        async def call() -> Any:
            response = await self._client.search(
                query, max_results=max_results, include_domains=list(domains)
            )
            return [
                {
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "content": r.get("content", ""),
                    "score": r.get("score"),
                }
                for r in response.get("results", [])
                if _on_domains(r.get("url", ""), domains)  # never trust the filter blindly
            ]

        return await validated_call(call, _RESULTS, engine=self.info.engine)

    async def extract(self, urls: Sequence[str]) -> list[ExtractedPage]:
        async def call() -> Any:
            response = await self._client.extract(list(urls))
            return [
                {"url": r.get("url", ""), "content": r.get("raw_content", "")}
                for r in response.get("results", [])
            ]

        return await validated_call(call, _PAGES, engine=self.info.engine)


class MockSearchEngine:
    """Searches fixture pages: a page matches when a query word is in its title or content."""

    def __init__(self, entry: EngineEntry, settings: Settings) -> None:
        self.info = _info(entry)
        self._dir = Path(settings.mock_fixtures_dir) / "search"

    def _pages(self) -> list[dict[str, Any]]:
        pages: list[dict[str, Any]] = []
        for path in sorted(self._dir.glob("*.json")):
            pages.extend(json.loads(path.read_text(encoding="utf-8")))
        return pages

    async def search(
        self, query: str, domains: Sequence[str], max_results: int = 5
    ) -> list[SearchResult]:
        words = {w for w in query.lower().split() if len(w) > 2}

        async def call() -> Any:
            hits = []
            for page in self._pages():
                if not _on_domains(page["url"], domains):
                    continue
                haystack = f"{page['title']} {page['content']}".lower()
                score = sum(1 for w in words if w in haystack)
                if score:
                    hits.append({**page, "score": round(score / max(len(words), 1), 3)})
            hits.sort(key=lambda p: (-p["score"], p["url"]))
            return hits[:max_results]

        return await validated_call(call, _RESULTS, engine=self.info.engine)

    async def extract(self, urls: Sequence[str]) -> list[ExtractedPage]:
        async def call() -> Any:
            by_url = {p["url"]: p for p in self._pages()}
            return [{"url": u, "content": by_url[u]["content"]} for u in urls if u in by_url]

        return await validated_call(call, _PAGES, engine=self.info.engine)
