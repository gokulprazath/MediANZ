# About the project

## Inspiration

Healthcare is about people, but too much of it gets lost in phone queues, paper forms and scattered systems. I wanted to build **one place that works for everyone in the room**:

- **Patients** should get dedicated support: find the right care nearby, know what it will cost before they go, book in a few taps, and understand their own visit afterwards without waiting on hold.
- **Clinicians** should understand their patients better, with an approved summary of what was said and a clear record, and should see their schedule monitored and organised instead of juggling it.
- **Clinics** should get more patient inflow: be found by people nearby who need exactly the service they offer, with honest prices and free times that fill up.

That is **MediANZ**: a patient, clinician and clinic platform with a fleet of AI agents that help, but never decide on their own.

## What it does

| Who | What they get |
| --- | --- |
| Patient | Profile and Medicare/insurance details, a clinic map, an **AI care finder** (describe the problem → ranked clinics with the estimated out-of-pocket cost → hold → book), appointment-day check-in, consent and recording, transcript review, an **AI assistant** that answers only from the record their clinician approved, and feedback |
| Clinician | A calendar, a consult view (vitals, notes, fees, consent and recording), a **review queue** where they approve, correct or reject what the AI drafted from the consultation, patient questions to answer, ratings and leave |
| Clinic staff | Front desk check-in, booking for patients, slots and schedules, clinician profiles, visits, fees and insurance claims, reports, rating moderation, and an **AI operations** view of the agent fleet |

## How I built it

### 1. The database is the source of truth

Everything starts in **Supabase (Postgres)**. The schema covers patients (with history-aware addresses, residency and insurance), facilities, clinicians, schedules, slots, appointments, consent, recordings, transcripts, ratings, vitals and claims. Every table has **Row Level Security**, and booking happens only through database functions (`hold_slot`, `book_slot`, `cancel_appointment`, `reschedule_appointment`), so two patients can never get the same slot. Triggers record arrival and consult times and keep a status history. `pg_cron` releases expired holds, marks no-shows and generates eight weeks of slots every night.

The central rule I designed around:

> **Models interpret and propose; the database decides and acts.**

### 2. A fleet of agents, not one chatbot

On top of the database I built **seven MCP servers** in Python (transcript, decision, extraction, patient-record, matching, booking, web-research), a **gateway**, and a LangGraph **agent service**.

- A small **deterministic router** picks the agent (records, insurance, or fees and matching), so a model can never pick or widen its own permissions.
- Each agent gets only an allowlist of tools, and the patient is always taken from the signed-in user's token, never from a tool argument.
- When the records agent can't answer, it drafts a question for the clinician as an **HMAC-signed pending action**. Nothing is sent until the patient taps *Approve*.
- After a patient approves a transcript, a worker drafts **key points** (typed yes/no, choice and score answers, each with a probability) and **clinical facts**. They go into the record only when a clinician approves them.

### 3. Consultation recording without storing audio

Audio is transcribed in memory by an Edge Function and then discarded; only text is kept. Long consultations are recorded in chunks so that each upload stays small and a failure costs only one chunk. If the consult lasts $T$ minutes, the browser sends

$$
n(T) =
\begin{cases}
1, & T \le 15 \\[4pt]
1 + \left\lceil \dfrac{T - 15}{5} \right\rceil, & T > 15
\end{cases}
$$

files: the first 15 minutes as part 1, then a fresh file every 5 minutes. A failed upload is retried with the same part number after $2, 4, 8, 16$ seconds, so the server stores each part once.

### 4. Finding and ranking care

Clinics are filtered by distance with the haversine formula, using the patient's location $(\varphi_1, \lambda_1)$ and the clinic's $(\varphi_2, \lambda_2)$:

$$
d = 2R \arcsin\!\left(\sqrt{\sin^2\!\frac{\varphi_2-\varphi_1}{2} + \cos\varphi_1 \cos\varphi_2 \sin^2\!\frac{\lambda_2-\lambda_1}{2}}\right), \qquad R \approx 6371\ \text{km}
$$

Each clinician who has a free time gets a score from seven factors $f_i \in [0, 1]$:

$$
S = \sum_i w_i f_i, \qquad
w = \{\text{service } 0.25,\ \text{insurance } 0.25,\ \text{availability } 0.15,\ \text{cost } 0.15,\ \text{distance } 0.10,\ \text{preference } 0.05,\ \text{rating } 0.05\}
$$

For example, availability is $f_{\text{avail}} = 1 - \dfrac{t_{\text{next slot}} - t_{\text{now}}}{t_{\text{window}} - t_{\text{now}}}$ and distance is $f_{\text{dist}} = 1 - \dfrac{d}{r}$ for a search radius $r$. The patient sees what matters most, their estimated out-of-pocket cost:

$$
\text{gap} = \max\bigl(0,\ \text{fee} - \text{Medicare rebate} - \text{insurance benefit}\bigr)
$$

The quoted gap is sent with the booking. If the price changed in the meantime, the booking is refused and the new price is shown, so a patient is never charged more than they saw.

### 5. The web app

The front end is **Next.js 16** (App Router), **React 19**, TypeScript, Tailwind and shadcn/ui, with TanStack Query, react-hook-form and zod, FullCalendar v7 and Google Maps. A few design choices:

- **One data interface, two implementations.** Every screen uses a single `DataApi`: a live version (supabase-js, so RLS applies) and a **mock database** built from the seed data that emulates the security rules, database functions and triggers, with the same error messages. The whole app, including the AI features, runs offline for demos and tests.
- The browser only talks to the AI services through a same-origin proxy that forwards an allowlist of endpoints with the user's token.
- Validation mirrors the database's `check` constraints. For example, the vitals form previews BMI exactly as the database's generated column will compute it, $\text{BMI} = \dfrac{\text{weight (kg)}}{(\text{height (m)})^2}$.
- Clinic reports are computed in the browser:

$$
\text{no-show rate} = \frac{N_{\text{no-show}}}{N_{\text{due}}}, \qquad
\overline{\text{wait}} = \frac{1}{n}\sum_{k=1}^{n}\bigl(t^{(k)}_{\text{consult start}} - t^{(k)}_{\text{check-in}}\bigr), \qquad
\text{utilisation} = \frac{\text{booked slots}}{\text{offered slots}}
$$

- Tests: **Vitest** unit and component tests, and **Playwright** end-to-end tests with **axe** accessibility checks on every main page, including a real recording through Chromium's fake microphone.

## What I learned

- **Put the authorisation boundary in the database.** RLS and `security definer` functions meant that every client (the web app, the MCP servers and the agents) got the same rules for free, and an agent bug couldn't leak another patient's data.
- **Human-in-the-loop is a design, not a checkbox.** Signed pending actions, draft-then-approve facts and per-tap idempotency keys made "the AI never acts on its own" something the system enforces.
- **Typed answers beat free text.** Asking the decision engine yes/no, choice and score questions with calibrated probabilities, and comparing each to a threshold $p \ge \tau$, gave clinicians something quick and checkable to review.
- **Privacy shapes the architecture.** Audio is never stored, the reason for a visit and the patient's location stay in page memory, health data is kept out of URLs, logs and analytics, and the agent logs hold ids and timings only.
- **Accessibility tooling catches real bugs.** axe found a heading that had lost its role, a link marked by colour alone, and a calendar button whose accessible name didn't match its text.
- **Read the docs for the version you actually installed.** Next.js 16 renamed middleware to `proxy`, and FullCalendar v7 moved its plugins into one package.

## Challenges I faced

- **Recording long consultations reliably.** One file for the whole consult would be huge, and a failed upload would lose everything. Building the chunking (15 minutes, then every 5) as a small engine I could test with a fake clock, with retries that reuse the same part number, took several iterations. One bug was a race where an upload loop that finished immediately left a stale promise behind.
- **Two people, two devices, one consent.** Patient and clinician consent from separate screens, either can withdraw at any time, and withdrawing must stop recording and delete transcripts. Keeping both screens in step meant polling every 5 seconds in mock mode and Realtime subscriptions in live mode, behind one `useLiveQuery` hook.
- **Making the mock behave like the real thing.** Emulating RLS, the booking functions, triggers, check constraints and the AI services well enough that the same screens and tests run offline was a project of its own, and it paid off every time a test caught a real rule.
- **A sign-in loop after two-step verification.** After entering a correct authenticator code, clinicians were sent back to the code page. The client router had cached the pre-verification redirect, so the fix was a full page load once verification succeeds.
- **Honest prices.** Medicare rebates, private cover rules and clinic fees change. Coverage found by the web-research agent is only a draft until staff approve it, and a booking is refused if the price has changed since the patient looked.
- **Time zones.** Clinics in Brisbane and Sydney sit in different zones for half the year, so every time is shown in the clinic's zone, labelled when it differs from the patient's.

## What's next

- Run the full flow against the live Supabase project and the hosted agent services.
- Limit each staff account to its own clinics, with invites.
- Reminders and notifications before appointments.
- Split ratings into public and private comments, in line with Ahpra's advertising rules.
- Care follow-up plans that stay open for weeks after a visit.
