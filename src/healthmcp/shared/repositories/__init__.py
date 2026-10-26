"""Repositories: the only way code reaches the database.

Each area has a Protocol, a Pg implementation (psycopg, through db.py) and an
in-memory Fake whose fixtures mirror supabase/seed/ (same ids).
"""

from __future__ import annotations

from dataclasses import dataclass

from healthmcp.shared.db import Database
from healthmcp.shared.repositories.audit import (
    AuditRepository,
    FakeAuditRepository,
    PgAuditRepository,
)
from healthmcp.shared.repositories.identity import (
    FakeIdentityRepository,
    IdentityRepository,
    PgIdentityRepository,
)
from healthmcp.shared.repositories.model_registry import (
    FakeModelRegistryRepository,
    ModelRegistryRepository,
    PgModelRegistryRepository,
)
from healthmcp.shared.repositories.people import (
    FakePatientNameDirectory,
    PatientNameDirectory,
    PgPatientNameDirectory,
)


@dataclass(frozen=True)
class Repositories:
    identity: IdentityRepository
    model_registry: ModelRegistryRepository
    audit: AuditRepository
    patient_names: PatientNameDirectory


def pg_repositories(db: Database) -> Repositories:
    return Repositories(
        identity=PgIdentityRepository(db),
        model_registry=PgModelRegistryRepository(db),
        audit=PgAuditRepository(db),
        patient_names=PgPatientNameDirectory(db),
    )


def fake_repositories() -> Repositories:
    return Repositories(
        identity=FakeIdentityRepository(),
        model_registry=FakeModelRegistryRepository(),
        audit=FakeAuditRepository(),
        patient_names=FakePatientNameDirectory(),
    )


__all__ = [
    "AuditRepository",
    "IdentityRepository",
    "ModelRegistryRepository",
    "PatientNameDirectory",
    "Repositories",
    "fake_repositories",
    "pg_repositories",
]
