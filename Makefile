.PHONY: sync test test-integration lint format typecheck gateway agent research consult-worker token db-reset

sync:
	uv sync

# Offline: no network, no database, no API keys.
test:
	uv run pytest

# Database and Pg repository tests against the development project in .env.
# Every test runs in a transaction that is rolled back.
test-integration:
	RUN_INTEGRATION=1 uv run pytest tests/db tests/integration

lint:
	uv run ruff check src tests scripts
	uv run ruff format --check src tests scripts
	uv run mypy

format:
	uv run ruff format src tests scripts
	uv run ruff check --fix src tests scripts

typecheck:
	uv run mypy

gateway:
	uv run python -m healthmcp.gateway

agent:
	uv run python -m healthmcp.agent

research:
	uv run python -m healthmcp.discovery.research_job $(ARGS)

# Approved transcripts -> draft facts (SLM) and key points (decision engine).
# Examples: make consult-worker ARGS=--once
#           make consult-worker ARGS="--appointment 60000000-0000-4000-8000-000000000002"
consult-worker:
	uv run python -m healthmcp.consult_notes.worker $(ARGS)

# Example: make token AGENT=clinical-doc-agent APPOINTMENT=60000000-0000-4000-8000-000000000002
token:
	uv run python scripts/mint_job_token.py --agent $(AGENT) $(if $(APPOINTMENT),--appointment $(APPOINTMENT))

db-reset:
	@echo "Not available: the hosted database is never reset. New SQL goes in new files under"
	@echo "supabase/migrations or supabase/seed and is run in the Supabase SQL Editor."
	@exit 1
