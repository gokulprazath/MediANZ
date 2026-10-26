"""Facility rating, review count and (in-memory only) review text.

Implementations:
  GooglePlacesClient  Places API (New) Place Details, called with httpx. Only the
                      place_id may be stored long term.
  MockPlacesClient    Fixture files under MOCK_FIXTURES_DIR/places/<place_id>.json.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Protocol

import httpx
from pydantic import TypeAdapter

from healthmcp.shared.config import Settings
from healthmcp.shared.engines.base import validated_call
from healthmcp.shared.engines.models import EngineInfo, PlaceDetails
from healthmcp.shared.errors import EngineFailure, EngineNotConfigured, NotFound
from healthmcp.shared.repositories.model_registry import EngineEntry

_DETAILS = TypeAdapter(PlaceDetails)
_PLACE_ID = re.compile(r"^[A-Za-z0-9_\-]{1,256}$")
PLACES_URL = "https://places.googleapis.com/v1/places/{place_id}"
FIELD_MASK = "id,rating,userRatingCount,reviews.text.text,googleMapsUri"


class PlacesClient(Protocol):
    info: EngineInfo

    async def get_place_summary(self, place_id: str) -> PlaceDetails: ...


def _info(entry: EngineEntry) -> EngineInfo:
    return EngineInfo(
        engine=entry.engine,
        provider=entry.provider,
        model=entry.model,
        model_version=entry.model_version,
    )


def _check_place_id(place_id: str) -> str:
    if not _PLACE_ID.match(place_id):
        raise NotFound()
    return place_id


class GooglePlacesClient:
    def __init__(
        self, entry: EngineEntry, settings: Settings, http: httpx.AsyncClient | None = None
    ) -> None:
        if settings.google_places_api_key is None:
            raise EngineNotConfigured("GOOGLE_PLACES_API_KEY is not set.")
        self.info = _info(entry)
        self._key = settings.google_places_api_key.get_secret_value()
        self._http = http or httpx.AsyncClient(timeout=15.0)

    async def get_place_summary(self, place_id: str) -> PlaceDetails:
        url = PLACES_URL.format(place_id=_check_place_id(place_id))

        async def call() -> Any:
            response = await self._http.get(
                url, headers={"X-Goog-Api-Key": self._key, "X-Goog-FieldMask": FIELD_MASK}
            )
            if response.status_code == 404:
                raise NotFound()
            if response.status_code != 200:
                raise EngineFailure()
            data = response.json()
            return {
                "place_id": place_id,
                "rating": data.get("rating"),
                "review_count": data.get("userRatingCount", 0),
                "reviews": [
                    r.get("text", {}).get("text", "")
                    for r in data.get("reviews", [])
                    if r.get("text", {}).get("text")
                ],
                "maps_url": data.get("googleMapsUri"),
            }

        return await validated_call(call, _DETAILS, engine=self.info.engine)


class MockPlacesClient:
    def __init__(self, entry: EngineEntry, settings: Settings) -> None:
        self.info = _info(entry)
        self._dir = Path(settings.mock_fixtures_dir) / "places"

    async def get_place_summary(self, place_id: str) -> PlaceDetails:
        path = self._dir / f"{_check_place_id(place_id)}.json"
        if not path.is_file():
            raise NotFound()

        async def call() -> Any:
            return json.loads(path.read_text(encoding="utf-8"))

        return await validated_call(call, _DETAILS, engine=self.info.engine)
