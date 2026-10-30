# Decision log

This file records product and engineering decisions that are not obvious from the code.
New decisions are appended; old decisions are not silently rewritten.

## 2026-10-27 — GP/clinic discovery and booking backend

### Stack

- The backend is Python. We use FastAPI on top of the existing Starlette, Pydantic and
  psycopg stack.
- The existing Supabase schema is extended in new migrations. Existing migrations are
  never edited.
- The existing Python token verification, database pool, RLS transaction helpers,
  Tavily search engine, domain allowlist and audit tables are reused.

### Ranking and result limits

- "Top 100" is a result cap after intelligent ranking, not "the 100 nearest clinics".
- The default hard search radius is 50 km. The client can request a different radius up
  to 500 km.
- Distance is one weighted factor (10% in the default weights), never the sole ordering.
- Results and flags are recomputed from live slots, fees, coverage and clinic acceptance
  on each request. Scraped research is not executed on the request path.
- The service/problem is supplied as a structured service code, with optional free text.
  Free text must match the service catalogue; unknown text returns
  `NEEDS_SERVICE_CLARIFICATION` rather than guessing.

### Insurance coverage

- The primary coverage source is privatehealth.gov.au and the official PHIO data it
  publishes. Individual insurer websites are a fallback only when the primary source has
  no page or no service-level rule.
- Coverage is modelled at plan level and at service/insurance-category level. A service
  such as root canal maps to an insurance category (for example major dental).
- Coverage data has a verification level:
  - `verified`: reviewed by staff and safe to use as an authoritative estimate.
  - `primary_extracted`: extracted from the primary government source but not yet
    staff-reviewed.
  - `fallback_unverified`: extracted from an insurer website when the primary source is
    missing.
- Fallback and unknown coverage must be shown with a warning telling the patient to
  confirm with their insurer and the clinic. They can never produce a "covered" promise.
- If neither source has a rule, the result is `UNKNOWN`; the system must not infer
  coverage.
- Patients can upload a policy document for manual staff verification. Documents are
  stored privately, are not sent to Tavily or an LLM, and are deleted after verification
  or the retention period.

### Clinic acceptance and claims

- privatehealth.gov.au does not establish whether a particular clinic accepts a plan or
  can claim directly.
- Clinic acceptance comes from configured insurer/provider directories, clinic websites,
  staff entry, or patient-provided policy evidence. It requires staff verification for
  authoritative use.
- The backend reports both direct billing and manual patient-claim paths separately.
  Actual insurer claim submission is out of scope.
- If acceptance or claim mode is unknown, the API returns `ACCEPTANCE_UNKNOWN`; plan
  coverage is never treated as proof that a clinic accepts it.

### Research and verification

- Tavily refresh runs on a schedule and can be triggered by staff. It does not run during
  patient discovery.
- Research stores source URL, retrieval time, content hash, a short supporting quote and
  extracted JSON. It does not store full web pages.
- Research queries contain plan/service information only; no patient data is sent to
  Tavily or the extraction model.
- New service-level coverage rules and clinic acceptance records require staff
  verification before they can be used as authoritative facts.
- The official PHIO import keeps the existing guard: only staff can verify insurer-site
  plan versions. Service-level rules always require staff verification.

### Booking

- A selected slot is held for five minutes using the existing `hold_slot` function.
- Booking revalidates the slot, service, clinic acceptance, coverage and quoted gap.
- The quoted fee/gap is stored on the appointment. A changed quote returns
  `QUOTE_CHANGED` instead of silently booking a different price.
- Booking requests are idempotent. The database's existing one-active-booking-per-slot
  index remains the final double-booking guard.

## 2026-10-28 — Consult transcription and key points

### Flow and engines

- Consults are recorded only after both parties consent with wording `v2` (covers AI
  analysis). The audio is transcribed in memory by the `transcribe-consult` Edge Function
  and never stored.
- Speech-to-text is ElevenLabs Scribe, called by the `transcribe-consult` Edge Function
  (`ELEVENLABS_*` secrets). Nebius Token Factory serves the language models only.
- Nothing is extracted until the patient approves the transcript. Approval queues a
  `consult_note_runs` row through a database trigger, so a missed client call can't skip
  processing.
- Two engines, each selected through `model_registry` with `health_data=True`:
  - the **SLM** (extraction engine, Nebius) writes draft `clinical_facts` for every active
    `clinical_fields` entry;
  - **Jev** (decision engine) answers every active `decision_questions` entry and writes
    draft `consult_key_points`. Attribute (`attr_*`) and evidence questions are not key
    points.
- Jev is called through `typesafe_sdk` (`AsyncTypeSafeClient.system_one`, model
  `JEV_MODEL`, default `jev-latest`). The questions are built at call time from the
  active `decision_questions` rows, so adding or editing a row changes what Jev is
  asked with no code change: `choice` → `Choice` (criteria = option values and labels),
  `score` → `Score` (criteria = level descriptions in level order; Jev scores by
  position from zero), `yes_no` → a three-way `Choice` of yes / no / not_stated. A
  `Noul` was not used because it returns only P(yes), and "not discussed" must stay
  distinct from "denied".
- An answer's probability is the lower of the chosen option's probability and Jev's
  `confidence`. If it is below `DECISION_REVIEW_BELOW` (0.6), or Jev found nothing to
  note but was unsure in some window, the SLM answers the same question. The more
  confident answer becomes the suggestion (`answer_source`), the other is kept
  (`other_opinion_*`), `meets_threshold` is false, and a `missing_info` open item asks the
  GP to confirm. This is a documented review step, not a fallback: both answers are
  stored, and the patient sees only what the GP approves.
- `explain` questions (new kind, no options) need a short explanation rather than an
  option. They skip Jev and go straight to the SLM; the explanation is stored in
  `answer_text`, always needs GP approval (`edit_and_approve_key_point_text` edits it),
  and is never logged (`decision_log` holds a hash).
- The SLM is reached through the enabled extraction entry (`EngineRegistry.decision_review`),
  so it needs the same `allow_health_data` approval as extraction.
- The transcript is split into windows of segments (`CONSULT_NOTES_WINDOW_SEGMENTS`,
  default 20). Each field is extracted per window, so several medications or symptoms are
  kept, and the same value found twice is stored once. Each question is answered per
  window and aggregated: any confident `yes` wins; for scores the highest level that meets
  the threshold wins. "Nothing stated" answers (`not_stated`, `unclear`, the lowest score
  level) are not stored.
- Answers below their question's threshold are stored with `meets_threshold = false` and
  raise a `missing_info` open item. Urgency level 2 or 3 raises an `urgent` open item,
  which notifies the facility.
- Fact offsets are relative to the source segment's text, as returned by the extraction
  engine. If the model's offsets are wrong but its quote occurs exactly once, the offsets
  are corrected; otherwise the result is rejected as before.

### Review and retention

- Agents insert drafts only. The treating clinician (or staff) approves, edits or rejects
  them through `approve_key_point`, `edit_and_approve_key_point` and `reject_key_point`
  (and the existing fact functions). An edited answer must be one of the question's
  options. The patient sees approved items only.
- Key points store option values, probabilities and segment ids, never transcript text,
  except an explain key point's `answer_text`, which is what the GP reviews. Facts store
  a quote hash, never the quote.
- Before production, confirm TypeSafe's hosting region and data-retention terms, as for
  Nebius; `seed/06` allows health data for both in development only.
- Deleting an approved transcript (for example on consent withdrawal) deletes draft and
  rejected key points and keeps approved ones with `source_removed_at`, the same as facts.
  TODO(legal): confirm this retention rule.

### Frontend wiring and security

- The web app (Flutter) talks only to Supabase: RPCs, the Edge Function, RLS-filtered
  reads, and Realtime on `consult_note_runs`. There is no separate Python API for it.
- The worker runs server-side with `DATABASE_URL`, in job mode, scoped to the claimed
  appointment. Queue functions are granted to `service_role` only. `consult_note_runs`
  carries status, counts and an error code only, so it is safe to publish to Realtime.
- `transcribe-consult` keeps "Verify JWT" on; CORS allows any origin, and every call
  still needs a signed-in user's token.
- Before production, the Nebius hosting region, zero-data-retention terms and
  data-processing agreement must be confirmed. Until then, `allow_health_data` is enabled
  only in the development project (`seed/06_nebius_engines.sql`).

### Logs

- With `LOG_DIR` set, each service also writes a rotating `logs/<service>.log` with the
  same redaction as console logs. The `logs/` folder is git-ignored apart from `.gitkeep`.

## 2026-10-30 — The seven MCP servers

### Structure

- `src/healthmcp/servers/<name>/` has `tools.py` (`register(server, repo=None)`),
  `__main__.py` and, where needed, `repository.py`. Tool handlers never write SQL: each
  server has a repository Protocol with a Pg implementation (through `db.py`) and an
  in-memory Fake. With `DATA_BACKEND=fake` the Fake is used, so every server runs and is
  tested with no database or API keys.
- `transcript`, `decision` and `extraction` share `servers/clinical.py` (job mode, every
  query pinned to the token's appointment) and `servers/grounding.py`.
- Existing code is reused: the consult-notes eligibility function, the engines and
  registry, `find_gp_candidates`, `estimate_fees`, `get_available_slots`, `hold_slot`,
  `get_clinician_rating_summary`, and the discovery `ResearchWorker` for
  `refresh_plan_coverage`.

### Assumptions

- Date parameters are named `on_date` / `date_from` / `date_to` instead of the spec's
  `date`, `from` and `to` (`from` is a Python keyword, and `date` would hide the type).
- Every tool that reads transcript text first checks `get_processing_eligibility`.
  `create_gp_query`, `list_open_items` and `get_clinician_preferences` do not read the
  transcript and skip it (a GP query from the patient app may have no transcript).
- `decision`: attribute and evidence questions are added per asked question, with ids
  `<template>__<question>`, so they cannot be asked directly. Answers below
  `DECISION_REVIEW_BELOW` (0.6) also get the SLM's opinion, as in the consult-notes
  worker: the more confident answer is suggested, both are returned, and
  `needs_gp_review` is true. `explain` questions go to the SLM directly.
- `save_draft_fact` stores the server's grounding offsets and segment, not the agent's.
  Duplicates are the same field and value in a draft that shares a segment.
- `raise_open_item(kind="urgent")`: severity comes from `urgency_level` over the approved
  transcript (levels 2 and 3 map to 6 and 9, as in the worker). If the engine does not
  rate the consult urgent with enough confidence, the item is refused and the agent can
  raise it as `missing_info`. The database trigger creates the clinic notification.
- `find_gp_candidates`: postcodes come from a small local table of sample postcodes
  (`servers/matching/postcodes.py`). Stored preferences apply unless overridden; the
  distance limit applies only when a location is given. `applied` echoes the search.
- `get_score_breakdown`: `patient_rating` and `wait_time` are the rating-based factors,
  shown only with at least 5 visible ratings.
- `refresh_facility_reviews`: reviews with clinical words are dropped in code, and the
  rest are checked with the decision engine (`health_data=False`; public review text,
  not patient data). The stored summary is a deterministic list of common themes, so no
  review is quoted or stored.
- `refresh_plan_coverage` creates staff-reviewed `research_drafts` through the existing
  research worker (the newer pipeline) rather than draft `insurance_plan_versions`.
- `import_phio_dataset` is registered but always refuses: spec 6.7 requires reviewing a
  real file's structure before the parser is written.
- `web_research` runs in both modes (the `insurance` agent searches in user mode); the
  two refresh tools and the PHIO import refuse outside job mode.

### Fixes after the curl verification
- `create_gp_query` requires the `gp_query:create` job-token scope from every caller.
  `/chat/confirm` already mints it; a clinical-doc-agent job that may raise GP queries
  must be minted with `--scope gp_query:create` (`make token ... SCOPE=gp_query:create`).
- The research extractor follows the enabled `extraction` engine in `model_registry`
  (`slm` -> `OpenAIResearchExtractor`, `mock_extraction` -> `MockResearchExtractor`);
  any other engine, or `slm` without model keys, raises `EngineNotConfigured` with no
  fallback. This applies to `refresh_plan_coverage` and `make research`.
- `MockResearchExtractor` quotes the page sentence sharing the most words with the query
  and sets the status from keywords, with a fixed confidence of 0.5. Its results are still
  pending drafts for staff.
- With `DATA_BACKEND=fake`, research drafts go to an in-memory `FakeResearchRepository`
  whose plan_coverage targets mirror seed 05. The seed's target ids are random, so the
  fake uses fixed ids `a1000000-0000-4000-8000-0000000000<plan><category>`.
- The fake booking repository follows `hold_slot` / `get_available_slots`: a live hold
  by another patient makes the slot unavailable until it expires, and the holder may renew.
- Every SLM call (extraction, SLM decisions, research, and the agent while it falls back to the
  SLM model) sends `chat_template_kwargs: {enable_thinking: false}` unless `SLM_DISABLE_THINKING=false`:
  live, Nemotron-3.5-Lightning spent ~6k reasoning tokens (~29s) per extraction and hit the 30s timeout.
- `request_gp_query_approval` takes an optional `appointment_id` (accepted only if it is in the
  patient's own `get_appointments`); without one it uses the only appointment, else the most recent
  completed one, else returns the choices. Before, it needed exactly one appointment on the account,
  so no patient with history could ask. Confirm checks the appointment is still the patient's.
- Agent role `booking` (user mode): `find_gp_candidates`, `get_available_slots`, `propose_booking`
  only. The router sends `book`/`booking` and appointment-request phrases to it (after insurance).
  `/chat` returns the proposal (`booking_proposal`); the agent can propose once per message and
  never confirms: `confirm_booking_proposal` stays app-only, as in spec 6.
- SLM calls time out after `SLM_TIMEOUT_SECONDS` (default 60, was a fixed 30): live, the serverless
  Nemotron-3.5-Lightning queued trivial calls for 45-85 s under load, failing whole consult-notes runs.
- Agent router markers match whole words ("fee" no longer catches "coffee"/"feeling"), with clinical-worry
  markers (tired, dose, side effects, "should I", "is it normal"...) going to insights. A message with no
  markers routes like the patient's latest earlier message (follow-ups such as "yes please").
- `/chat` takes `history` (up to 12 earlier turns, kept in the page only) and every user-mode agent gets
  `today` and `time_zone` (`AGENT_TIME_ZONE`, default Australia/Brisbane): live, agents guessed the date from
  training data and read Olivia's previous insurance policy. Observations carry `observed_local_date`.
- Insights safety net: when its answer says the record doesn't answer the question and it prepared no GP
  query, the service prepares one in the patient's own words for the clinician of the most recent completed
  visit (still sent only on the patient's approval). Leaked model reasoning (`<think>`) is stripped from answers.
- Vercel (services mode, `vercel.json`): one public service `web` and one internal Python service `backend`
  (`vercel_backend:app`, `src/healthmcp/backend.py`) that mounts the agent at `/agent` and discovery at
  `/discovery`; the gateway and the seven MCP servers run in the same process over in-process ASGI
  transports (same tokens, allowlist, mode checks and rate limits), with one shared pool. `web` binds to it as
  `BACKEND_URL`. The consult worker is a daemon (`Dockerfile.worker`). Locally the services stay separate.
- Discovery service matching: a single alias match books straight away; when no alias matches, plain
  keywords (tired, sore, teeth, mole, flu shot...) pick the service; otherwise the patient chooses from
  every active service, GP first. It no longer answers SERVICE_NOT_FOUND for free text.
