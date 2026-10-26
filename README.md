# Health booking app

## Repository structure

```
health-app/
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

Files 4–6 are sample data: use them only in a development project, never in
the project that will hold real patients.

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
