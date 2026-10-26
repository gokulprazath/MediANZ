"""Who is the signed-in user? (user mode: patient id via current_patient_id())."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol
from uuid import UUID

from healthmcp.shared.context import Context
from healthmcp.shared.db import Database
from healthmcp.shared.repositories.fake_data import FAKE_AUTH_USERS


class IdentityRepository(Protocol):
    async def resolve_patient_id(self, ctx: Context) -> UUID | None:
        """The patient profile linked to the signed-in user, or None."""
        ...


class PgIdentityRepository:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def resolve_patient_id(self, ctx: Context) -> UUID | None:
        async with self._db.user_tx(ctx) as sc:
            row = await sc.fetch_one("select public.current_patient_id() as patient_id")
        return row["patient_id"] if row else None


class FakeIdentityRepository:
    def __init__(self, users: Mapping[UUID, UUID] | None = None) -> None:
        self._users = dict(FAKE_AUTH_USERS if users is None else users)

    async def resolve_patient_id(self, ctx: Context) -> UUID | None:
        return self._users.get(ctx.user_id) if ctx.user_id else None
