from __future__ import annotations

import time
import uuid

import jwt
import pytest

from healthmcp.shared.auth import (
    JOB_TOKEN_AUDIENCE,
    JOB_TOKEN_ISSUER,
    AuthError,
    StaticKeyProvider,
    TokenVerifier,
    VerifiedJob,
    VerifiedUser,
    mint_job_token,
)
from healthmcp.shared.config import Settings
from tests.conftest import TEST_JOB_SECRET, TEST_JWT_SECRET, TEST_SUPABASE_URL, make_settings
from tests.helpers import es256_keypair, job_token, user_token

USER = uuid.UUID("aa000000-0000-4000-8000-000000000001")
APPT = "60000000-0000-4000-8000-000000000002"


@pytest.fixture
def verifier(settings: Settings) -> TokenVerifier:
    return TokenVerifier(settings, key_provider=StaticKeyProvider({"keys": []}))


async def test_valid_hs256_user_token(verifier: TokenVerifier) -> None:
    result = await verifier.verify(user_token(USER))
    assert isinstance(result, VerifiedUser)
    assert result.user_id == USER
    assert result.claims["role"] == "authenticated"


@pytest.mark.parametrize(
    "token_kwargs",
    [
        {"secret": "a-completely-different-secret-0123456789"},
        {"aud": "anon"},
        {"role": "anon"},
        {"role": "service_role"},
        {"expires_in": -120},
        {"iss": "https://someone-else.supabase.co/auth/v1"},
        {"iss": None},
    ],
    ids=[
        "wrong-secret",
        "wrong-aud",
        "anon-role",
        "service-role",
        "expired",
        "wrong-iss",
        "no-iss",
    ],
)
async def test_rejected_user_tokens(
    verifier: TokenVerifier, token_kwargs: dict[str, object]
) -> None:
    with pytest.raises(AuthError):
        await verifier.verify(user_token(USER, **token_kwargs))  # type: ignore[arg-type]


async def test_sub_must_be_uuid(verifier: TokenVerifier) -> None:
    with pytest.raises(AuthError):
        await verifier.verify(user_token("not-a-uuid"))


async def test_alg_none_and_garbage_rejected(verifier: TokenVerifier) -> None:
    unsigned = jwt.encode(
        {
            "sub": str(USER),
            "aud": "authenticated",
            "role": "authenticated",
            "exp": int(time.time()) + 60,
        },
        key="",
        algorithm="none",
    )
    with pytest.raises(AuthError):
        await verifier.verify(unsigned)
    with pytest.raises(AuthError):
        await verifier.verify("not.a.jwt")


async def test_es256_via_jwks() -> None:
    private, jwks = es256_keypair()
    verifier = TokenVerifier(make_settings(supabase_jwt_secret=None), StaticKeyProvider(jwks))
    now = int(time.time())
    token = jwt.encode(
        {
            "sub": str(USER),
            "aud": "authenticated",
            "role": "authenticated",
            "iat": now,
            "exp": now + 600,
            "iss": f"{TEST_SUPABASE_URL}/auth/v1",
        },
        private,
        algorithm="ES256",
        headers={"kid": "test-key-1"},
    )
    result = await verifier.verify(token)
    assert isinstance(result, VerifiedUser) and result.user_id == USER

    # HS256 is refused when no legacy secret is configured.
    with pytest.raises(AuthError):
        await verifier.verify(user_token(USER))

    # Unknown kid.
    other = jwt.encode(
        {
            "sub": str(USER),
            "aud": "authenticated",
            "role": "authenticated",
            "exp": now + 600,
            "iss": f"{TEST_SUPABASE_URL}/auth/v1",
        },
        private,
        algorithm="ES256",
        headers={"kid": "unknown"},
    )
    with pytest.raises(AuthError):
        await verifier.verify(other)


async def test_valid_job_token(verifier: TokenVerifier) -> None:
    token = job_token(appointment_id=APPT, scope=["transcript:read"])
    result = await verifier.verify(token)
    assert isinstance(result, VerifiedJob)
    assert result.claims.agent_id == "clinical-doc-agent"
    assert str(result.claims.appointment_id) == APPT
    assert result.claims.scope == ("transcript:read",)


async def test_job_token_lifetime_limited(verifier: TokenVerifier) -> None:
    with pytest.raises(ValueError):
        mint_job_token(TEST_JOB_SECRET, agent_id="research-job", lifetime_seconds=16 * 60)
    now = int(time.time())
    forged = jwt.encode(
        {
            "iss": JOB_TOKEN_ISSUER,
            "aud": JOB_TOKEN_AUDIENCE,
            "iat": now,
            "exp": now + 3600,
            "agent_id": "research-job",
            "job_id": "j1",
        },
        TEST_JOB_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(AuthError):
        await verifier.verify(forged)


@pytest.mark.parametrize(
    "secret_or_claims",
    [
        {"secret": TEST_JWT_SECRET},  # signed with the Supabase secret, not the job secret
        {"drop": "agent_id"},
        {"drop": "iat"},
        {"aud": "authenticated"},
    ],
)
async def test_rejected_job_tokens(
    verifier: TokenVerifier, secret_or_claims: dict[str, str]
) -> None:
    now = int(time.time())
    claims = {
        "iss": JOB_TOKEN_ISSUER,
        "aud": JOB_TOKEN_AUDIENCE,
        "iat": now,
        "exp": now + 300,
        "agent_id": "clinical-doc-agent",
        "job_id": "j1",
    }
    if "drop" in secret_or_claims:
        claims.pop(secret_or_claims["drop"])
    if "aud" in secret_or_claims:
        claims["aud"] = secret_or_claims["aud"]
    token = jwt.encode(claims, secret_or_claims.get("secret", TEST_JOB_SECRET), algorithm="HS256")
    with pytest.raises(AuthError):
        await verifier.verify(token)


async def test_expired_job_token(verifier: TokenVerifier) -> None:
    token = mint_job_token(
        TEST_JOB_SECRET, agent_id="research-job", lifetime_seconds=60, now=int(time.time()) - 600
    )
    with pytest.raises(AuthError):
        await verifier.verify(token)


def test_job_secret_must_be_long_and_distinct() -> None:
    with pytest.raises(ValueError):
        TokenVerifier(make_settings(job_token_secret="short"))
    with pytest.raises(ValueError):
        TokenVerifier(make_settings(job_token_secret=TEST_JWT_SECRET))


async def test_job_tokens_refused_when_not_configured() -> None:
    verifier = TokenVerifier(make_settings(job_token_secret=None), StaticKeyProvider({"keys": []}))
    with pytest.raises(AuthError):
        await verifier.verify(job_token())
