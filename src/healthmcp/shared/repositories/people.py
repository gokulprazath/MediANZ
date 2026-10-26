"""Name check for the personal-information guard. Returns a boolean only:
patient names never leave the database."""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Protocol

from healthmcp.shared.db import Database
from healthmcp.shared.repositories.fake_data import PATIENTS, FakePatient

_NON_ALNUM = re.compile(r"[\W_]+")


def normalise_words(text: str) -> str:
    """Same normalisation as public.text_mentions_patient_name()."""
    return " " + _NON_ALNUM.sub(" ", text.lower()).strip() + " "


class PatientNameDirectory(Protocol):
    async def mentions_patient_name(self, text: str) -> bool: ...


class PgPatientNameDirectory:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def mentions_patient_name(self, text: str) -> bool:
        async with self._db.infra_tx() as conn:
            cur = await conn.execute(
                "select public.text_mentions_patient_name(%s::text) as found", [text]
            )
            row = await cur.fetchone()
        return bool(row and row["found"])


class FakePatientNameDirectory:
    def __init__(self, patients: Iterable[FakePatient] = PATIENTS) -> None:
        self._names: list[tuple[str, str, str]] = []
        for p in patients:
            first = normalise_words(p.first_name).strip()
            pref = normalise_words(p.preferred_name or p.first_name).strip()
            last = normalise_words(p.last_name).strip()
            self._names.append((first, pref, last))

    async def mentions_patient_name(self, text: str) -> bool:
        norm = normalise_words(text)
        return any(
            last
            and (
                f" {first} {last} " in norm
                or f" {pref} {last} " in norm
                or f" {last} {first} " in norm
            )
            for first, pref, last in self._names
        )
