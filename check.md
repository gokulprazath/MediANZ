# Consult notes: manual check with curl

Checks the whole flow against the **development** project: consent → recording
upload → transcript → patient approval → queued run → worker → draft facts and
key points → clinician review. Also checks that people outside the appointment
are refused.

Commands are for bash (Git Bash or WSL) and need `curl` and `jq`.

## 0. Setup (once)

1. In the SQL Editor, run `migrations/20261028000000_consult_key_points.sql`,
   then `seed/06_nebius_engines.sql` (after seeds 01–05).
2. Create the test logins from `seed/02_link_test_logins.sql`
   (`olivia.brown@example.com`, `asha.rao@example.com`, `jack.wilson@example.com`)
   and re-run that seed.
3. Deploy `supabase/functions/transcribe-consult` and set its secrets:
   `STT_API_URL`, `STT_API_KEY`, `STT_MODEL` (and `CORS_ALLOWED_ORIGIN` for the web app).
4. In `.env`: `DATABASE_URL`, `SLM_BASE_URL`, `SLM_API_KEY`, `SLM_MODEL`, `LOG_DIR=logs`.
5. Record a short audio file (`sample.wav` or `.webm`) of two people reading, for example:

   > GP: Hi Olivia, your iron levels are a bit low. Have you been feeling tired?
   > Patient: Yes, I have been so tired lately, and I get chest pain when I climb stairs.
   > GP: I'd like you to start an iron supplement once a day. We will repeat the blood test in three months.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export ANON="<anon / publishable key>"
export PW_OLIVIA="<password>"  PW_RAO="<password>"  PW_JACK="<password>"

login() {  # login <email> <password>  -> prints an access token
  curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | jq -r .access_token
}
rest() {   # rest <token> <METHOD> <path> [json body]
  curl -s -X "$2" "$SUPABASE_URL/rest/v1/$3" \
    -H "apikey: $ANON" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -H "Prefer: return=representation" \
    ${4:+-d "$4"}
}
```

## 1. Sign in

```bash
OLIVIA=$(login olivia.brown@example.com "$PW_OLIVIA")
RAO=$(login asha.rao@example.com "$PW_RAO")
JACK=$(login jack.wilson@example.com "$PW_JACK")
echo "${OLIVIA:0:20}… ${RAO:0:20}… ${JACK:0:20}…"   # three tokens, none "null"
```

## 2. Pick an upcoming appointment and start the consult

```bash
rest "$RAO" GET "appointments?select=id,status,scheduled_start,patient_id&patient_id=eq.50000000-0000-4000-8000-000000000001&status=in.(booked,confirmed)&order=scheduled_start" | jq
export APPT="<id from the list>"

# The clinician checks the patient in and starts the consultation.
rest "$RAO" PATCH "appointments?id=eq.$APPT" '{"status":"checked_in"}'      | jq '.[0].status'
rest "$RAO" PATCH "appointments?id=eq.$APPT" '{"status":"in_consultation"}' | jq '.[0].status'
```

## 3. Both parties consent (wording v2 covers AI analysis)

```bash
rest "$OLIVIA" POST rpc/give_recording_consent "{\"p_appointment_id\":\"$APPT\",\"p_consent_text_version\":\"v2\"}"
rest "$RAO"    POST rpc/give_recording_consent "{\"p_appointment_id\":\"$APPT\",\"p_consent_text_version\":\"v2\"}"
rest "$RAO" GET "recording_consents?select=party,consent_given,consent_text_version&appointment_id=eq.$APPT" | jq
```

## 4. Upload the recording (Edge Function)

```bash
curl -s "$SUPABASE_URL/functions/v1/transcribe-consult" \
  -H "Authorization: Bearer $RAO" -H "apikey: $ANON" \
  -F "appointment_id=$APPT" -F "audio=@sample.wav;type=audio/wav" -F "duration_seconds=30" | jq
# -> {"transcript_id":"…","status":"pending_patient_review"}
export TRANSCRIPT="<transcript_id>"
```

Negative checks:

```bash
# Someone else's login cannot record this consult (403).
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/functions/v1/transcribe-consult" \
  -H "Authorization: Bearer $JACK" -H "apikey: $ANON" -F "appointment_id=$APPT" -F "audio=@sample.wav"
# No login at all (401).
curl -s -o /dev/null -w "%{http_code}\n" "$SUPABASE_URL/functions/v1/transcribe-consult" -F "appointment_id=$APPT"
```

## 5. Patient reviews and approves the transcript

```bash
rest "$OLIVIA" GET "consult_transcripts?select=id,status,transcript_text,segments&id=eq.$TRANSCRIPT" | jq
rest "$OLIVIA" POST rpc/approve_transcript "{\"p_transcript_id\":\"$TRANSCRIPT\"}"

# Approval queued a run (visible to the patient and the clinician; status only).
rest "$OLIVIA" GET "consult_note_runs?select=status,attempts,facts_count,key_points_count&transcript_id=eq.$TRANSCRIPT" | jq
# -> [{"status":"queued","attempts":0,…}]
rest "$JACK" GET "consult_note_runs?appointment_id=eq.$APPT" | jq   # -> []
```

## 6. Run the worker

```bash
make consult-worker ARGS=--once
# Prints one summary per run, e.g.
# [{"run_id": "…", "status": "done", "facts": 3, "key_points": 4, "open_items": 1, …}]
```

Re-running the same consult inserts nothing new (idempotent):

```bash
make consult-worker ARGS="--appointment $APPT"   # "inserted": 0
```

Without a live consult you can process the seeded approved transcript instead:
`make consult-worker ARGS="--appointment 60000000-0000-4000-8000-000000000002"`.

## 7. Check the results

```bash
rest "$RAO" GET "consult_note_runs?select=status,attempts,last_error,facts_count,key_points_count,open_items_count&appointment_id=eq.$APPT" | jq
# -> status "done", last_error null

# SLM: draft clinical facts (value + quote hash, never the quote).
rest "$RAO" GET "clinical_facts?select=id,field_id,value,status,confidence,quote_hash,engine&appointment_id=eq.$APPT&order=field_id" | jq

# Decision engine (Jev / mock): draft key points.
rest "$RAO" GET "consult_key_points?select=id,question_id,answer,answer_label,probability,meets_threshold,status,engine&appointment_id=eq.$APPT&order=question_id" | jq

# Open items: low-confidence answers and urgent findings.
rest "$RAO" GET "open_items?select=kind,severity,description,status&appointment_id=eq.$APPT" | jq

# The patient sees no drafts yet.
rest "$OLIVIA" GET "consult_key_points?appointment_id=eq.$APPT" | jq   # -> []
rest "$OLIVIA" GET "clinical_facts?appointment_id=eq.$APPT" | jq       # -> []
```

## 8. Clinician review

```bash
KP=$(rest "$RAO" GET "consult_key_points?select=id&appointment_id=eq.$APPT&limit=1" | jq -r '.[0].id')
FACT=$(rest "$RAO" GET "clinical_facts?select=id&appointment_id=eq.$APPT&limit=1" | jq -r '.[0].id')

rest "$RAO" POST rpc/approve_key_point "{\"p_key_point_id\":\"$KP\"}"
rest "$RAO" POST rpc/approve_fact      "{\"p_fact_id\":\"$FACT\"}"
# Or change the answer while approving (must be one of the question's options):
#   rest "$RAO" POST rpc/edit_and_approve_key_point "{\"p_key_point_id\":\"…\",\"p_answer\":\"no\"}"
#   rest "$RAO" POST rpc/reject_key_point          "{\"p_key_point_id\":\"…\"}"

# Now the patient sees the approved items.
rest "$OLIVIA" GET "consult_key_points?select=question_id,answer,status&appointment_id=eq.$APPT" | jq
```

## 9. Negative checks

```bash
# The patient cannot approve key points (error "Key point not found", 42501).
rest "$OLIVIA" POST rpc/approve_key_point "{\"p_key_point_id\":\"$KP\"}" | jq

# Nobody writes key points or runs directly through the API (permission denied).
rest "$RAO" POST consult_key_points "{\"appointment_id\":\"$APPT\"}" | jq
rest "$RAO" PATCH "consult_note_runs?appointment_id=eq.$APPT" '{"status":"queued"}' | jq

# App users cannot drive the queue (permission denied for function).
rest "$RAO" POST rpc/claim_consult_note_run '{}' | jq

# Another patient sees nothing.
rest "$JACK" GET "consult_key_points?appointment_id=eq.$APPT" | jq   # -> []
rest "$JACK" GET "consult_transcripts?id=eq.$TRANSCRIPT" | jq        # -> []
```

## 10. Logs

```bash
tail -n 20 logs/consult-worker.log | jq -c '{ts, level, msg, run_id, error_code, facts, key_points}'
grep -c "iron supplement" logs/consult-worker.log   # -> 0 (no transcript text in logs)
```

Engine calls are also recorded in `decision_log` with ids and input hashes only
(SQL Editor: `select tool, engine, input_hash, output from public.decision_log order by created_at desc limit 20;`).

## Optional: consent withdrawal

```bash
rest "$OLIVIA" POST rpc/withdraw_recording_consent "{\"p_appointment_id\":\"$APPT\",\"p_reason\":\"test\"}"
rest "$RAO" GET "consult_key_points?select=id,status,source_removed_at&appointment_id=eq.$APPT" | jq
# Drafts are gone; approved key points remain with source_removed_at set. The run row is deleted.
```
