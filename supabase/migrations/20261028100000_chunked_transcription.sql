-- =====================================================================
-- Chunked transcription (for the transcribe-consult Edge Function)
-- Run after all earlier migrations. Runs as one transaction.
--
-- The app records the consult in chunks (about 5 minutes each) and sends
-- each chunk to the Edge Function, which transcribes it in memory and
-- stores only the TEXT here. Audio is never stored.
-- When the consult ends, the chunks are joined into one draft transcript
-- for the patient to review, and the chunk rows are deleted.
-- Chunk rows are also deleted automatically if the session ends any other
-- way (consent withdrawn, cancelled, failed, abandoned).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Temporary text per chunk (service role only; no one can read it
--    through the API)
-- ---------------------------------------------------------------------
create table public.recording_session_chunks (
  session_id        uuid not null references public.recording_sessions(id) on delete cascade,
  seq               integer not null check (seq between 1 and 500),
  transcript_text   text not null,
  segments          jsonb,        -- [{speaker, start_sec, end_sec, text}] relative to the chunk start
  duration_seconds  numeric(8,2) check (duration_seconds >= 0),
  engine            text,
  engine_model      text,
  created_at        timestamptz not null default now(),
  primary key (session_id, seq)
);

alter table public.recording_session_chunks enable row level security;
-- No policies on purpose: only the Edge Function (service role) uses it.
revoke all on public.recording_session_chunks from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Delete chunk text as soon as a session is no longer recording
-- ---------------------------------------------------------------------
create or replace function public.recording_sessions_clear_chunks()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'started' then
    delete from public.recording_session_chunks where session_id = new.id;
  end if;
  return null;
end $$;

create trigger recording_sessions_clear_chunks
  after update of status on public.recording_sessions
  for each row
  when (new.status is distinct from old.status)
  execute function public.recording_sessions_clear_chunks();

-- ---------------------------------------------------------------------
-- 3. Called with the USER's token before each chunk and before finishing.
--    Confirms the caller is the patient or clinician of the appointment,
--    the session is still recording, and both consents still stand.
--    Returns the appointment id.
-- ---------------------------------------------------------------------
create or replace function public.check_recording_chunk_allowed(
  p_session_id uuid,
  p_for_finish boolean default false
) returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  v_session public.recording_sessions;
  v_appt    public.appointments;
begin
  select * into v_session from public.recording_sessions where id = p_session_id;
  if not found then
    raise exception 'Recording session not found' using errcode = '42501';
  end if;

  select * into v_appt from public.appointments where id = v_session.appointment_id;

  if not coalesce(v_appt.patient_id = public.current_patient_id()
                  or v_appt.clinician_id = public.current_clinician_id(), false) then
    raise exception 'Not a participant of this appointment' using errcode = '42501';
  end if;

  if v_session.status <> 'started' then
    raise exception 'Recording session is no longer open (status: %)', v_session.status;
  end if;

  -- Chunks only during the consult; finishing is also allowed just after it is completed.
  if not (v_appt.status in ('checked_in', 'in_consultation')
          or (p_for_finish and v_appt.status = 'completed')) then
    raise exception 'Recording is only allowed during the consultation';
  end if;

  if not public.recording_allowed(v_appt.id) then
    raise exception 'Recording consent is missing or was withdrawn' using errcode = '42501';
  end if;

  return v_appt.id;
end $$;

-- ---------------------------------------------------------------------
-- 4. Service role: store one transcribed chunk (re-sending the same seq
--    replaces it, so the app can safely retry). Returns false, and closes
--    the session, if consent was withdrawn in the meantime.
-- ---------------------------------------------------------------------
create or replace function public.append_transcript_chunk(
  p_session_id        uuid,
  p_seq               integer,
  p_transcript_text   text,
  p_segments          jsonb default null,
  p_duration_seconds  numeric default null,
  p_engine            text default null,
  p_engine_model      text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_session public.recording_sessions;
begin
  select * into v_session from public.recording_sessions where id = p_session_id for update;
  if not found or v_session.status <> 'started' then
    raise exception 'Recording session is not open';
  end if;

  if not public.recording_allowed(v_session.appointment_id) then
    update public.recording_sessions
       set status = 'consent_withdrawn', ended_at = now(), audio_discarded_at = now()
     where id = p_session_id;           -- trigger deletes any stored chunks
    return false;
  end if;

  insert into public.recording_session_chunks
    (session_id, seq, transcript_text, segments, duration_seconds, engine, engine_model)
  values
    (p_session_id, p_seq, coalesce(p_transcript_text, ''), p_segments, p_duration_seconds, p_engine, p_engine_model)
  on conflict (session_id, seq) do update
     set transcript_text  = excluded.transcript_text,
         segments         = excluded.segments,
         duration_seconds = excluded.duration_seconds,
         engine           = excluded.engine,
         engine_model     = excluded.engine_model,
         created_at       = now();

  update public.recording_sessions
     set audio_discarded_at = now(), engine = p_engine, engine_model = p_engine_model
   where id = p_session_id;

  return true;
end $$;

-- ---------------------------------------------------------------------
-- 5. Service role: join all chunks into one draft transcript.
--    Segment times are shifted so they run from the start of the consult.
--    Speaker labels are prefixed with the chunk number (e.g. "c2:speaker_0")
--    because speaker ids are only consistent within one chunk.
--    Returns the draft transcript id, or null if nothing was stored
--    (consent withdrawn, or no chunks).
-- ---------------------------------------------------------------------
create or replace function public.finalize_transcript_from_chunks(
  p_session_id uuid,
  p_language   text default 'en-AU'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_session  public.recording_sessions;
  v_chunks   integer;
  v_text     text;
  v_segments jsonb;
  v_duration numeric;
begin
  select * into v_session from public.recording_sessions where id = p_session_id for update;
  if not found or v_session.status <> 'started' then
    raise exception 'Recording session is not open';
  end if;

  select count(*) into v_chunks from public.recording_session_chunks where session_id = p_session_id;
  if v_chunks = 0 then
    update public.recording_sessions
       set status = 'failed', error_message = 'No audio was transcribed',
           ended_at = now(), audio_discarded_at = coalesce(audio_discarded_at, now())
     where id = p_session_id;
    return null;
  end if;

  with c as (
    select seq, transcript_text, segments,
           coalesce(duration_seconds,
                    (select max((s ->> 'end_sec')::numeric)
                       from jsonb_array_elements(coalesce(segments, '[]'::jsonb)) s),
                    0) as dur
      from public.recording_session_chunks
     where session_id = p_session_id
  ),
  o as (
    select c.*, coalesce(sum(dur) over (order by seq rows between unbounded preceding and 1 preceding), 0) as offset_sec
      from c
  )
  select
    nullif(btrim(string_agg(nullif(btrim(transcript_text), ''), ' ' order by seq)), ''),
    sum(dur),
    (select coalesce(jsonb_agg(
              jsonb_build_object(
                'speaker',   'c' || o2.seq || ':' || coalesce(s.value ->> 'speaker', 'unknown'),
                'chunk',     o2.seq,
                'start_sec', round((s.value ->> 'start_sec')::numeric + o2.offset_sec, 2),
                'end_sec',   round((s.value ->> 'end_sec')::numeric + o2.offset_sec, 2),
                'text',      s.value ->> 'text')
              order by o2.seq, s.ordinality), '[]'::jsonb)
       from o o2
       cross join lateral jsonb_array_elements(coalesce(o2.segments, '[]'::jsonb)) with ordinality s)
    into v_text, v_duration, v_segments
  from o;

  if v_text is null then
    update public.recording_sessions
       set status = 'failed', error_message = 'Recording contained no speech',
           ended_at = now(), audio_discarded_at = coalesce(audio_discarded_at, now())
     where id = p_session_id;
    return null;
  end if;

  -- Re-uses the existing draft logic: checks consent again, creates the
  -- pending_patient_review transcript and moves the session to
  -- awaiting_review (which deletes the chunk rows via the trigger).
  return public.save_transcript_draft(
    p_session_id,
    v_text,
    case when jsonb_array_length(v_segments) > 0 then v_segments end,
    null,
    p_language,
    v_session.engine,
    v_session.engine_model,
    round(v_duration)::integer);
end $$;

-- ---------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------
revoke execute on function public.recording_sessions_clear_chunks() from public, anon, authenticated;

revoke execute on function
  public.check_recording_chunk_allowed(uuid, boolean),
  public.append_transcript_chunk(uuid, integer, text, jsonb, numeric, text, text),
  public.finalize_transcript_from_chunks(uuid, text)
from public, anon;

revoke execute on function
  public.append_transcript_chunk(uuid, integer, text, jsonb, numeric, text, text),
  public.finalize_transcript_from_chunks(uuid, text)
from authenticated;

grant execute on function public.check_recording_chunk_allowed(uuid, boolean) to authenticated, service_role;
grant execute on function
  public.append_transcript_chunk(uuid, integer, text, jsonb, numeric, text, text),
  public.finalize_transcript_from_chunks(uuid, text)
to service_role;

commit;
