# Health booking app: instructions for Claude Code

We are building 7 Python MCP servers for this app. The full spec is
`docs/MCP_BUILD_SPEC.md`. Read the sections relevant to the current phase
before writing code, and keep `docs/DECISIONS.md` up to date (one line per
assumption).

## Current phase
Phase 1 done (scaffold, shared library, agent-layer SQL); waiting for the SQL to be run in the
SQL Editor. Next: spec phase 3 (`booking` and `patient_record`). (Update this line at the end of each phase.)

## Hard rules (never break these)

### Database (hosted Supabase, managed by me in the web dashboard)
- **Never connect to Supabase**: no database queries, no Supabase CLI, no Auth or REST API calls.
  The existing schema and sample data are already applied and verified by me.
- The SQL files in `supabase/` are the source of truth for the schema. Read them; don't query.
- Never edit existing files in `supabase/migrations/`, `supabase/seed/` or `supabase/functions/`.
- New database changes go in new files under `supabase/migrations/` or `supabase/seed/`,
  wrapped in `begin; … commit;`. I run them in the SQL Editor later; keep building meanwhile.
- Never write SQL that resets, truncates or drops existing data.
- Code reaches the database only through repositories, with a Pg implementation and an
  in-memory Fake implementation (fixtures mirror `supabase/seed/`, same ids).
- `make test` must pass fully offline. Integration tests are written but **not run** by you
  (they are skipped unless `RUN_INTEGRATION=1`).

### Security (spec section 3)
- Never take a patient id from tool arguments; it comes from the request context.
- User mode: `set local role authenticated` plus JWT claims, so RLS applies. Never use `service_role` in user mode.
- Job mode: every query is filtered by the ids in the job token.
- Agents never send text to models; tools take ids and the server loads the text.
- No transcript text, quotes or review text in any log.
- Only the tools listed in spec section 6. No SQL/RPC/URL pass-through tools.
- No automatic engine fallbacks. Mock engines must make everything work with no API keys.
- Do not invent the Jev API. Without `JEV_DOCS_PATH`, `JevEngine` raises `EngineNotConfigured`.

### Secrets
- Never read, print or commit `.env`. Only `.env.example` is committed.

## Working style
- One phase at a time (spec section 12). At the end of each phase, stop with: what you built,
  test results, new DECISIONS.md entries, and any new SQL files I need to run (in order).
- Python 3.12 with uv. Run `uv run pytest` and `uv run ruff check` before saying a phase is done.
- Ask before adding a large dependency.
