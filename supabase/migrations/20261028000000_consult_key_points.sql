-- =====================================================================
-- Consult notes: key points decided from approved transcripts, and the
-- processing queue the consult-notes worker reads.
--
--   * consult_note_runs   one row per approved transcript; queued by a
--                         trigger when the patient approves, claimed by the
--                         Python worker (service_role), visible to the
--                         appointment's patient and clinician through RLS
--                         and Realtime (status and counts only, never text).
--   * consult_key_points  draft answers to decision_questions (decision
--                         engine, Jev), one per question per transcript.
--                         Agents insert drafts; only the treating clinician
--                         or staff approve, edit or reject them.
--
-- The SLM writes draft clinical_facts (existing table) in the same run.
--
-- Run after:
--   20261027000000_agent_layer.sql
--   20261027010000_agent_layer_booking_matching.sql
--   20261027020000_service_discovery.sql
--
-- Runs as one transaction: if anything fails, nothing is saved.
-- =====================================================================
begin;

-- =====================================================================
-- 1. PROCESSING QUEUE
-- =====================================================================
create table public.consult_note_runs (
  id                uuid primary key default gen_random_uuid(),
  transcript_id     uuid not null unique references public.consult_transcripts(id) on delete cascade,
  appointment_id    uuid not null references public.appointments(id) on delete cascade,
  status            text not null default 'queued'
                      check (status in ('queued', 'running', 'done', 'failed')),
  attempts          smallint not null default 0 check (attempts >= 0),
  last_error        text check (last_error ~ '^[a-z][a-z0-9_]{1,62}$'),   -- error code only, never text
  facts_count       integer not null default 0 check (facts_count >= 0),
  key_points_count  integer not null default 0 check (key_points_count >= 0),
  open_items_count  integer not null default 0 check (open_items_count >= 0),
  queued_at         timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index consult_note_runs_claim_idx on public.consult_note_runs (status, queued_at);
create index consult_note_runs_appointment_idx on public.consult_note_runs (appointment_id);

create trigger set_updated_at before update on public.consult_note_runs
  for each row execute function public.set_updated_at();

-- Approving a transcript queues it (once).
create or replace function public.consult_transcripts_queue_notes()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    insert into public.consult_note_runs (transcript_id, appointment_id)
    values (new.id, new.appointment_id)
    on conflict (transcript_id) do nothing;
  end if;
  return null;
end $$;

create trigger consult_transcripts_queue_notes
  after insert or update of status on public.consult_transcripts
  for each row execute function public.consult_transcripts_queue_notes();

-- Queue transcripts that were approved before this migration.
insert into public.consult_note_runs (transcript_id, appointment_id)
select t.id, t.appointment_id
  from public.consult_transcripts t
 where t.status = 'approved'
on conflict (transcript_id) do nothing;

-- Worker: take the oldest runnable run. Failed runs are retried after five
-- minutes and runs left 'running' by a crashed worker after thirty, until
-- p_max_attempts is reached. p_appointment_id limits the claim to one
-- appointment (manual runs).
create or replace function public.claim_consult_note_run(
  p_max_attempts    integer default 3,
  p_appointment_id  uuid default null
) returns setof public.consult_note_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.consult_note_runs;
begin
  select * into v_run
    from public.consult_note_runs r
   where r.attempts < p_max_attempts
     and (p_appointment_id is null or r.appointment_id = p_appointment_id)
     and (r.status = 'queued'
          or (r.status = 'failed'  and r.finished_at < now() - interval '5 minutes')
          or (r.status = 'running' and r.started_at  < now() - interval '30 minutes'))
   order by r.queued_at
   limit 1
   for update skip locked;
  if not found then
    return;
  end if;

  update public.consult_note_runs r
     set status = 'running', attempts = r.attempts + 1, started_at = now(),
         finished_at = null, last_error = null
   where r.id = v_run.id
  returning r.* into v_run;
  return next v_run;
end $$;

create or replace function public.complete_consult_note_run(
  p_run_id          uuid,
  p_appointment_id  uuid,
  p_facts           integer,
  p_key_points      integer,
  p_open_items      integer
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.consult_note_runs
     set status = 'done', finished_at = now(), last_error = null,
         facts_count = p_facts, key_points_count = p_key_points, open_items_count = p_open_items
   where id = p_run_id and appointment_id = p_appointment_id and status = 'running';
  return found;
end $$;

create or replace function public.fail_consult_note_run(
  p_run_id          uuid,
  p_appointment_id  uuid,
  p_error_code      text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.consult_note_runs
     set status = 'failed', finished_at = now(),
         last_error = case when p_error_code ~ '^[a-z][a-z0-9_]{1,62}$'
                           then p_error_code else 'internal_error' end
   where id = p_run_id and appointment_id = p_appointment_id and status = 'running';
  return found;
end $$;

-- Manual re-run: queue the appointment's approved transcript again (attempts
-- reset). Safe: the worker's inserts are idempotent.
create or replace function public.requeue_consult_note_run(p_appointment_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  insert into public.consult_note_runs (transcript_id, appointment_id)
  select t.id, t.appointment_id
    from public.consult_transcripts t
   where t.appointment_id = p_appointment_id and t.status = 'approved'
  on conflict (transcript_id) do update
     set status = 'queued', attempts = 0, last_error = null, queued_at = now(),
         started_at = null, finished_at = null
   where public.consult_note_runs.status <> 'running';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- =====================================================================
-- 2. KEY POINTS (decision engine answers)
-- =====================================================================
create table public.consult_key_points (
  id                  uuid primary key default gen_random_uuid(),
  transcript_id       uuid references public.consult_transcripts(id) on delete set null,
  appointment_id      uuid not null references public.appointments(id),
  patient_id          uuid not null references public.patients(id),       -- filled from the appointment
  question_id         text not null,
  question_version    integer not null,
  kind                text not null check (kind in ('yes_no', 'choice', 'score')),
  answer              text not null check (answer ~ '^[A-Za-z0-9_.-]{1,64}$'),  -- an option value, never free text
  answer_label        text check (char_length(answer_label) <= 300),        -- from the question's options
  level               smallint,                                              -- score questions only
  probability         numeric(4,3) not null check (probability between 0 and 1),
  threshold           numeric(4,3) not null check (threshold > 0 and threshold <= 1),
  meets_threshold     boolean not null,
  status              text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  answer_edited       boolean not null default false,                       -- clinician changed the answer
  source_segment_ids  uuid[] not null default '{}',
  engine              text,
  model_version       text,
  idempotency_key     text unique check (char_length(idempotency_key) between 8 and 200),
  created_by_agent    text,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  source_removed_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (question_id, question_version) references public.decision_questions(id, version),
  check (kind = 'score' or level is null),
  check (status = 'draft' or (reviewed_by is not null and reviewed_at is not null)),
  check (source_removed_at is not null or (transcript_id is not null and cardinality(source_segment_ids) > 0))
);
create index consult_key_points_appointment_idx on public.consult_key_points (appointment_id, status);
create index consult_key_points_patient_idx     on public.consult_key_points (patient_id, question_id, status);

create trigger set_updated_at before update on public.consult_key_points
  for each row execute function public.set_updated_at();

-- patient_id always comes from the appointment; reviewed rows are final.
create or replace function public.consult_key_points_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_patient uuid;
begin
  select a.patient_id into v_patient from public.appointments a where a.id = new.appointment_id;
  if not found then
    raise exception 'Appointment not found';
  end if;

  if tg_op = 'INSERT' then
    new.patient_id := v_patient;
  else
    if new.appointment_id   is distinct from old.appointment_id
       or new.patient_id    is distinct from old.patient_id
       or new.question_id   is distinct from old.question_id
       or new.question_version is distinct from old.question_version then
      raise exception 'Key point cannot be moved to another appointment, patient or question'
        using errcode = '23514';
    end if;
    if old.status = 'rejected' and new.status is distinct from old.status then
      raise exception 'Rejected key points are final' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger consult_key_points_before_write
  before insert or update on public.consult_key_points
  for each row execute function public.consult_key_points_before_write();

-- Agents insert as service_role: only drafts / open rows, never pre-approved.
-- Same as 20261027000000 plus the consult_key_points branch.
create or replace function public.agent_insert_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Nested IFs: each table's columns are only referenced for that table.
  if current_user = 'service_role' then
    if tg_table_name = 'clinical_facts' then
      if new.status <> 'draft' or new.approved_by is not null or new.approved_at is not null
         or new.superseded_by is not null then
        raise exception 'Agents can only create draft facts' using errcode = '42501';
      end if;
    elsif tg_table_name = 'open_items' then
      if new.status <> 'open' or new.resolution is not null or new.resolved_by is not null then
        raise exception 'Agents can only create open items' using errcode = '42501';
      end if;
    elsif tg_table_name = 'gp_queries' then
      if new.status <> 'open' or new.answer is not null or new.answered_by is not null then
        raise exception 'Agents can only create open GP queries' using errcode = '42501';
      end if;
    elsif tg_table_name = 'consult_key_points' then
      if new.status <> 'draft' or new.reviewed_by is not null or new.reviewed_at is not null
         or new.answer_edited then
        raise exception 'Agents can only create draft key points' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger agent_insert_guard before insert on public.consult_key_points
  for each row execute function public.agent_insert_guard();

-- =====================================================================
-- 3. DELETION CASCADE
--    Same as 20261027000000 plus key points: drafts and rejected key points
--    go; approved ones lose their link to the transcript.
-- =====================================================================
create or replace function public.consult_transcripts_before_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'approved' then
    delete from public.clinical_facts
     where appointment_id = old.appointment_id and status in ('draft', 'rejected');
    delete from public.open_items
     where appointment_id = old.appointment_id and status = 'open';
    delete from public.gp_queries
     where appointment_id = old.appointment_id and status = 'open';
    delete from public.consult_key_points
     where appointment_id = old.appointment_id and status in ('draft', 'rejected');

    -- TODO(legal): confirm retention policy for approved facts after consent withdrawal
    update public.clinical_facts
       set source_segment_ids = '{}', quote_hash = null, char_start = null, char_end = null,
           source_removed_at = now()
     where appointment_id = old.appointment_id
       and status in ('approved', 'superseded')
       and source = 'transcript'
       and source_removed_at is null;

    update public.consult_key_points
       set source_segment_ids = '{}', source_removed_at = now()
     where appointment_id = old.appointment_id
       and status = 'approved'
       and source_removed_at is null;
  end if;
  -- transcript_segments and consult_note_runs are removed by their foreign keys.
  return old;
end $$;

-- =====================================================================
-- 4. HUMAN-ONLY REVIEW FUNCTIONS: called by the app, never by agents.
-- =====================================================================
create or replace function public._lock_key_point_for_review(p_key_point_id uuid)
returns public.consult_key_points language plpgsql security definer set search_path = '' as $$
declare
  v_k public.consult_key_points;
begin
  select * into v_k from public.consult_key_points where id = p_key_point_id for update;
  if not found or not public._can_review_appointment(v_k.appointment_id) then
    raise exception 'Key point not found' using errcode = '42501';
  end if;
  if v_k.status <> 'draft' then
    raise exception 'Only draft key points can be reviewed';
  end if;
  return v_k;
end $$;

create or replace function public.approve_key_point(p_key_point_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_k public.consult_key_points := public._lock_key_point_for_review(p_key_point_id);
begin
  update public.consult_key_points
     set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_k.id;
end $$;

-- The new answer must be one of the question's options.
create or replace function public.edit_and_approve_key_point(p_key_point_id uuid, p_answer text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_k   public.consult_key_points := public._lock_key_point_for_review(p_key_point_id);
  v_opt jsonb;
begin
  select o into v_opt
    from public.decision_questions q, jsonb_array_elements(q.options) o
   where q.id = v_k.question_id and q.version = v_k.question_version
     and o ->> 'value' = p_answer;
  if v_opt is null then
    raise exception 'Answer is not an option of this question';
  end if;
  update public.consult_key_points
     set answer = p_answer,
         answer_label = left(coalesce(v_opt ->> 'label', v_opt ->> 'description'), 300),
         level = case when v_k.kind = 'score' then (v_opt ->> 'level')::smallint end,
         answer_edited = (p_answer is distinct from v_k.answer),
         status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_k.id;
end $$;

create or replace function public.reject_key_point(p_key_point_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_k public.consult_key_points := public._lock_key_point_for_review(p_key_point_id);
begin
  update public.consult_key_points
     set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_k.id;
end $$;

-- =====================================================================
-- 5. ROW LEVEL SECURITY AND TABLE PRIVILEGES
-- =====================================================================
alter table public.consult_note_runs  enable row level security;
alter table public.consult_key_points enable row level security;
revoke all on public.consult_note_runs, public.consult_key_points from anon;

-- Runs: the appointment's patient and treating clinician (and staff) see progress.
create policy "read: patient, treating clinician or staff" on public.consult_note_runs
  for select to authenticated
  using ((select public.is_staff())
         or exists (select 1 from public.appointments a
                     where a.id = appointment_id
                       and (a.patient_id = (select public.current_patient_id())
                            or a.clinician_id = (select public.current_clinician_id()))));

-- Key points: like clinical_facts. Treating clinician and staff see everything
-- for their appointments; the patient sees approved key points only.
create policy "read: treating clinician or staff" on public.consult_key_points
  for select to authenticated
  using ((select public.is_staff())
         or exists (select 1 from public.appointments a
                     where a.id = appointment_id
                       and a.clinician_id = (select public.current_clinician_id())));
create policy "read: patient, approved only" on public.consult_key_points
  for select to authenticated
  using (status = 'approved' and patient_id = (select public.current_patient_id()));

-- Writes only through the functions above (app, worker) or as drafts (agents).
revoke insert, update, delete, truncate on public.consult_note_runs, public.consult_key_points
  from authenticated;
revoke insert, update, delete, truncate on public.consult_note_runs from service_role;
revoke update, delete, truncate on public.consult_key_points from service_role;
grant select on public.consult_note_runs to authenticated, service_role;
grant select on public.consult_key_points to authenticated;
grant select, insert on public.consult_key_points to service_role;

-- Realtime: the app watches run status (RLS applies to subscribers).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'consult_note_runs') then
    alter publication supabase_realtime add table public.consult_note_runs;
  end if;
end $$;

-- =====================================================================
-- 6. FUNCTION PERMISSIONS
-- =====================================================================
revoke all on function
  public.consult_transcripts_queue_notes(),
  public.claim_consult_note_run(integer, uuid),
  public.complete_consult_note_run(uuid, uuid, integer, integer, integer),
  public.fail_consult_note_run(uuid, uuid, text),
  public.requeue_consult_note_run(uuid),
  public.consult_key_points_before_write(),
  public.agent_insert_guard(),
  public.consult_transcripts_before_delete(),
  public._lock_key_point_for_review(uuid),
  public.approve_key_point(uuid),
  public.edit_and_approve_key_point(uuid, text),
  public.reject_key_point(uuid)
from public, anon, authenticated, service_role;

-- Human-only review functions (each checks for the treating clinician or staff).
-- Never granted to service_role.
grant execute on function
  public.approve_key_point(uuid),
  public.edit_and_approve_key_point(uuid, text),
  public.reject_key_point(uuid)
to authenticated;

-- Consult-notes worker.
grant execute on function
  public.claim_consult_note_run(integer, uuid),
  public.complete_consult_note_run(uuid, uuid, integer, integer, integer),
  public.fail_consult_note_run(uuid, uuid, text),
  public.requeue_consult_note_run(uuid)
to service_role;

commit;
