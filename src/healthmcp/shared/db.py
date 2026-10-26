"""Database access: the only module that switches Postgres roles (spec 3.1).

  user_tx(ctx)  `set local role authenticated` + the verified JWT claims, so
                auth.uid(), current_patient_id() and RLS behave exactly as
                through the Supabase API. Never service_role.
  job_tx(ctx)   `set local role service_role`. Every query must filter by the
                ids in the job token: ScopedConnection refuses SQL that does
                not reference a %(scope_...)s parameter, and fills those
                parameters from the Context itself.
  infra_tx()    `set local role mcp_server`: agent logs, model registry, and
                the name check for the personal-information guard.

Repositories call `scoped(ctx)`; tool handlers never write SQL.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from typing import Any, Protocol

from psycopg import AsyncConnection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import AsyncConnectionPool

from healthmcp.shared.context import Context
from healthmcp.shared.errors import ScopeViolation

Row = dict[str, Any]
_SCOPE_PARAM = re.compile(r"%\(scope_[a-z_]+\)s")


def scope_params(ctx: Context) -> dict[str, Any]:
    """The ids a query may filter on, taken from the Context (never from tool arguments)."""
    return {
        "scope_patient_id": ctx.patient_id,
        "scope_appointment_id": ctx.appointment_id,
        "scope_clinician_id": ctx.clinician_id,
        "scope_job_id": ctx.job_id,
        "scope_user_id": ctx.user_id,
    }


class Executor(Protocol):
    async def execute(self, query: Any, params: Any = None) -> Any: ...


class ScopedConnection:
    """Runs queries for one Context inside its transaction.

    In job mode a query must reference at least one %(scope_...)s parameter,
    unless it is marked `reference=True` (registry / directory data that is
    not about any patient).
    """

    def __init__(self, conn: AsyncConnection[DictRow], ctx: Context) -> None:
        self._conn = conn
        self.ctx = ctx

    def _params(
        self, sql: str, params: Mapping[str, Any] | None, reference: bool
    ) -> dict[str, Any]:
        supplied = dict(params or {})
        clash = [k for k in supplied if k.startswith("scope_")]
        if clash:
            raise ValueError(f"scope parameters come from the context, not callers: {clash}")
        if self.ctx.mode == "job" and not reference and not _SCOPE_PARAM.search(sql):
            raise ScopeViolation()
        return {**scope_params(self.ctx), **supplied}

    async def fetch_all(
        self, sql: str, params: Mapping[str, Any] | None = None, *, reference: bool = False
    ) -> list[Row]:
        cur = await self._conn.execute(sql, self._params(sql, params, reference))
        return list(await cur.fetchall())

    async def fetch_one(
        self, sql: str, params: Mapping[str, Any] | None = None, *, reference: bool = False
    ) -> Row | None:
        cur = await self._conn.execute(sql, self._params(sql, params, reference))
        return await cur.fetchone()

    async def execute(
        self, sql: str, params: Mapping[str, Any] | None = None, *, reference: bool = False
    ) -> int:
        cur = await self._conn.execute(sql, self._params(sql, params, reference))
        return cur.rowcount


async def apply_user_role(conn: Executor, ctx: Context) -> None:
    if ctx.mode != "user" or not ctx.jwt_claims_json:
        raise ScopeViolation()
    await conn.execute("set local role authenticated")
    await conn.execute("select set_config('request.jwt.claims', %s, true)", [ctx.jwt_claims_json])


async def apply_job_role(conn: Executor, ctx: Context) -> None:
    if ctx.mode != "job":
        raise ScopeViolation()
    await conn.execute("set local role service_role")
    await conn.execute("select set_config('request.jwt.claims', '', true)")


async def apply_infra_role(conn: Executor) -> None:
    await conn.execute("set local role mcp_server")
    await conn.execute("select set_config('request.jwt.claims', '', true)")


class Database:
    def __init__(self, pool: AsyncConnectionPool[AsyncConnection[DictRow]]) -> None:
        self._pool = pool

    @classmethod
    def create(cls, dsn: str, *, min_size: int = 1, max_size: int = 5) -> Database:
        """A Database whose pool is opened later with `open()` (in the app lifespan)."""
        pool: AsyncConnectionPool[AsyncConnection[DictRow]] = AsyncConnectionPool(
            dsn,
            min_size=min_size,
            max_size=max_size,
            open=False,
            connection_class=AsyncConnection[DictRow],
            # prepare_threshold=None keeps this safe behind the transaction pooler too.
            kwargs={"autocommit": False, "row_factory": dict_row, "prepare_threshold": None},
        )
        return cls(pool)

    async def open(self) -> None:
        await self._pool.open(wait=True)

    async def close(self) -> None:
        await self._pool.close()

    @asynccontextmanager
    async def user_tx(self, ctx: Context) -> AsyncIterator[ScopedConnection]:
        async with self._pool.connection() as conn, conn.transaction():
            await apply_user_role(conn, ctx)
            yield ScopedConnection(conn, ctx)

    @asynccontextmanager
    async def job_tx(self, ctx: Context) -> AsyncIterator[ScopedConnection]:
        async with self._pool.connection() as conn, conn.transaction():
            await apply_job_role(conn, ctx)
            yield ScopedConnection(conn, ctx)

    @asynccontextmanager
    async def scoped(self, ctx: Context) -> AsyncIterator[ScopedConnection]:
        """user_tx or job_tx, chosen by the Context's mode."""
        tx = self.user_tx(ctx) if ctx.mode == "user" else self.job_tx(ctx)
        async with tx as sc:
            yield sc

    @asynccontextmanager
    async def infra_tx(self) -> AsyncIterator[AsyncConnection[DictRow]]:
        async with self._pool.connection() as conn, conn.transaction():
            await apply_infra_role(conn)
            yield conn
