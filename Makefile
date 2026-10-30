.PHONY: sync test test-integration lint format typecheck server servers gateway agent research consult-worker token db-reset

SERVERS := transcript decision extraction patient_record matching booking web_research

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

# One MCP server (ports 3101-3107). Example: make server NAME=booking
server:
	uv run python -m healthmcp.servers.$(NAME)

# All seven MCP servers in the foreground; Ctrl+C stops them all.
servers:
	@trap 'kill 0' INT TERM; \
	for s in $(SERVERS); do uv run python -m healthmcp.servers.$$s & done; \
	wait

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
# create_gp_query also needs SCOPE=gp_query:create.
token:
	uv run python scripts/mint_job_token.py --agent $(AGENT) $(if $(APPOINTMENT),--appointment $(APPOINTMENT)) $(if $(SCOPE),--scope $(SCOPE))

db-reset:
	@echo "Not available: the hosted database is never reset. New SQL goes in new files under"
	@echo "supabase/migrations or supabase/seed and is run in the Supabase SQL Editor."
	@exit 1
