# Build spec: MCP servers for the health booking app (Python)

You are building 7 MCP servers in **Python** (plus a shared library and the
database changes they need) for an Australian health booking app built on
Supabase. Read this whole file before starting. Work in the phases in
section 12, and stop for review at the end of each phase.

---

## 1. Context

### 1.1 What already exists (do not modify these files)

```
supabase/migrations/20261026000000_health_booking_schema.sql   # core schema
supabase/migrations/20261026010000_security_advisor_fixes.sql  # revokes + btree_gist move
supabase/migrations/20261026020000_visit_vitals.sql            # vitals
supabase/seed/01_sample_data.sql      # sample patients, clinicians, visits, transcripts...
supabase/seed/02_link_test_logins.sql # links auth users to sample people by email
supabase/seed/03_sample_vitals.sql    # sample vitals
supabase/functions/transcribe-consult/index.ts  # Deno Edge Function (stays TypeScript)
```

**The database is a hosted Supabase project, managed through the Supabase
web dashboard. There is no local Supabase stack and no Docker.** Section 2.1
explains how to work with that.

Read all three migrations first. Key facts you must respect:

- Tables: `patients`, `clinicians`, `facilities`, `appointments` (booking and
  visit in one row), `appointment_slots`, `consult_transcripts`,
  `recording_sessions`, `recording_consents`, `clinician_ratings`,
  `insurance_claims`, `visit_vitals`, plus effective-dated history tables
  (`patient_insurance_policies`, `patient_residency`, `clinician_affiliations`,
  etc.) with `valid_from` / `valid_to` and exclusion constraints.
- Helper functions: `current_patient_id()`, `current_clinician_id()`,
  `is_staff()` (reads `app_metadata.role` in the JWT), `policy_on()`,
  `affiliation_on()`, `facility_local_date()`, `get_available_slots()`,
  `hold_slot()`, `book_slot()`, `cancel_appointment()`,
  `reschedule_appointment()`.
- RLS is enabled on every table. Patients see only their own rows.
- **Transcript rules:** audio is never stored. A transcript is created as
  `pending_patient_review`; the patient approves (kept, read-only) or rejects
  (deleted). Unreviewed drafts are deleted after 7 days. Withdrawing consent
  deletes all transcripts for the appointment. Clinicians only see
  `approved` transcripts.
- `consult_transcripts.segments` is an optional jsonb array of
  `{speaker, start_sec, end_sec, text}`.
- `btree_gist` lives in the `extensions` schema. Exclusion constraints on
  uuid columns still work without schema-qualifying anything.

### 1.2 What you are building

Two AI agents (built later, not in this task) will call these servers:

- **Patient assistant**: runs in the patient app, acting as the signed-in
  patient. Answers questions, finds GPs, proposes bookings.
- **Clinical documentation agent**: runs as a background job after a patient
  approves a transcript. Extracts draft clinical facts for the treating GP to
  review.

Plus **scheduled jobs** that refresh insurance coverage and clinic reviews.

| Server | Port | Used by | Writes |
|---|---|---|---|
| `transcript` | 3101 | Clinical agent | No |
| `decision` | 3102 | Clinical agent | Logs only |
| `extraction` | 3103 | Clinical agent | Drafts, open items, GP queries |
| `patient_record` | 3104 | Both agents | No |
| `matching` | 3105 | Patient agent | No |
| `booking` | 3106 | Patient agent | Holds and proposals only |
| `web_research` | 3107 | Scheduled jobs | Draft plan versions, review summaries |

Logging is not a separate server. It is part of the shared library every
server uses.

### 1.3 Engines behind the tools

| Engine | Used for | Notes |
|---|---|---|
| **Jev** (TypeSafe AI System One model) | All `decide_*` tools; urgent-finding severity; clinical/non-clinical review comment check; prompt-injection check; personal-information check on search queries | Returns typed answers (bool / enum / ordinal) with calibrated probabilities. Does not generate free text. Early access: **do not guess its API**. Read the docs at `JEV_DOCS_PATH` or ask me. |
| **SLM** (small language model behind an OpenAI-compatible endpoint, e.g. Nebius) | `extract_value`; structuring coverage pages | Use the `openai` Python SDK with `base_url`, and JSON-schema-constrained output. |
| **Tavily** | `web_search`, `web_extract` | Search API (`tavily-python`, async client), not a model. |
| **Google Places API (New)** | `refresh_facility_reviews` | Called with `httpx`. Only `place_id` may be stored long term. |
| **Code / SQL** | Everything else, including `check_grounding` | No model. |

Every engine must have a **mock implementation** so the whole system runs and
tests pass with no API keys.

---

## 2. Tech stack

- **Python 3.12**, managed with **uv** (`uv sync`, `uv run`).
- **MCP:** the official MCP Python SDK (`mcp` package), using `FastMCP` and the
  **Streamable HTTP** transport (needed so each request carries an
  `Authorization` header). Mount each server's Streamable HTTP ASGI app in a
  small Starlette app so you can add auth middleware, `/healthz` and request
  size limits, and serve it with `uvicorn`. Check the installed SDK version's
  README for the current API (tool registration, context access, transport);
  do not rely on memory.
- **Schemas:** Pydantic v2 models for every tool input and output. Tool
  functions take typed parameters / Pydantic models so the SDK generates the
  JSON schema.
- **Database:** `psycopg` 3 (async) with `psycopg_pool`, connecting to the
  hosted project's Postgres through the **Session pooler** connection string
  (dashboard → **Connect** → Session pooler; it works over IPv4, unlike the
  direct connection). If the Transaction pooler is ever used, set
  `prepare_threshold=None`. RLS is applied the same way PostgREST does it
  (section 3.1).
- **JWT:** `PyJWT` (with `cryptography`). Support both Supabase signing modes:
  JWKS from `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` (asymmetric signing
  keys) and the legacy HS256 `SUPABASE_JWT_SECRET`. Check which one the
  project uses (dashboard → Project Settings → JWT Keys) by fetching the JWKS
  endpoint, and record it in DECISIONS.md.
- **HTTP:** `httpx` (async).
- **Tests:** `pytest`, `pytest-asyncio`, against the hosted **development**
  project (section 2.1).
- **Quality:** `ruff` (lint + format) and `mypy` (strict on `healthmcp`).
- Ask before adding any other large dependency.

### Repository layout

```
health-app/
├── pyproject.toml          # one package, uv-managed; console scripts per server
├── uv.lock
├── Makefile                # dev, test, smoke, lint, db-reset
├── Procfile.dev            # all 7 servers, run with honcho
├── .env.example
├── config/
│   └── agents.json         # agent -> allowed servers and tools
├── src/healthmcp/
│   ├── shared/
│   │   ├── config.py       # pydantic-settings
│   │   ├── context.py      # Context, user/job mode, allowlist
│   │   ├── db.py           # pool, user_tx(), job_tx(), scoped helpers
│   │   ├── auth.py         # JWT + job token verification
│   │   ├── logging.py      # with_tool_logging, log_decision, log_note tool
│   │   ├── guards.py       # health-data, untrusted content, PII, domains
│   │   ├── server.py       # create_server(name, port) -> FastMCP + Starlette app
│   │   └── engines/
│   │       ├── decision.py     # DecisionEngine protocol, JevEngine, LlmAdapterEngine, MockDecisionEngine
│   │       ├── extraction.py   # ExtractionEngine protocol, OpenAICompatibleEngine, MockExtractionEngine
│   │       ├── search.py       # SearchEngine protocol, TavilyEngine, MockSearchEngine
│   │       ├── places.py       # PlacesClient protocol, GooglePlacesClient, MockPlacesClient
│   │       └── registry.py     # engine selection from model_registry
│   └── servers/
│       ├── transcript/     # __main__.py + tools.py
│       ├── decision/
│       ├── extraction/
│       ├── patient_record/
│       ├── matching/
│       ├── booking/
│       └── web_research/
├── scripts/
│   ├── smoke_client.py     # connects to every server, calls every tool
│   └── mint_job_token.py   # creates a job token for local testing
├── tests/
│   ├── db/                 # SQL behaviour tests
│   ├── unit/
│   └── integration/
├── supabase/               # existing + new migrations and seeds
└── docs/
    ├── MCP_BUILD_SPEC.md   # this file
    └── DECISIONS.md        # you keep this: every assumption, one line each
```

Each server runs with `uv run python -m healthmcp.servers.<name>`.

### 2.1 Working against a hosted Supabase project (web dashboard)

1. **Development project only.** Connect only to the project whose details
   are in `.env`, which must be a development/test project holding sample
   data, never one with real patient data. If anything suggests real patient
   data (e.g. emails not ending in `example.com`), stop and ask me.
2. **You do not apply SQL yourself.** For every database change, write the
   new file under `supabase/migrations/` or `supabase/seed/`, then stop and
   ask me to paste it into the dashboard **SQL Editor** and run it. Wait for
   me to confirm (or paste back the error) before continuing. Only use the
   Supabase CLI (`supabase link`, `supabase db push`) if I explicitly say so.
3. **Every new SQL file is wrapped in `begin; … commit;`**, so a failed run in
   the SQL Editor leaves nothing half-applied. Seed files must also be safe to
   re-run (`on conflict do nothing` / existence checks).
4. **Never reset, truncate or drop** existing tables or data. There is no
   `supabase db reset`.
5. **Read-only checks are fine.** You may run `select` queries through the
   connection string to verify a migration was applied (e.g. check
   `information_schema` / `pg_proc`).
6. **Tests must not leave data behind.**
   - Database behaviour tests (`tests/db`) run each test inside a transaction
     that is **rolled back** at the end.
   - Integration tests that need committed data (MCP calls through running
     servers) create their own rows with ids from a fixed test namespace
     (uuids starting `ee000000-`) and delete them in teardown; a
     `make test-cleanup` target removes any leftovers.
   - Test auth users are created through the Auth admin API (service role
     key) with emails `mcp-test+<name>@example.com` and deleted in teardown.
     Do not modify the sample logins from `02_link_test_logins.sql`.
7. **Security Advisor:** you cannot see the dashboard. At the end of phases 1
   and 7, ask me to open **Advisors → Security Advisor** and paste the
   results, then deal with any new warnings.
8. **Secrets** (database password, service role key) live only in `.env`,
   which is git-ignored.

---

## 3. Security model (most important section)

### 3.1 Two ways a request is authorised

Every tool call builds a `Context` (frozen dataclass) before the handler runs.
The Starlette middleware verifies the token and stores the `Context` in a
`contextvars.ContextVar` that tool functions read.

**User mode** (patient assistant): the request carries
`Authorization: Bearer <user's Supabase JWT>`.
- Verify the JWT (signature, expiry, `aud = authenticated`).
- Every database call runs inside `user_tx(ctx)`, which opens a transaction
  and executes:
  ```sql
  set local role authenticated;
  select set_config('request.jwt.claims', %(claims_json)s, true);
  ```
  so `auth.uid()`, `auth.jwt()` and RLS behave exactly as through the
  Supabase API.
- `Context(mode='user', user_id, patient_id (via current_patient_id()), agent_id)`.

**Job mode** (clinical agent, scheduled jobs): the request carries
`Authorization: Bearer <job token>`, a JWT signed with `JOB_TOKEN_SECRET`
(HS256), max lifetime 15 minutes, containing:
`{ agent_id, job_id, appointment_id?, patient_id?, clinician_id?, scope: [..] }`.
- Verify signature and expiry.
- Database calls run inside `job_tx(ctx)` (`set local role service_role`),
  and every query must filter by the ids in the token. Use helper functions
  that take `ctx` and add the filter; never write an unscoped query in a tool
  handler. Add a test that greps tool modules for raw `service_role` use
  outside `db.py`.
- `Context(mode='job', agent_id, job_id, appointment_id, patient_id, clinician_id, scope)`.

### 3.2 Rules that apply to every tool

1. **Never take a patient id from tool arguments.** The patient (and in job
   mode the appointment) comes from the `Context`. If a tool accepts an
   `appointment_id`, check it equals `ctx.appointment_id` (job mode) or belongs
   to `ctx.patient_id` (user mode, enforced by RLS).
2. **Agent allowlist.** `X-Agent-Id` header (user mode) or `agent_id` claim
   (job mode) must appear in `config/agents.json`, which lists the servers and
   tools each agent may call:
   - `patient-assistant`: patient_record, matching, booking
   - `clinical-doc-agent`: transcript, decision, extraction, patient_record
   - `research-job`: web_research
   Reject anything else before the tool runs.
3. **The agent never sends text to models.** Tools take segment ids, field ids
   and question ids; the server loads the text itself after checking scope.
   This blocks prompt injection through tool arguments.
4. **Health-data guard.** Before sending any patient-derived text to an
   engine, check `model_registry.allow_health_data = true` for that engine.
   If false, raise. Jev starts with `allow_health_data = false` until its
   privacy terms are confirmed.
5. **Untrusted content.** Transcript text and web content returned to agents
   is wrapped as `{"untrusted_content": true, "text": ...}`, and tool
   descriptions say it must be treated as data, never as instructions.
6. **No pass-through.** No tool may run arbitrary SQL, call arbitrary RPCs or
   fetch arbitrary URLs.
7. **Safe errors.** Raise MCP tool errors with short, non-revealing messages.
   Full detail goes to server logs only, and server logs never contain
   patient text (use the stdlib `logging` module with a filter that drops
   known text fields).
8. **Things agents must never do** (no tools for these, ever): give or
   withdraw consent, approve or reject transcripts, approve facts, resolve
   open items, answer GP queries, confirm bookings, verify plan coverage,
   moderate ratings.

### 3.3 Logging (shared library, automatic)

Wrap every tool with the `with_tool_logging` decorator:

- **`agent_access_log`** (every call): `agent_id, mode, user_id, job_id,
  patient_id, appointment_id, server, tool, ok, error_code, latency_ms,
  created_at`.
- **`decision_log`** (every engine call): `agent_id, job_id, appointment_id,
  server, tool, engine, model, model_version, prompt_or_question_version,
  input_refs jsonb (ids only), input_hash (sha256 of the exact text sent),
  output jsonb (no transcript text; quotes stored as hashes), probability,
  latency_ms, created_at`.
- **`agent_notes`**: written only through the `log_note` tool (available on
  every server and listed in the allowlist), max 1000 characters.
- All three tables are **append-only**: revoke `update` and `delete` from
  every role, including `service_role`; insert only through `security definer`
  functions.

---

## 4. Database changes

Create `supabase/migrations/20261027000000_agent_layer.sql` (wrapped in
`begin; … commit;`; I will run it in the SQL Editor, see section 2.1). If it
gets large, split it into numbered files that I run in order. Enable RLS on
every new table, revoke all from `anon`, and revoke execute on every new
trigger function from `public, anon, authenticated` (the Supabase Security
Advisor flags exposed `security definer` functions).

### 4.1 Consent covering AI analysis
- `consent_text_versions(version text pk, covers_ai_analysis boolean, published_at)`.
  Insert `v1` (false) and `v2` (true).
- `get_processing_eligibility` requires both parties' current consent rows to
  use a version where `covers_ai_analysis = true`.

### 4.2 Transcript segments
- `transcript_segments(id uuid pk, transcript_id fk → consult_transcripts on delete cascade, appointment_id, seq int, speaker text, speaker_confidence numeric null, start_sec, end_sec, text, char_start int, char_end int)`,
  unique `(transcript_id, seq)`.
- Populate when a transcript becomes `approved` (trigger): from `segments`
  jsonb if present, otherwise split `transcript_text` into sentences.
  `char_start/char_end` are offsets into `transcript_text`.
- RLS: the appointment's patient and treating clinician can read.

### 4.3 Registries
- `decision_questions(id text, version int, kind 'yes_no'|'choice'|'score', text, options jsonb, threshold numeric, active, pk(id, version))`.
  Yes/no questions always answer `yes | no | not_stated`; choice questions
  always include `unclear`; score questions define every level in words.
- `clinical_fields(id text, version int, label, value_schema jsonb, unit text null, code_system text null, topic text, active, pk(id, version))`,
  e.g. `bp_reading`, `current_medication`, `allergy`, `smoking_status`.
- `model_registry(engine text pk, provider, model, model_version, region, zero_data_retention boolean, allow_health_data boolean, enabled boolean)`.
  Seed rows for `jev`, `slm`, `tavily`, `google_places`, and `mock` engines.

### 4.4 Facts, open items, GP queries
- `clinical_facts`: `id, appointment_id, patient_id, field_id, field_version, value jsonb, unit, code_system, code, status 'draft'|'approved'|'rejected'|'superseded', negated boolean, experiencer 'patient'|'family'|'other', temporality 'current'|'past'|'future'|'unknown', source 'transcript'|'clinician_entered', source_segment_ids uuid[], quote_hash, char_start, char_end, confidence, engine, model_version, idempotency_key unique, created_by_agent, approved_by, approved_at, superseded_by fk, valid_from, valid_to, source_removed_at`.
- `open_items`: `id, appointment_id, kind 'missing_info'|'conflict'|'urgent', severity smallint, description, related_fact_ids uuid[], status 'open'|'resolved', resolution, resolved_by, resolved_at, idempotency_key unique`.
- `gp_queries`: `id, appointment_id, question, context_fact_ids uuid[], status 'open'|'answered', answer, answered_by, answered_at, idempotency_key unique`.
- RLS: drafts, open items and GP queries are visible to the treating
  clinician and staff only. Approved facts are also visible to the patient.
- Urgent open items insert into `notifications(id, facility_id, appointment_id, kind, created_at, read_at)`.

### 4.5 Deletion cascade (required)
When a `consult_transcripts` row is deleted (rejection, expiry, consent
withdrawal), a `before delete` trigger must:
- delete `clinical_facts` with status `draft` or `rejected` for that appointment,
- delete open `open_items` and `gp_queries` for that appointment,
- for `approved` facts: keep them, set `source_segment_ids = '{}'`,
  `quote_hash = null`, `source_removed_at = now()`. Add the comment
  `-- TODO(legal): confirm retention policy for approved facts after consent withdrawal`.
Segments are deleted by FK cascade. Logs keep only ids and hashes.

### 4.6 Human-only RPCs (called from the app, never exposed as MCP tools)
`approve_fact(id)`, `edit_and_approve_fact(id, value)`, `reject_fact(id)`,
`supersede_fact(old_id, new_value)`, `resolve_open_item(id, resolution)`,
`answer_gp_query(id, answer)`: treating clinician or staff only.
`verify_plan_version(id)`: staff only.

### 4.7 Booking proposals
- `booking_proposals(id, patient_id, kind 'book'|'cancel'|'reschedule', slot_id, appointment_id, new_slot_id, reason, visit_type, status 'pending'|'confirmed'|'declined'|'expired', expires_at default now()+10 min, created_by_agent, confirmed_at, result_appointment_id)`.
- `confirm_booking_proposal(id)`: patient only, called by the app when the
  patient taps Confirm; runs `book_slot` / `cancel_appointment` /
  `reschedule_appointment` in the same transaction.
- `decline_booking_proposal(id)`.

### 4.8 Matching, fees, coverage, reviews
- Columns on `clinicians`: `languages text[]`, `accepting_new_patients boolean`, `offers_telehealth boolean`, `special_interests text[]`.
- `patient_gp_preferences(patient_id pk, preferred_languages text[], preferred_clinician_sex text, preferred_facility_ids uuid[], telehealth_ok boolean, max_distance_km int, updated_at)`.
- `clinician_preferences(clinician_id pk, prefs jsonb, updated_at)`: the GP's documentation preferences.
- `clinician_match_scores(clinician_id, factor text, score numeric, scoring_version text, computed_at, pk(clinician_id, factor, scoring_version))`.
- `fee_schedules(id, facility_id, clinician_id null, visit_type, mbs_item text null, fee numeric, medicare_rebate numeric, valid_from, valid_to)` with a no-overlap exclusion constraint per facility, clinician and visit type.
- `insurance_plan_versions(id, plan_id, valid_from, valid_to, hospital_inclusions jsonb, hospital_exclusions jsonb, hospital_restricted jsonb, excess numeric, extras_limits jsonb, waiting_periods jsonb, gp_benefit jsonb, source 'phio_dataset'|'insurer_site', source_url, retrieved_at, content_hash, status 'draft'|'verified', verified_by, verified_at)`.
- `facilities.google_place_id text`.
- `facility_review_summaries(facility_id, source, rating numeric, review_count int, non_clinical_summary text, source_url, retrieved_at, pk(facility_id, source))`. Never store review text.
- `web_research_log(id, job_id, tool, query_hash, domains text[], urls text[], result_count, blocked_reason, created_at)`.
- SQL function `find_gp_candidates(p_date_from, p_date_to, p_lat, p_lng, p_max_km, p_clinician_type, p_languages, p_sex, p_telehealth)`:
  hard filters only (active, affiliated on the date, accepting new patients,
  distance, type, language, sex if requested, telehealth if requested,
  at least one available slot in range). Returns clinician, facility,
  distance and next available slot.
- SQL function `estimate_fees(p_patient_id, p_facility_id, p_clinician_id, p_visit_type, p_date)`:
  fee from `fee_schedules`; Medicare rebate only if the patient's residency
  on that date is Medicare-eligible; insurance benefit from the **verified**
  plan version in force on that date (`gp_benefit`); gap; always returns
  `is_estimate = true`.

### 4.9 Seed
`supabase/seed/04_agent_layer_sample.sql` (safe to re-run; I will run it in
the SQL Editor after the migration): consent versions, 6+ decision
questions (e.g. `chest_pain_reported`, `smoker_status`, `pain_severity`,
`urgency_level`), 6+ clinical fields, model registry rows (mocks enabled,
real engines disabled), clinician languages and flags, patient GP
preferences for 3 patients, fee schedules for all facilities, verified plan
versions for every sample plan, match scores and review summaries. Backfill
`transcript_segments` for the already-approved sample transcript, and move
its consents to `v2` so the clinical agent can be tested on it.

### 4.10 Database tests (`tests/db`)
Each test runs inside a transaction that is rolled back (section 2.1).
Tests for: consent-version gate; segment creation on approval; deletion
cascade (draft facts and open items gone, approved facts kept with sources
removed); append-only logs (update/delete fail for all roles); proposal
confirmation only by the owning patient; `find_gp_candidates` filters;
`estimate_fees` uses the policy and residency in force on the date; RLS
(patient cannot see drafts; clinician sees only own appointments).

---

## 5. Shared library (`healthmcp.shared`)

- `config.py`: `pydantic-settings` model loaded from env; see `.env.example`.
- `auth.py`: verify Supabase JWTs (JWKS or HS256) and job tokens.
- `context.py`: `Context` dataclass, `ContextVar`, allowlist check against `config/agents.json`.
- `db.py`: `AsyncConnectionPool`; `user_tx(ctx)` and `job_tx(ctx)` async context managers (section 3.1); small typed query helpers that require `ctx`.
- `logging.py`: `with_tool_logging` decorator, `log_decision()`, `register_log_note(mcp)`.
- `guards.py`: health-data guard; `untrusted()` wrapper; personal-information detector (regex for Medicare numbers, Australian phone numbers, emails, dates of birth, plus exact match against names in `patients`; optionally the Jev classifier when allowed); domain allowlist.
- `engines/` (use `typing.Protocol` for each interface):
  - `DecisionEngine.decide(questions: list[TypedQuestion], state: str) -> list[TypedAnswer]` with a probability per answer. Implementations: `JevEngine`, `LlmAdapterEngine` (TypeSafe's System One LLM adapter or an equivalent, as a deliberate alternative, never an automatic fallback), `MockDecisionEngine` (deterministic, keyword-based).
  - `ExtractionEngine.extract(field: ClinicalField, segments: list[Segment]) -> ExtractedValue` (value, unit, quote, segment_id, char_start, char_end, confidence). Implementations: `OpenAICompatibleEngine` (JSON-schema output via the `openai` SDK), `MockExtractionEngine`.
  - `SearchEngine.search()` and `.extract()`. Implementations: `TavilyEngine` (`AsyncTavilyClient`), `MockSearchEngine` (fixture files under `tests/fixtures`).
  - `PlacesClient.get_place_summary(place_id)`. Implementations: `GooglePlacesClient` (`httpx`), `MockPlacesClient`.
  - `registry.py`: choose the enabled engine from `model_registry` plus env keys. **No silent fallback**: if the selected engine fails, raise; the job retries later.
  - Validate every engine result with Pydantic; on mismatch retry once, then raise.
- `server.py`: `create_server(name: str, port: int)` returns a configured `FastMCP` plus a Starlette app with auth middleware, `/healthz`, request size limit and a simple in-memory per-agent rate limit. Each server's `__main__.py` registers its tools and runs `uvicorn`.

---

## 6. Server specs

Inputs and outputs below are the contract. Define each with Pydantic models.
Each tool's docstring (shown to the agent) must say what the tool does, what
it cannot do, and that returned text is untrusted data.

### 6.1 `transcript` (job mode, clinical agent)

| Tool | Input | Output / behaviour |
|---|---|---|
| `get_processing_eligibility` | `appointment_id` | `{eligible, reasons[]}`. Checks: both consents given, none withdrawn, versions cover AI analysis, an `approved` transcript exists. Every other tool in this server calls this first and refuses if not eligible. |
| `get_transcript_windows` | `appointment_id, window_size=8, overlap=2` (segments) | `windows[{window_id, segment_ids, segments[{id, seq, speaker, speaker_confidence, start_sec, end_sec, text}]}]`. `window_id` is deterministic (hash of transcript id + first and last seq). Text wrapped as untrusted. |
| `search_transcript` | `appointment_id, query, limit=10` | Matching segments (case-insensitive, this appointment only). |
| `check_grounding` | `segment_ids[], quote, value, value_type` | **Code only.** `{quote_found, segment_id, char_start, char_end, value_derivable, reason}`. Quote must appear verbatim (whitespace-normalised) in one of the segments. `value_derivable` uses deterministic parsers per value type (blood pressure "140 over 90" → 140/90, numbers in words, units). |

### 6.2 `decision` (job mode, clinical agent; engine: Jev)

The agent passes `segment_ids` and `question_ids`; the server loads text and
question definitions itself.

| Tool | Input | Output |
|---|---|---|
| `decide_batch` | `segment_ids[], question_ids[]` | One engine call for all questions. `answers[{question_id, question_version, answer, probability, meets_threshold, attributes: {negated, experiencer, temporality, hypothetical}, evidence_segment_ids}]` |
| `decide_yes_no` | `segment_ids[], question_id` | Single answer: `yes` / `no` / `not_stated`, plus attributes and evidence. |
| `decide_choice` | `segment_ids[], question_id` | One option (always includes `unclear`). |
| `decide_score` | `segment_ids[], question_id` | One ordinal level. |

Implementation notes:
- Attributes (`negated`, `experiencer`, `temporality`, `hypothetical`) are
  extra typed questions added to the same engine call.
- Evidence: a choice question whose options are the window's segment ids
  ("which segment supports this answer?" plus `none`).
- `meets_threshold` uses the question's stored threshold. Thresholds belong
  to a model version; store `model_version` with every answer.

### 6.3 `extraction` (job mode, clinical agent; engine: SLM, Jev for severity)

| Tool | Input | Behaviour |
|---|---|---|
| `extract_value` | `field_id, segment_ids[]` | Engine returns value, unit, quote, offsets and confidence, validated against the field's `value_schema` (use `jsonschema`). |
| `save_draft_fact` | `field_id, value, unit?, segment_ids[], quote, char_start, char_end, confidence, negated, experiencer, temporality, idempotency_key` | **Re-runs grounding server-side and refuses if it fails.** Saves `draft`. Returns the existing row if the idempotency key was already used. Stores `quote_hash`, never the quote. Deduplicates: same field + same value + overlapping segments returns the existing draft. |
| `raise_open_item` | `kind, description, related_fact_ids?, idempotency_key` | For `urgent`, severity comes from the Jev `urgency_level` question, not from the agent; creates a notification. |
| `create_gp_query` | `question, context_fact_ids?, idempotency_key` | Saves an open query for the treating GP. |
| `list_open_items` | `status?` | Read only, this appointment only. |
| `get_clinician_preferences` | none | The treating clinician's documentation preferences (from the job token's `clinician_id`). |

### 6.4 `patient_record` (both modes; read only)

| Tool | Input | Output |
|---|---|---|
| `get_approved_facts` | `topic?, as_of?, include_history=false` | Approved facts valid on `as_of` (default today); superseded history when requested. |
| `get_observations` | `kind?, from?, to?` | From `visit_vitals` (`source: "measured"`) and approved observation facts (`source: "transcript"`), never merged; each row has its date and source. |
| `get_eligibility` | `date?` | Residency status and Medicare eligibility on that date; insurance policy and plan in force (via `policy_on`). |
| `get_appointments` | `from?, to?, status?` | The patient's appointments with clinician, facility and local time. |

### 6.5 `matching` (user mode, patient agent)

| Tool | Input | Output |
|---|---|---|
| `get_patient_gp_preferences` | none | Stored preferences. |
| `find_gp_candidates` | `date_from, date_to, near: {postcode} or {lat, lng}, max_km?, clinician_type?, overrides?` | Calls `find_gp_candidates()`, merging stored preferences with overrides. Postcode → lat/lng via a small local lookup table for sample postcodes (note in DECISIONS.md). |
| `get_score_breakdown` | `clinician_id` | Per-factor scores with `scoring_version`. Rating-based factors only if the clinician has ≥ 5 visible ratings. |
| `get_fees` | `clinician_id, facility_id, visit_type, date` | From `estimate_fees()`; always labelled as an estimate. |
| `get_plan_coverage` | `date?` | The **verified** plan version in force for the patient's policy on that date, or `{available: false}`. |
| `get_facility_review_summary` | `facility_id` | Rating, count, non-clinical summary, source link and retrieved date. |

### 6.6 `booking` (user mode, patient agent)

| Tool | Input | Behaviour |
|---|---|---|
| `get_available_slots` | `date, facility_id?, clinician_id?, clinician_type?` | Calls `get_available_slots()`. |
| `hold_slot` | `slot_id` | Calls `hold_slot()` (5-minute hold). |
| `propose_booking` | `slot_id, reason?, visit_type?` | Creates a `booking_proposals` row and returns `{proposal_id, summary, expires_at}`. The **app** shows a confirmation card; only the patient tapping Confirm (which calls `confirm_booking_proposal` directly) books. |
| `propose_cancellation` | `appointment_id, reason?` | Same pattern. |
| `propose_reschedule` | `appointment_id, new_slot_id` | Same pattern. |
| `get_proposal_status` | `proposal_id` | Current status and resulting appointment id. |

### 6.7 `web_research` (job mode, `research-job` agent only; engines: Tavily, SLM, Places, Jev)

| Tool | Input | Behaviour |
|---|---|---|
| `import_phio_dataset` | `file_path` | Imports the Private Health Insurance Ombudsman dataset (data.gov.au, CC BY 3.0 AU). **Before writing the parser, inspect a real file and stop to show me its structure.** Creates `verified` plan versions with `source = "phio_dataset"`. |
| `refresh_plan_coverage` | `plan_id` | Tavily extract on allowlisted insurer domains → SLM structures the fields → saves a **draft** version with `source_url`, `retrieved_at`, `content_hash`. |
| `refresh_facility_reviews` | `facility_id` | Places API by `google_place_id`: rating and count; a non-clinical summary generated in memory from review text (review text is never stored, and clinical comments are excluded using Jev). |
| `web_search` | `query, purpose, domains?` | Personal-information check on the query (block and log if found); domains limited to `ALLOWED_RESEARCH_DOMAINS`; results wrapped as untrusted; logged to `web_research_log`. |
| `web_extract` | `urls[]` | Allowlisted domains only; content wrapped as untrusted. |

---

## 7. Testing requirements

- Unit tests for every tool with mock engines.
- Integration tests against the hosted development project, following the
  data rules in section 2.1 (test namespace ids, test users created and
  deleted through the Auth admin API, nothing left behind).
- Required security tests:
  1. A patient's JWT cannot read another patient's data through any tool.
  2. A job token for appointment A cannot read appointment B (pass B's id as an argument; must be rejected).
  3. An agent not on the allowlist for a server is rejected.
  4. Transcript tools refuse when consent is `v1`, withdrawn, or the transcript is not approved.
  5. `save_draft_fact` refuses an ungrounded quote.
  6. Retrying `save_draft_fact` with the same idempotency key creates no duplicate.
  7. No transcript text appears in `decision_log`, `agent_access_log` or server logs (scan them after a full run).
  8. Health-data guard: with `allow_health_data = false` for an engine, tools that would send transcript text to it fail.
  9. `propose_booking` never creates an appointment by itself.
  10. `web_search` blocks a query containing a sample patient's name or Medicare number, and a domain outside the allowlist.
  11. Deleting an approved transcript removes drafts, open items and GP queries, and strips sources from approved facts.
  12. Engine failure returns an error; no fallback engine is used.
- `scripts/smoke_client.py`: connects to every server with the MCP Python
  client (`streamablehttp_client` + `ClientSession`); user mode signed in as
  `olivia.brown@example.com` (password from `SMOKE_OLIVIA_PASSWORD`; I create
  this login in the dashboard and link it with `02_link_test_logins.sql`);
  job mode with a minted token for Olivia's
  approved appointment `60000000-0000-4000-8000-000000000002`. Calls every
  tool once and prints a pass/fail table.

---

## 8. Definition of done

- With the migration and seed applied to the development project,
  `uv sync && make test` passes with **no engine API keys set** (only the
  Supabase values in `.env`), and leaves no test data behind.
- `make dev` starts all 7 servers (honcho + `Procfile.dev`); `make smoke` passes.
- `make lint` (ruff + mypy) is clean.
- Each server can be inspected with the MCP Inspector (document the command in the README).
- Supabase Security Advisor (pasted by me) shows no new warnings beyond the
  intentional app-facing functions (list any new ones in DECISIONS.md with
  the reason).
- README covers: setup, env vars, which SQL files to run in the SQL Editor
  and in what order, running the servers locally, minting a job token,
  switching an engine from mock to real, and connecting the servers to an
  agent (Claude Agent SDK for Python or any MCP client).

---

## 9. Things you must not do

- Do not modify the three existing migrations, the seed files or the Edge Function; add new files.
- Do not run any SQL that changes the database (DDL or writes outside tests); I run new SQL files in the SQL Editor.
- Do not reset, truncate or drop anything in the hosted project.
- Do not invent the Jev API. If `JEV_DOCS_PATH` is not set, build `JevEngine`
  as a stub that raises `EngineNotConfigured`, and keep using the mock.
- Do not expose any tool not listed in section 6.
- Do not store transcript text, quotes or review text in logs or new tables
  (except `transcript_segments`, which is deleted with its transcript).
- Do not use `service_role` in user mode.
- Do not add automatic engine fallbacks.
- Do not commit secrets; only `.env.example`.

---

## 10. Open decisions (record your assumption in DECISIONS.md; do not block)

- Retention of approved facts after consent withdrawal (section 4.5): implement as specified, mark TODO(legal).
- Whether patients see approved facts: default yes (RLS), easy to change.
- Hosting regions for Jev and the SLM: unknown; `allow_health_data` stays false for real engines until I change it.

---

## 11. `.env.example`

```
# Development project only. Values from the Supabase dashboard:
#   Project Settings -> API Keys      (URL, anon/publishable key, service_role/secret key)
#   Project Settings -> JWT Keys      (legacy JWT secret, only if the project still uses HS256)
#   Connect -> Session pooler         (DATABASE_URL, with your database password)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
DATABASE_URL=postgresql://postgres.<project-ref>:<db-password>@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres
JOB_TOKEN_SECRET=change-me-32-bytes-minimum
SMOKE_OLIVIA_PASSWORD=

JEV_API_URL=
JEV_API_KEY=
JEV_DOCS_PATH=

SLM_BASE_URL=
SLM_API_KEY=
SLM_MODEL=

TAVILY_API_KEY=
GOOGLE_PLACES_API_KEY=

ALLOWED_RESEARCH_DOMAINS=privatehealth.gov.au,data.gov.au,sunstate.example.com,harbourside.example.com,campuscover.example.com,wanderer.example.com
```

---

## 12. Phases (stop after each one and summarise what you built, test results, and assumptions)

0. **Plan.** Read the existing migrations and seeds. Using `.env`, connect to
   the development project read-only and confirm the three migrations and
   the sample data are present (e.g. tables exist, 8 sample patients). Check
   the JWT signing mode and the installed MCP Python SDK's API. Write a short
   plan and any questions. **Stop.**
1. **Database.** Write migration 4.1–4.8 and seed 4.9, then stop for me to
   run them in the SQL Editor. After I confirm, verify with read-only
   queries, then write and run database tests 4.10 (rolled back). Ask me for
   the Security Advisor results. **Stop.**
2. **Shared library.** Config, auth (both modes), context and allowlist, `user_tx`/`job_tx`, logging, guards, engine protocols with mocks, server factory. Unit tests. **Stop.**
3. **`booking` and `patient_record`.** With tests. **Stop.**
4. **`transcript` and `decision`.** With tests. **Stop.**
5. **`extraction`.** With tests, including grounding and idempotency. **Stop.**
6. **`matching` and `web_research`.** With tests. Stop before writing the PHIO parser to show me the file structure. **Stop.**
7. **Smoke client, security test sweep (section 7), README, DECISIONS.md, lint, Security Advisor check.** **Stop.**
