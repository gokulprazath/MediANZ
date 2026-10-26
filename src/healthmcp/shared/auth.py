"""Bearer token verification for both request modes (spec 3.1).

User mode: a Supabase access token. Signed either with the project's
asymmetric signing keys (JWKS: ES256/RS256) or the legacy HS256 JWT secret;
the algorithm list is fixed per path, so a token cannot pick its own key type.
Must have aud=authenticated, role=authenticated, a sub, and not be expired.

Job mode: a short-lived HS256 token signed with JOB_TOKEN_SECRET
(iss=healthmcp-job, aud=healthmcp, lifetime <= 15 minutes).
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

import anyio
import jwt
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from healthmcp.shared.config import Settings
from healthmcp.shared.errors import NotAuthenticated

JOB_TOKEN_ISSUER = "healthmcp-job"  # noqa: S105 (not a secret)
JOB_TOKEN_AUDIENCE = "healthmcp"  # noqa: S105 (not a secret)
MAX_JOB_TOKEN_SECONDS = 15 * 60
USER_AUDIENCE = "authenticated"
ASYMMETRIC_ALGORITHMS = ("ES256", "RS256")
LEEWAY_SECONDS = 30
MIN_SECRET_BYTES = 32


class AuthError(NotAuthenticated):
    """Token rejected. `reason` is for server logs only."""

    def __init__(self, reason: str) -> None:
        super().__init__()
        self.reason = reason


class JobClaims(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    agent_id: str = Field(min_length=1, max_length=64)
    job_id: str = Field(min_length=1, max_length=128)
    appointment_id: UUID | None = None
    patient_id: UUID | None = None
    clinician_id: UUID | None = None
    scope: tuple[str, ...] = ()
    iat: int
    exp: int


@dataclass(frozen=True)
class VerifiedUser:
    user_id: UUID
    claims: Mapping[str, Any]


@dataclass(frozen=True)
class VerifiedJob:
    claims: JobClaims


class SigningKeyProvider(Protocol):
    async def get_key(self, kid: str | None) -> Any: ...


class JwksKeyProvider:
    """Fetches the project's JWKS (cached). PyJWKClient is synchronous, so it runs in a thread."""

    def __init__(self, url: str, cache_seconds: int = 300) -> None:
        self._client = jwt.PyJWKClient(url, cache_keys=True, lifespan=max(cache_seconds, 1))

    async def get_key(self, kid: str | None) -> Any:
        if not kid:
            raise AuthError("asymmetric token without kid")

        def _fetch() -> Any:
            return self._client.get_signing_key(kid).key

        try:
            return await anyio.to_thread.run_sync(_fetch)
        except jwt.PyJWKClientError as exc:
            raise AuthError("signing key not found") from exc


class StaticKeyProvider:
    """A fixed JWKS document (tests, or a pinned key set)."""

    def __init__(self, jwks: Mapping[str, Any]) -> None:
        keys = jwt.PyJWKSet.from_dict(dict(jwks)).keys if jwks.get("keys") else []
        self._keys = {k.key_id: k.key for k in keys}

    async def get_key(self, kid: str | None) -> Any:
        if kid is None or kid not in self._keys:
            raise AuthError("signing key not found")
        return self._keys[kid]


def _secret(value: Any, name: str) -> bytes:
    raw = value.get_secret_value().encode() if value is not None else b""
    if len(raw) < MIN_SECRET_BYTES:
        raise ValueError(f"{name} must be at least {MIN_SECRET_BYTES} bytes")
    return raw


class TokenVerifier:
    def __init__(self, settings: Settings, key_provider: SigningKeyProvider | None = None) -> None:
        self._issuer = settings.supabase_issuer
        self._hs_secret = (
            settings.supabase_jwt_secret.get_secret_value().encode()
            if settings.supabase_jwt_secret
            else None
        )
        self._job_secret = (
            _secret(settings.job_token_secret, "JOB_TOKEN_SECRET")
            if settings.job_token_secret
            else None
        )
        if self._job_secret is not None and self._job_secret == self._hs_secret:
            raise ValueError("JOB_TOKEN_SECRET must differ from SUPABASE_JWT_SECRET")
        if key_provider is None and settings.jwks_url:
            key_provider = JwksKeyProvider(settings.jwks_url, settings.jwks_cache_seconds)
        self._keys = key_provider

    async def verify(self, token: str) -> VerifiedUser | VerifiedJob:
        try:
            header = jwt.get_unverified_header(token)
            unverified = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError as exc:
            raise AuthError("malformed token") from exc
        if unverified.get("iss") == JOB_TOKEN_ISSUER:
            return self._verify_job(token)
        return await self._verify_user(token, header)

    def _verify_job(self, token: str) -> VerifiedJob:
        if self._job_secret is None:
            raise AuthError("job tokens are not configured")
        try:
            payload = jwt.decode(
                token,
                self._job_secret,
                algorithms=["HS256"],
                audience=JOB_TOKEN_AUDIENCE,
                issuer=JOB_TOKEN_ISSUER,
                leeway=LEEWAY_SECONDS,
                options={"require": ["exp", "iat", "iss", "aud"]},
            )
            claims = JobClaims.model_validate(payload)
        except (jwt.PyJWTError, ValidationError) as exc:
            raise AuthError("invalid job token") from exc
        if claims.exp - claims.iat > MAX_JOB_TOKEN_SECONDS:
            raise AuthError("job token lifetime too long")
        if claims.iat > time.time() + LEEWAY_SECONDS:
            raise AuthError("job token issued in the future")
        return VerifiedJob(claims)

    async def _verify_user(self, token: str, header: Mapping[str, Any]) -> VerifiedUser:
        alg = header.get("alg")
        key: Any
        algorithms: Sequence[str]
        if alg == "HS256":
            if self._hs_secret is None:
                raise AuthError("HS256 tokens are not configured")
            key, algorithms = self._hs_secret, ["HS256"]
        elif alg in ASYMMETRIC_ALGORITHMS:
            if self._keys is None:
                raise AuthError("JWKS is not configured")
            key, algorithms = (
                await self._keys.get_key(header.get("kid")),
                list(ASYMMETRIC_ALGORITHMS),
            )
        else:
            raise AuthError("unsupported algorithm")

        required = ["exp", "sub", "aud"] + (["iss"] if self._issuer else [])
        try:
            payload: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=algorithms,
                audience=USER_AUDIENCE,
                issuer=self._issuer,
                leeway=LEEWAY_SECONDS,
                options={"require": required},
            )
        except jwt.PyJWTError as exc:
            raise AuthError("invalid user token") from exc
        if payload.get("role") != "authenticated":
            raise AuthError("token role is not authenticated")
        try:
            user_id = UUID(str(payload["sub"]))
        except ValueError as exc:
            raise AuthError("sub is not a uuid") from exc
        return VerifiedUser(user_id=user_id, claims=payload)


def mint_job_token(
    secret: str,
    *,
    agent_id: str,
    job_id: str | None = None,
    appointment_id: UUID | str | None = None,
    patient_id: UUID | str | None = None,
    clinician_id: UUID | str | None = None,
    scope: Sequence[str] = (),
    lifetime_seconds: int = MAX_JOB_TOKEN_SECONDS,
    now: int | None = None,
) -> str:
    """Create a job token (scripts/mint_job_token.py and tests)."""
    if len(secret.encode()) < MIN_SECRET_BYTES:
        raise ValueError(f"secret must be at least {MIN_SECRET_BYTES} bytes")
    if not 0 < lifetime_seconds <= MAX_JOB_TOKEN_SECONDS:
        raise ValueError("lifetime must be between 1 second and 15 minutes")
    issued = int(now if now is not None else time.time())
    payload: dict[str, Any] = {
        "iss": JOB_TOKEN_ISSUER,
        "aud": JOB_TOKEN_AUDIENCE,
        "iat": issued,
        "exp": issued + lifetime_seconds,
        "agent_id": agent_id,
        "job_id": job_id or f"job-{uuid.uuid4()}",
        "scope": list(scope),
    }
    for name, value in (
        ("appointment_id", appointment_id),
        ("patient_id", patient_id),
        ("clinician_id", clinician_id),
    ):
        if value is not None:
            payload[name] = str(UUID(str(value)))
    return jwt.encode(payload, secret, algorithm="HS256")
