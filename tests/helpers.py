"""Token builders and an in-process MCP client for tests."""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import httpx2
import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from healthmcp.shared.auth import mint_job_token
from healthmcp.shared.context import Context
from healthmcp.shared.server import HealthServer

from .conftest import TEST_JOB_SECRET, TEST_JWT_SECRET, TEST_SUPABASE_URL


def user_token(
    sub: UUID | str,
    *,
    secret: str = TEST_JWT_SECRET,
    aud: str = "authenticated",
    role: str = "authenticated",
    expires_in: int = 3600,
    iss: str | None = f"{TEST_SUPABASE_URL}/auth/v1",
    **extra: Any,
) -> str:
    now = int(time.time())
    payload: dict[str, Any] = {
        "sub": str(sub),
        "aud": aud,
        "role": role,
        "iat": now,
        "exp": now + expires_in,
        "email": "someone@example.com",
        **extra,
    }
    if iss is not None:
        payload["iss"] = iss
    return jwt.encode(payload, secret, algorithm="HS256")


def job_token(agent_id: str = "clinical-doc-agent", **kwargs: Any) -> str:
    return mint_job_token(TEST_JOB_SECRET, agent_id=agent_id, **kwargs)


def es256_keypair(kid: str = "test-key-1") -> tuple[Any, dict[str, Any]]:
    private = ec.generate_private_key(ec.SECP256R1())
    jwk = jwt.algorithms.ECAlgorithm.to_jwk(private.public_key(), as_dict=True)
    jwk.update({"kid": kid, "alg": "ES256", "use": "sig"})
    return private, {"keys": [jwk]}


def job_context(**kwargs: Any) -> Context:
    values: dict[str, Any] = {
        "mode": "job",
        "agent_id": "clinical-doc-agent",
        "request_id": str(uuid.uuid4()),
        "job_id": "job-test",
    }
    values.update(kwargs)
    return Context(**values)


def user_context(
    user_id: UUID, patient_id: UUID | None, agent_id: str = "patient-assistant"
) -> Context:
    return Context.for_user(
        agent_id=agent_id,
        request_id=str(uuid.uuid4()),
        user_id=user_id,
        claims={"sub": str(user_id), "role": "authenticated"},
        patient_id=patient_id,
    )


@asynccontextmanager
async def running(server: HealthServer) -> AsyncIterator[httpx2.ASGITransport]:
    """Run the app lifespan and give an in-process transport (no sockets)."""
    async with server.app.router.lifespan_context(server.app):
        yield httpx2.ASGITransport(app=server.app)


def http_client(
    transport: httpx2.ASGITransport, server: HealthServer, headers: dict[str, str]
) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        transport=transport, base_url=f"http://127.0.0.1:{server.port}", headers=headers
    )


@asynccontextmanager
async def mcp_session(
    transport: httpx2.ASGITransport, server: HealthServer, headers: dict[str, str]
) -> AsyncIterator[ClientSession]:
    async with (
        http_client(transport, server, headers) as http,
        streamable_http_client(f"http://127.0.0.1:{server.port}/mcp", http_client=http) as (r, w),
        ClientSession(r, w) as session,
    ):
        await session.initialize()
        yield session
