# Decisions and assumptions

One line per decision. Newest phase at the bottom.

## Phase 1 (scaffold, shared library, agent-layer SQL)

- Phase 1 as requested combines spec phases 1 (database) and 2 (shared library); the database tests in `tests/db` are written now but only run with `RUN_INTEGRATION=1`.
- The installed MCP SDK is 2.3.0, where `FastMCP` was renamed `mcp.server.mcpserver.MCPServer`; the servers use `MCPServer` (spec 2 says to follow the installed SDK).
- Servers use Streamable HTTP in **stateless** mode with JSON responses: every request carries its own `Authorization` header, and there are no sessions to hijack across tokens.
- The SDK runs tool handlers in its own task, so the Context is passed through the ASGI scope and bound to the ContextVar by an MCP `ServerMiddleware`, not by the HTTP middleware.
- `tools/list` is filtered to the agent's allowed tools, and `tools/call` for any other tool is refused before the tool runs (and again inside `with_tool_logging`).
- Each agent in `config/agents.json` also lists its allowed modes (`user` or `job`); a patient agent can never present a job token and vice versa.
- `config/agents.json` and every registered tool are checked against a fixed catalogue of the spec section 6 tools (`healthmcp.shared.tool_catalog`); `HealthServer.tool()` refuses any other name.
- JWT signing mode was **not** checked against the project (no Supabase access allowed); both are supported: HS256 with `SUPABASE_JWT_SECRET` and ES256/RS256 via JWKS, with a fixed algorithm list per path. Please confirm which one the project uses.
- User tokens must have `aud=authenticated`, `role=authenticated`, a uuid `sub`, and `iss={SUPABASE_URL}/auth/v1` when `SUPABASE_URL` is set; anon and service_role tokens are refused.
- Job tokens: HS256, `iss=healthmcp-job`, `aud=healthmcp`, `iat`+`exp` required, lifetime ≤ 15 minutes, `JOB_TOKEN_SECRET` ≥ 32 bytes and different from the Supabase secret.
- A user-mode request must send `X-Agent-Id`; a job-mode request may omit it, but if sent it must equal the token's `agent_id`.
- New role `mcp_server` (nologin, granted to `postgres`) writes the append-only logs, reads `model_registry` and runs the name check, so logging never needs `service_role` during a patient request.
- Log rows are written in their own short transaction, so a failed tool call is still logged; if the log write itself fails, the error is logged and the tool result is not masked.
- In job mode, `ScopedConnection` refuses any query that does not reference a `%(scope_...)s` parameter (filled from the Context, never from callers) unless it is marked `reference=True` for non-patient registry data.
- `user_tx` sets only `request.jwt.claims` (with `set local role authenticated`); Supabase's `auth.uid()`/`auth.jwt()` read it.
- Pool connections use `prepare_threshold=None`, so the same code works behind the Session or Transaction pooler.
- Fake repositories use stand-in auth user ids `aa000000-...` for the sample logins (real ids exist only in the hosted project); patient, clinician and appointment ids match the seeds.
- `DATA_BACKEND=fake` runs a server on the in-memory Fakes with no database (local demos and tests).
- The personal-information detector flags Medicare (10 digits starting 2–6, optional IRN, spaces allowed), IHI (16 digits starting 800360), AU mobile/landline numbers (not 13/1300/1800 business numbers), emails, DOB keywords, numeric dates at least two years old, and full patient names (first/preferred + last, either order) matched inside the database.
- Patient names never leave the database: `text_mentions_patient_name(text)` returns only a boolean (security definer, `mcp_server` only).
- `log_note` notes are checked with the personal-information detector and refused if they contain names, numbers or emails.
- Server logs are JSON; a filter redacts known text fields and drops exception messages (keeping type, SQLSTATE, constraint and traceback frames), because messages can contain values.
- `decision_log` refuses free-text keys (`text`, `quote`, `content`, `segments`, `review_text`, …); enum answers and structured values are allowed; the input text is stored only as a sha256.
- Engine results are validated with Pydantic (plus per-engine checks: allowed answer values, JSON-schema value, quote exactly at the offsets); a bad result is retried once, engine errors are not retried, and nothing falls back to another engine.
- `model_registry` has an extra `capability` column (decision/extraction/search/places) with a unique index allowing one enabled engine per capability, so selection is never ambiguous.
- Engine selection takes `health_data=True/False`; with `True` the selected engine must have `allow_health_data`, checked before anything is sent.
- `JevEngine` and `LlmAdapterEngine` are stubs that raise `EngineNotConfigured` (no Jev docs available; the LLM adapter is a deliberate alternative, not built yet). `OpenAICompatibleEngine`, `TavilyEngine` and `GooglePlacesClient` are implemented but disabled.
- `ExtractedValue.char_start/char_end` are offsets inside the segment's text; the extraction server will convert them to transcript offsets using the segment's own `char_start`.
- Mock search/places read fixture files from `MOCK_FIXTURES_DIR` (default `tests/fixtures`).

### SQL (20261027000000, 20261027010000, seed 04)

- The migration is split in two files (core agent layer; booking/matching/fees/coverage), run in filename order.
- `recording_consents.consent_text_version` gets a NOT VALID foreign key to `consent_text_versions` (new rows must use a known version; existing rows are not re-checked).
- Consent versions and `model_registry` rows (all disabled) are inserted by the migration because production needs them; the seed enables the mock engines. Decision questions and clinical fields are sample configuration in the seed (production will need its own config seed).
- `transcript_segments.seq` starts at 1; offsets are 0-based into `transcript_text` (null if a structured segment's text is not found verbatim). Without structured segments, the text is split into sentences and a leading `Name:` label becomes the speaker.
- The deletion cascade runs only when the deleted transcript was `approved`: drafts are only ever made from approved transcripts, so rejecting or expiring a never-approved transcript must not wipe agent output from the appointment's approved one.
- The cascade also strips sources from `superseded` facts and nulls their char offsets; it is marked `TODO(legal)` as specified.
- Patients can read `approved` and `superseded` facts (history), never drafts or rejected ones (spec 10 default: patients see approved facts).
- Agents (`service_role`) can only INSERT drafts/open rows into `clinical_facts`, `open_items`, `gp_queries`; UPDATE/DELETE are revoked and a trigger refuses pre-approved inserts. The human-only functions are not granted to `service_role`.
- Added `clinical_facts.value_edited` to record when a clinician changed the value in `edit_and_approve_fact`.
- `supersede_fact` creates a new `clinician_entered` approved fact valid from today and closes the old one (`valid_to` = today).
- Decision questions carry `threshold_model_version` (thresholds belong to a model version). Attribute questions (`attr_negated`, `attr_hypothetical`, `attr_experiencer`, `attr_temporality`) and an `evidence_segment` template are stored as questions so their versions are tracked.
- Decision question options are stored as `[{value, label?, level?, description?}]`; a CHECK constraint enforces yes/no = yes|no|not_stated, choice includes `unclear`, score levels are numbered and described.
- `booking_proposals` inserts are forced to `pending` with a 10-minute expiry; cancel/reschedule proposals must be for the proposing patient's own appointment; a `pg_cron` job marks stale proposals `expired` when pg_cron is enabled.
- `find_gp_candidates` keeps a clinician who is not accepting new patients when the caller has a completed visit with them, limits the range to 31 days, uses haversine distance (no PostGIS), and treats `p_languages` as "speaks any of these" (ISO 639-1 codes).
- `estimate_fees` may be called for yourself, by staff, or by background jobs; a clinician-specific fee overrides the clinic fee; `gp_benefit` is `{"covered": false}` or `{"covered": true, "basis": "mbs_percent"|"fixed", ...}` where `mbs_percent` applies to the schedule's MBS rebate amount (OSHC / visitor cover), capped at the remaining gap.
- Sample plans: Australian hospital/extras plans pay no GP benefit (they cannot for Medicare services); OSHC pays 100% and visitor cover 85% of the MBS amount.
- Verified plan versions of one plan cannot overlap (partial exclusion constraint); `verify_plan_version` closes the previous open-ended verified version. Jobs may create verified versions only from the PHIO dataset; insurer-site versions are always drafts.
- Facilities get fictional `google_place_id`s (`sample-place-*`) that the mock Places client knows.
- The SQL was checked locally (not on Supabase) by applying all migrations and seeds to a throwaway Postgres 16 container with a stub of Supabase's roles and `auth` schema, re-running seed 04, and running `tests/db` and `tests/integration` there (49 passed).

### Security Advisor: new functions callable by signed-in users (intentional)

- `approve_fact`, `edit_and_approve_fact`, `reject_fact`, `supersede_fact`, `resolve_open_item`, `answer_gp_query` (treating clinician or staff only, checked inside).
- `confirm_booking_proposal`, `decline_booking_proposal` (owning patient only), `verify_plan_version` (staff only).
- `find_gp_candidates`, `estimate_fees` are security invoker (RLS applies), not security definer.
