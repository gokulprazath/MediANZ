"""Database behaviour tests (spec 4.10).

Skipped unless RUN_INTEGRATION=1. Every test runs inside one transaction that
is rolled back, so nothing is left behind. Test logins are created inside that
transaction with ids from the ee000000- namespace.

DATABASE_URL is read from the environment, falling back to the project
settings (.env) only when it is not set.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

pytestmark = pytest.mark.integration

OLIVIA = "50000000-0000-4000-8000-000000000001"
JACK = "50000000-0000-4000-8000-000000000002"
PRIYA = "50000000-0000-4000-8000-000000000003"
LUKAS = "50000000-0000-4000-8000-000000000006"
DR_RAO = "40000000-0000-4000-8000-000000000001"
DR_NGUYEN = "40000000-0000-4000-8000-000000000002"
DR_WILLIAMS = "40000000-0000-4000-8000-000000000003"
SOUTHBANK = "30000000-0000-4000-8000-000000000001"
PADDINGTON = "30000000-0000-4000-8000-000000000002"
OLIVIA_APPROVED_APPT = "60000000-0000-4000-8000-000000000002"
OLIVIA_APPROVED_TRANSCRIPT = "71000000-0000-4000-8000-000000000001"
LUKAS_PENDING_TRANSCRIPT = "71000000-0000-4000-8000-000000000002"
LUKAS_APPT = "60000000-0000-4000-8000-000000000012"

# Auth user ids created inside each test transaction.
USERS = {
    "olivia": ("ee000000-0000-4000-8000-000000000001", "patients", OLIVIA),
    "jack": ("ee000000-0000-4000-8000-000000000002", "patients", JACK),
    "priya": ("ee000000-0000-4000-8000-000000000003", "patients", PRIYA),
    "lukas": ("ee000000-0000-4000-8000-000000000004", "patients", LUKAS),
    "rao": ("ee000000-0000-4000-8000-000000000011", "clinicians", DR_RAO),
    "williams": ("ee000000-0000-4000-8000-000000000012", "clinicians", DR_WILLIAMS),
    "staff": ("ee000000-0000-4000-8000-000000000021", None, None),
}


def _dsn() -> str:
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return dsn
    from healthmcp.shared.config import Settings

    settings = Settings()
    if settings.database_url is None:
        pytest.skip("DATABASE_URL is not configured")
    return settings.database_url.get_secret_value()


@pytest.fixture(scope="session")
def dsn() -> str:
    if os.environ.get("RUN_INTEGRATION") != "1":
        pytest.skip("database tests need RUN_INTEGRATION=1")
    return _dsn()


class Db:
    """One connection, one transaction, rolled back at the end of the test."""

    def __init__(self, conn: psycopg.Connection[dict[str, Any]]) -> None:
        self.conn = conn

    def q(self, sql: str, params: Any = None) -> list[dict[str, Any]]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)  # type: ignore[arg-type]
            return cur.fetchall() if cur.description else []

    def one(self, sql: str, params: Any = None) -> dict[str, Any]:
        rows = self.q(sql, params)
        assert len(rows) == 1, rows
        return rows[0]

    def val(self, sql: str, params: Any = None) -> Any:
        return next(iter(self.one(sql, params).values()))

    def as_admin(self) -> None:
        self.q("reset role")
        self.q("select set_config('request.jwt.claims', '', true)")

    def as_user(self, who: str) -> None:
        uid = USERS[who][0]
        claims: dict[str, Any] = {"sub": uid, "role": "authenticated", "aud": "authenticated"}
        if who == "staff":
            claims["app_metadata"] = {"role": "staff"}
        self.q("reset role")
        self.q("set local role authenticated")
        self.q("select set_config('request.jwt.claims', %s, true)", [json.dumps(claims)])

    def as_role(self, role: str) -> None:
        assert role in {"service_role", "mcp_server", "authenticated", "anon"}
        self.q("reset role")
        self.q("select set_config('request.jwt.claims', '', true)")
        self.q(f"set local role {role}")

    def savepoint_error(self, sql: str, params: Any = None) -> psycopg.Error:
        """Run SQL expected to fail; keep the outer transaction usable."""
        with self.conn.cursor() as cur:
            cur.execute("savepoint expect_error")
            try:
                cur.execute(sql, params)  # type: ignore[arg-type]
            except psycopg.Error as exc:
                cur.execute("rollback to savepoint expect_error")
                return exc
            cur.execute("release savepoint expect_error")
        raise AssertionError(f"expected an error from: {sql}")


@pytest.fixture
def db(dsn: str) -> Iterator[Db]:
    with psycopg.connect(dsn, autocommit=False, row_factory=dict_row) as conn:
        d = Db(conn)
        try:
            for uid, table, person_id in USERS.values():
                d.q(
                    "insert into auth.users (id, email) values (%s, %s) on conflict (id) do nothing",
                    [uid, f"mcp-test+{uid[-4:]}@example.com"],
                )
                if table:
                    # Unlink any existing login for this person (rolled back), then link ours.
                    d.q(
                        f"update public.{table} set auth_user_id = %s where id = %s",
                        [uid, person_id],
                    )
            yield d
        finally:
            conn.rollback()
