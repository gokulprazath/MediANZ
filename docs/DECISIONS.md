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
- Speech-to-text uses an OpenAI-compatible `/v1/audio/transcriptions` endpoint (Nebius
  Token Factory in development). The provider is chosen only by Edge Function secrets.
- Nothing is extracted until the patient approves the transcript. Approval queues a
  `consult_note_runs` row through a database trigger, so a missed client call can't skip
  processing.
- Two engines, each selected through `model_registry` with `health_data=True`:
  - the **SLM** (extraction engine, Nebius) writes draft `clinical_facts` for every active
    `clinical_fields` entry;
  - **Jev** (decision engine) answers every active `decision_questions` entry and writes
    draft `consult_key_points`. Attribute (`attr_*`) and evidence questions are not key
    points.
- The Jev client is not built yet (it needs the API docs at `JEV_DOCS_PATH`), so
  `mock_decision` is enabled until then. Switching is a `model_registry` change, never an
  automatic fallback.
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
- Key points store option values, probabilities and segment ids, never transcript text.
  Facts store a quote hash, never the quote.
- Deleting an approved transcript (for example on consent withdrawal) deletes draft and
  rejected key points and keeps approved ones with `source_removed_at`, the same as facts.
  TODO(legal): confirm this retention rule.

### Frontend wiring and security

- The web app (Flutter) talks only to Supabase: RPCs, the Edge Function, RLS-filtered
  reads, and Realtime on `consult_note_runs`. There is no separate Python API for it.
- The worker runs server-side with `DATABASE_URL`, in job mode, scoped to the claimed
  appointment. Queue functions are granted to `service_role` only. `consult_note_runs`
  carries status, counts and an error code only, so it is safe to publish to Realtime.
- `transcribe-consult` keeps "Verify JWT" on and restricts CORS to
  `CORS_ALLOWED_ORIGIN` when it is set.
- Before production, the Nebius hosting region, zero-data-retention terms and
  data-processing agreement must be confirmed. Until then, `allow_health_data` is enabled
  only in the development project (`seed/06_nebius_engines.sql`).

### Logs

- With `LOG_DIR` set, each service also writes a rotating `logs/<service>.log` with the
  same redaction as console logs. The `logs/` folder is git-ignored apart from `.gitkeep`.
