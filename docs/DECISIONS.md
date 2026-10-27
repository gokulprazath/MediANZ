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
