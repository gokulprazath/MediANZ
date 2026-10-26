# Health booking app

## Repository structure

```
MediANZ/
├── README.md
├── .env                                  # your secrets (never commit; see docs/MCP_BUILD_SPEC.md §11)
├── docs/
│   └── MCP_BUILD_SPEC.md                 # build spec for the Python MCP servers (give to Claude Code)
└── supabase/
    ├── migrations/                       # schema changes, run in filename order
    │   ├── 20261026000000_health_booking_schema.sql
    │   ├── 20261026010000_security_advisor_fixes.sql
    │   └── 20261026020000_visit_vitals.sql
    ├── seed/                             # sample data (development/test projects only)
    │   ├── 01_sample_data.sql
    │   ├── 02_link_test_logins.sql
    │   └── 03_sample_vitals.sql
    └── functions/
        └── transcribe-consult/
            └── index.ts                  # Edge Function: transcribes audio in memory, never stores it
```

The Python MCP servers (`pyproject.toml`, `src/healthmcp/`, `tests/`, …) are
added at the top level by Claude Code, following `docs/MCP_BUILD_SPEC.md`.
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

Files 4–6 and 9 are sample data: use them only in a development project, never in
the project that will hold real patients.

## MCP servers (Python, work in progress)

```
uv sync
make test              # offline: no network, database or API keys
make lint              # ruff + mypy (strict)
make test-integration  # database tests against the dev project (rolled back)
```

Configuration: copy `.env.example` to `.env`. Build notes and assumptions are in
`docs/MCP_BUILD_SPEC.md` and `docs/DECISIONS.md`.

## Edge Function

Edge Functions → Deploy a new function → Via Editor → name it
`transcribe-consult` → paste `supabase/functions/transcribe-consult/index.ts`
→ Deploy (keep "Verify JWT" on). Then add the `STT_API_URL`, `STT_API_KEY` and
`STT_MODEL` secrets under Edge Functions → Secrets.

## Recommended: two projects

| Project | Used for | Seeds? |
|---|---|---|
| `health-app-dev` | Building and testing, including the MCP servers and Claude Code | Yes (files 4–6) |
| `health-app` (production) | Real patients | **No**: migrations 1–3 only |

Claude Code only ever connects to the development project.
