"""Mint a job token for local testing (signed with JOB_TOKEN_SECRET, max 15 minutes).

Example:
    uv run python scripts/mint_job_token.py --agent clinical-doc-agent \
        --appointment 60000000-0000-4000-8000-000000000002 \
        --patient 50000000-0000-4000-8000-000000000001 \
        --clinician 40000000-0000-4000-8000-000000000001
"""

from __future__ import annotations

import argparse
import sys

from healthmcp.shared.auth import MAX_JOB_TOKEN_SECONDS, mint_job_token
from healthmcp.shared.config import Settings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--agent", required=True, help="agent id from config/agents.json")
    parser.add_argument("--job", help="job id (default: random)")
    parser.add_argument("--appointment")
    parser.add_argument("--patient")
    parser.add_argument("--clinician")
    parser.add_argument("--scope", action="append", default=[], help="repeatable")
    parser.add_argument("--minutes", type=int, default=MAX_JOB_TOKEN_SECONDS // 60)
    args = parser.parse_args()

    settings = Settings()
    if settings.job_token_secret is None:
        print("JOB_TOKEN_SECRET is not set", file=sys.stderr)
        return 1
    token = mint_job_token(
        settings.job_token_secret.get_secret_value(),
        agent_id=args.agent,
        job_id=args.job,
        appointment_id=args.appointment,
        patient_id=args.patient,
        clinician_id=args.clinician,
        scope=args.scope,
        lifetime_seconds=args.minutes * 60,
    )
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
