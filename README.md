# MediANZ - Find your care, anywhere.

**Live app:** [MediANZ Application](https://medianz.vercel.app) · **Product demo:** [MediANZ Product Demo](https://youtu.be/zxfle3RUfr4) · **License:** [MIT](LICENSE)

Patients find and book care with AI (costs after Medicare and insurance), ask an AI
assistant about their own approved record, and record consults with consent;
clinicians review AI-drafted notes; reception runs the front desk. The language
models are **NVIDIA Nemotron** served by **Nebius Token Factory**
([details below](#nvidia-nemotron-on-nebius-token-factory)).

For evaluators: open https://medianz.vercel.app/login?demo and choose **Patient**
(Olivia Brown), **Clinician** (Dr Asha Rao) or **Receptionist** (Southbank front
desk). No password or authenticator code is needed. The data is shared sample data,
so you will see other evaluators' bookings, approvals and answers.

The app runs on Vercel as one project (`vercel.json`): the Next.js app `web`, the
internal Python service `backend` and the consult-notes daemon `consult-worker`,
with Supabase for the database, sign-in and transcription. Deployment steps are in
[web/README.md](web/README.md#deploying-to-vercel).

## Setup

### Prerequisites
- Python 3.12 and [uv](https://docs.astral.sh/uv/); Node.js 20.9 or later with npm
  (tested with Node 24).
- For live mode: a Supabase project, a Nebius Token Factory API key, a Jev (TypeSafe)
  key for the decision engine and an ElevenLabs key for speech-to-text. Optional:
  Tavily (insurance research), Google Maps and Places keys, Docker (worker image).

### 1. Try it without any accounts (mock mode)
```bash
git clone https://github.com/gokulprazath/MediANZ.git
cd MediANZ/web
npm ci
npm run dev        # open http://localhost:3000/login?demo
```
Mock mode keeps sample data in memory and answers with deterministic stand-in agents:
no keys and no database. Pick Patient, Clinician or Receptionist on the Demo account tab
(or sign in with the accounts listed on the login page: password `medianz-demo`, then
the authenticator code `123456` for clinicians and staff).

### 2. Live mode on your machine
1. **Supabase:** run the SQL files below in order (SQL Editor), create the test logins
   and run `seed/02_link_test_logins.sql`, then deploy the `transcribe-consult` Edge
   Function with its `ELEVENLABS_API_KEY` secret ([Edge Function](#edge-function)).
2. **Python services:**
   ```bash
   uv sync
   cp .env.example .env   # then fill it in (comments in the file)
   ```
   Key settings: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`,
   `DATABASE_URL` (the Session pooler URI), `JOB_TOKEN_SECRET` (at least 32 bytes:
   `openssl rand -base64 48`), `SLM_BASE_URL=https://api.tokenfactory.nebius.com/v1/`,
   `SLM_API_KEY`, `SLM_MODEL=nvidia/nemotron-3-super-120b-a12b`, `JEV_API_KEY`.
   Then start each in its own terminal:
   ```bash
   make servers                                              # the 7 MCP servers (3101-3107)
   make gateway                                              # MCP gateway (3100)
   make agent                                                # agent service (3108)
   uv run uvicorn healthmcp.discovery.app:app --port 3109    # discovery API
   make consult-worker                                       # consult-notes worker
   ```
3. **Web app:**
   ```bash
   cd web
   cp .env.example .env.local
   # NEXT_PUBLIC_DATA_MODE=live, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
   # AGENT_SERVICE_URL=http://localhost:3108, DISCOVERY_SERVICE_URL=http://localhost:3109
   npm run dev
   ```

### 3. Tests
```bash
make test                 # Python, fully offline
make lint                 # ruff, format check, mypy
make test-integration     # against the development database, each test rolled back
cd web && npm test && npm run typecheck && npm run test:e2e   # web unit + Playwright (mock mode)
```

### 4. Deploy
One Vercel project runs the web app, the Python backend and the worker: see
[web/README.md](web/README.md#deploying-to-vercel).

## NVIDIA Nemotron on Nebius Token Factory

Every language-model call in MediANZ goes to an **NVIDIA Nemotron** open model on
**Nebius Token Factory** (OpenAI-compatible API, `https://api.tokenfactory.nebius.com/v1/`).
The default is `nvidia/nemotron-3-super-120b-a12b`; we also ran
`nvidia/Nemotron-3_5-Lightning` live and compared the two.

### Where Nemotron is used
| Feature | What Nemotron does | Code |
| --- | --- | --- |
| Consult notes | After the patient approves a transcript, drafts clinical facts (medicines, symptoms, observations, follow-ups) as JSON-schema output, each tied to a quote and segment of the transcript and checked before it is saved. A clinician approves every fact. | `src/healthmcp/shared/engines/extraction.py`, `src/healthmcp/consult_notes/` |
| Key-point second opinion | Answers when the decision engine (Jev) is below 0.6 confidence, and the free-text "explain" questions; the clinician still approves. | `src/healthmcp/shared/engines/decision.py` (`SlmDecisionEngine`) |
| Patient AI assistant | LangGraph agents for records, insurance, fees and booking use Nemotron with tool calling through the MCP gateway, limited to the signed-in patient's data. Questions it can't answer become a GP question the patient approves. | `src/healthmcp/agent.py` |
| Insurance research | Extracts plan coverage from allowlisted public pages into drafts that staff approve. | `src/healthmcp/discovery/research.py` |

### Where Token Factory sped up our work
These figures were measured while running the app live:
- **One OpenAI-compatible endpoint for every feature.** The same `openai` and
  `langchain-openai` clients serve extraction, decisions, agents and research. Changing
  the model is one setting (`SLM_MODEL`), so we compared two Nemotron models on live
  traffic without code changes.
- **Structured outputs and tool calling.** `response_format: json_schema` returns facts
  and answers in our schema, which are validated before anything is saved. Tool calling
  drives the four patient agents.
- **Reasoning control.** Turning off Nemotron's reasoning
  (`chat_template_kwargs: {"enable_thinking": false}`, setting `SLM_DISABLE_THINKING`)
  cut a 20-segment extraction from 28.5 s and 6,163 reasoning tokens to about 1.5 s and
  98 tokens. A whole consult-notes run (facts and key points) then finished in 11 s.
- **Picking the model by latency.** With 8 concurrent calls, Nemotron 3 Super answered
  in about 1 s each. The serverless Lightning model ranged from about 1 s to 85 s
  depending on load, so Super is the default and the per-call timeout is a setting
  (`SLM_TIMEOUT_SECONDS`).
- **Model registry.** Each engine is recorded in `model_registry` with its provider
  ("Nebius Token Factory", `seed/06_nebius_engines.sql`) and whether it may receive
  health data. Confirm the region and data-retention terms before production.

### Other Nebius tools or services
Token Factory (model inference) is the only Nebius service MediANZ uses. The other
parts are: hosting on Vercel; database, sign-in and the transcription function on
Supabase; speech-to-text with ElevenLabs Scribe; and the decision engine Jev (TypeSafe).

## Repository structure

```
MediANZ/
├── LICENSE                  # MIT
├── vercel.json              # Vercel: web and backend services, consult-worker daemon
├── vercel_backend.py        # entrypoint of the Vercel backend service
├── Dockerfile.worker        # consult-notes worker image (Vercel daemon)
├── pyproject.toml, uv.lock  # Python 3.12 project (uv)
├── Makefile                 # run the services, the worker and the tests
├── .env.example             # every setting, with comments (copy to .env; never commit .env)
├── config/agents.json       # which agent may use which MCP tools
├── src/healthmcp/           # 7 MCP servers, gateway, agent service, discovery API, consult worker
├── tests/                   # Python unit, database and integration tests
├── web/                     # Next.js app: patient, clinician and staff portals
├── supabase/
│   ├── migrations/          # schema changes, run in filename order
│   ├── seed/                # sample data (development projects only)
│   └── functions/transcribe-consult/   # Edge Function: transcribes audio in memory, never stores it
└── docs/                    # build spec and decision logs
```

The repository is the record of every SQL file you have run in the dashboard;
new files are always added with a later date, never by editing old ones.

## Applying the SQL (Supabase website)

Run each file **once**, in this order, in **SQL Editor → New query → paste → Run**.
Skip any you have already run.

| # | File | What it does |
|---|---|---|
| 1 | `migrations/20261026000000_health_booking_schema.sql` | All tables, history, booking, transcripts, ratings, RLS, cron jobs |
| 2 | `migrations/20261026010000_security_advisor_fixes.sql` | Moves `btree_gist` out of `public`, hides trigger functions from the API |
| 3 | `migrations/20261026020000_visit_vitals.sql` | Vital signs per visit |
| 4 | `seed/01_sample_data.sql` | Sample people, clinics, plans, visits, transcripts, ratings, claims |
| 5 | `seed/02_link_test_logins.sql` | First create the test logins it lists (Authentication → Users → Add user, tick Auto Confirm), then run it. Re-run whenever you add more test logins. |
| 6 | `seed/03_sample_vitals.sql` | Sample vitals for past visits |
| 7 | `migrations/20261027000000_agent_layer.sql` | Agent layer part 1: AI-consent versions, transcript segments, decision/field/model registries, draft facts, open items, GP queries, deletion cascade, human-only review functions, append-only agent logs, `mcp_server` role |
| 8 | `migrations/20261027010000_agent_layer_booking_matching.sql` | Agent layer part 2: booking proposals, GP matching data, fee schedules, insurance plan versions, review summaries, `find_gp_candidates`, `estimate_fees` |
| 9 | `seed/04_agent_layer_sample.sql` | Sample agent-layer data: questions, fields, mock engines on, clinician languages, preferences, fees, plan versions, scores, review summaries; moves Olivia's approved transcript consents to `v2` (safe to re-run) |
| 10 | `migrations/20261027020000_service_discovery.sql` | Service catalogue, prices, insurance coverage/acceptance evidence, patient policy documents, staff-reviewed research drafts, service booking |
| 11 | `seed/05_discovery_sample.sql` | Sample dental clinics, services, prices, insurance evidence, research targets and generated slots |
| 12 | `migrations/20261028000000_consult_key_points.sql` | Consult notes: processing queue (`consult_note_runs`, queued when a transcript is approved, published to Realtime), draft key points from the decision engine, review functions, deletion cascade |
| 13 | `migrations/20261028010000_key_point_second_opinion.sql` | Key points: SLM second opinion when Jev is below 0.6, `explain` question kind (free-text answers), `edit_and_approve_key_point_text` |
| 14 | `seed/06_nebius_engines.sql` | Development only: Nebius Token Factory as the SLM and Jev as the decision engine (both allow health data), sample explain questions |
| 15 | `migrations/20261028100000_chunked_transcription.sql` | Chunked transcription for the `transcribe-consult` Edge Function (temporary text per chunk, joined into one draft). Recording fails without it. |
| 16 | `migrations/20261030000000_partb_live_agents.sql` | Web app Part B: Realtime for appointments, consents, recording sessions and GP queries; `patient_check_in`; patients read their own GP questions; staff-only `get_agent_activity` / `get_engine_activity`. |
| 17 | `seed/07_olivia_demo_data.sql` | Demo data for Olivia: more history, an approved transcript, an answered question, a review in two weeks and a visit checked in now (re-run before a demo for a fresh one) |

Files 4–6, 9, 14 and 17 are sample data or development settings: use them only in a
development project, never in the project that will hold real patients.

## MCP servers (Python, work in progress)

```
uv sync
make test              # offline: no network, database or API keys
make lint              # ruff + mypy (strict)
make test-integration  # database tests against the dev project (rolled back)
```

The seven servers live in `src/healthmcp/servers/`:

| Server | Port | Mode | Tools |
|---|---|---|---|
| `transcript` | 3101 | job | `get_processing_eligibility`, `get_transcript_windows`, `search_transcript`, `check_grounding` |
| `decision` | 3102 | job | `decide_batch`, `decide_yes_no`, `decide_choice`, `decide_score` |
| `extraction` | 3103 | job | `extract_value`, `save_draft_fact`, `raise_open_item`, `create_gp_query`, `list_open_items`, `get_clinician_preferences` |
| `patient_record` | 3104 | both | `get_approved_facts`, `get_observations`, `get_eligibility`, `get_appointments` |
| `matching` | 3105 | user | `get_patient_gp_preferences`, `find_gp_candidates`, `get_score_breakdown`, `get_fees`, `get_plan_coverage`, `get_facility_review_summary` |
| `booking` | 3106 | user | `get_available_slots`, `hold_slot`, `propose_booking`, `propose_cancellation`, `propose_reschedule`, `get_proposal_status` |
| `web_research` | 3107 | both | `web_search`, `web_extract`, `refresh_plan_coverage`, `refresh_facility_reviews`, `import_phio_dataset` |

Every server also has `log_note`. Which agent may call which tool is set in
`config/agents.json`.

```
make servers                  # all seven; Ctrl+C stops them
make server NAME=booking      # or one: uv run python -m healthmcp.servers.booking
DATA_BACKEND=fake make servers   # sample data in memory: no database or API keys
```

With `DATA_BACKEND=pg` (the default) the servers use `DATABASE_URL`. From WSL use the
**Session pooler** connection string (IPv4), and URL-encode special characters in the
password (`@` is `%40`).

An agent can connect to the servers individually or use the optional gateway,
which exposes all seven on `http://127.0.0.1:3100/mcp` with names such as
`booking__get_available_slots`:

```
make gateway             # or: uv run python -m healthmcp.gateway
```

Start the seven servers first; the gateway defaults their URLs to
`http://127.0.0.1:<server port>/mcp`. It forwards `Authorization` and
`X-Agent-Id` unchanged, so each upstream keeps enforcing its own token mode and
tool allowlist. The gateway is not required when the agent can use several MCP
connections.

### Agent layer

`src/healthmcp/agent.py` runs LangGraph agents through the gateway:

```
make agent               # or: uv run python -m healthmcp.agent
```

* `POST /chat` (Supabase user token) routes to `explainer`, `insights`, or
  `insurance`. Each node binds only the tools for its role in
  `config/agents.json`.
* `POST /chat/confirm` exchanges a signed pending GP-query action for a
  two-minute `insights-writer` job token. Only this code path can call
  `create_gp_query`; the model never sees that tool.
* `POST /extract` accepts only an `extractor` job token and writes draft facts.

Patient ids never come from request fields or tool arguments: the request
models reject unknown fields, and the MCP servers read the patient from the
token. The Jev engine in `shared/engines/decision.py` uses `typesafe_sdk`
(set `JEV_API_KEY`); `insights` still answers from approved facts and the
GP-query approval path.

Configuration: copy `.env.example` to `.env`. Build notes and assumptions are in
`docs/MCP_BUILD_SPEC.md` and `docs/DECISIONS.md`.

## Discovery API

```bash
uv run uvicorn healthmcp.discovery.app:app --reload --port 3109
```

The API exposes `/v1/services`, `/v1/discovery`, `/v1/availability`,
`/v1/insurance/check`, `/v1/holds`, `/v1/bookings`, and patient insurance
document registration. Staff can review extracted evidence at
`/v1/research/drafts`; approval/rejection requires a Supabase user token whose
`app_metadata.role` is `staff` or `admin`.

Run the scheduled research batch manually with:

```bash
make research ARGS="--limit 10 --category major_dental"
```

It needs `DATABASE_URL`, a configured search engine in `model_registry`, and the
agent/SLM model settings. Research results are pending drafts until staff approve
them; the patient request path never invokes web search.

## Edge Function

Edge Functions → Deploy a new function → Via Editor → name it
`transcribe-consult` → paste `supabase/functions/transcribe-consult/index.ts`
→ Deploy (keep "Verify JWT" on). Then add the `ELEVENLABS_API_KEY` secret under
Edge Functions → Secrets (optional: `ELEVENLABS_STT_MODEL`, default `scribe_v2`;
`ELEVENLABS_LANGUAGE`, default `en`; `ELEVENLABS_KEYTERMS`). Speech-to-text is
ElevenLabs Scribe; the audio is transcribed in memory and never stored. Any origin
may call the function, but every call needs a signed-in user's token.

## Consult notes

Recording, transcription, key points and review, with the web app (Flutter)
talking only to Supabase:

1. Both parties consent: `rpc/give_recording_consent` with wording `v2` (covers AI analysis).
2. The app records audio and posts it to the `transcribe-consult` Edge Function.
   The audio is transcribed in memory and never stored; the draft transcript
   waits for the patient.
3. The patient approves it (`rpc/approve_transcript`). Segments are built and a
   `consult_note_runs` row is queued automatically.
4. The worker processes the queue:

   ```
   make consult-worker              # run until stopped
   make consult-worker ARGS=--once  # drain the queue, then exit
   ```

   The SLM (engine `slm`: NVIDIA Nemotron on Nebius Token Factory) writes draft `clinical_facts` for every
   active `clinical_fields` entry. The decision engine (Jev, through
   `typesafe_sdk`; `mock_decision` without seed 06) answers every active yes/no,
   choice and score `decision_questions` entry, with the questions built from
   the table at run time, and writes draft `consult_key_points`. Jev answers
   below 0.6 also get the SLM's opinion, and the GP confirms. `explain`
   questions (free-text answers) go straight to the SLM. Low-confidence
   answers and urgent findings raise `open_items`.
5. The app watches `consult_note_runs` over Realtime. The treating clinician
   reviews drafts with `rpc/approve_fact` / `reject_fact` and
   `rpc/approve_key_point` / `edit_and_approve_key_point` /
   `edit_and_approve_key_point_text` (explain questions) / `reject_key_point`.
   The patient sees approved items only.

Step-by-step curl commands for the whole flow are in [`check.md`](check.md).
With `LOG_DIR=logs`, each service also writes `logs/<service>.log` (git-ignored).

## Recommended: two projects

| Project | Used for | Seeds? |
|---|---|---|
| `health-app-dev` | Building and testing, including the MCP servers and Claude Code | Yes (files 4–6) |
| `health-app` (production) | Real patients | **No**: migrations 1–3 only |

Claude Code only ever connects to the development project.

## License

MediANZ is released under the [MIT License](LICENSE).
