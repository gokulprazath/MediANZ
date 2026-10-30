"""Helpers shared by the seven servers.

Each server package has `repository.py` (Protocol, Pg, Fake), `tools.py`
(`register(server, repo=None)`) and `__main__.py`. A server with a database
uses the Pg repository; with DATA_BACKEND=fake it uses the Fake. Tool
handlers never write SQL; they call their repository, which runs every query
through db.py.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager

from healthmcp.shared.errors import (
    HealthMcpError,
    InvalidRequest,
    NotFound,
    ScopeViolation,
)
from healthmcp.shared.server import HealthServer, ServerDeps, create_server, run_server

Register = Callable[[HealthServer], None]


def build(name: str, register: Register, deps: ServerDeps | None = None) -> HealthServer:
    server = create_server(name, deps=deps)
    register(server)
    return server


def main(name: str, register: Register) -> None:
    run_server(build(name, register))


# Postgres errors a tool may turn into a safe, specific message. The SQLSTATE is
# read from the exception attribute, so this module does not import psycopg.
_NOT_FOUND_STATES = frozenset({"42501", "P0002"})  # insufficient privilege, no data found
_INVALID_STATES = frozenset({"22000", "22007", "22008", "22P02", "23502", "23514", "P0001"})


@contextmanager
def database_errors(*, not_found: str | None = None, invalid: str | None = None) -> Iterator[None]:
    """Map refusals raised inside the database to short tool errors.

    Row-level security and the security-definer functions raise 42501 for
    records outside the caller's scope; those surface as NotFound so the agent
    learns nothing about other patients' data.
    """
    try:
        yield
    except HealthMcpError:
        raise
    except Exception as exc:
        state = getattr(exc, "sqlstate", None)
        if state in _NOT_FOUND_STATES:
            raise NotFound(not_found) from exc
        if state in _INVALID_STATES:
            raise InvalidRequest(invalid) from exc
        raise


def same_ids(requested: list[object], found: list[object]) -> None:
    """Every requested id must have been found inside the request's scope."""
    if set(requested) != set(found):
        raise ScopeViolation()
