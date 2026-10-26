-- =====================================================================
-- Agent layer, part 1 of 2: consent for AI analysis, transcript segments,
-- registries, draft clinical facts, open items, GP queries, the deletion
-- cascade, human-only review functions and append-only agent logs.
--
-- Run after:
--   20261026000000_health_booking_schema.sql
--   20261026010000_security_advisor_fixes.sql
--   20261026020000_visit_vitals.sql
-- Then run 20261027010000_agent_layer_booking_matching.sql.
--
-- Runs as one transaction: if anything fails, nothing is saved.
-- =====================================================================
begin;

-- =====================================================================
-- 0. INTERNAL ROLE FOR THE MCP SERVERS' OWN BOOKKEEPING
--    The MCP servers connect as `postgres` (Session pooler) and switch to:
--      authenticated  for patient requests (RLS applies),
--      service_role   for background jobs (every query scoped to the job),
--      mcp_server     to write agent logs, read the model registry and run
--                     the personal-information name check.
--    mcp_server owns nothing and can only use the grants below, so writing
--    logs never needs service_role during a patient request.
-- =====================================================================
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_server') then
    create role mcp_server nologin;
  end if;
end $$;

grant mcp_server to postgres;
grant usage on schema public to mcp_server;

-- =====================================================================
-- 1. CONSENT WORDING VERSIONS (4.1)
-- =====================================================================
create table public.consent_text_versions (
  version             text primary key check (version ~ '^[A-Za-z0-9._-]{1,32}$'),
  covers_ai_analysis  boolean not null default false,
  published_at        timestamptz not null default now()
);

insert into public.consent_text_versions (version, covers_ai_analysis, published_at) values
  ('v1', false, '2026-01-01'),
  ('v2', true,  '2026-10-27')
on conflict (version) do nothing;

-- New consents must name a known wording. NOT VALID: existing rows are not
-- re-checked, every new or changed row is.
alter table public.recording_consents
  add constraint recording_consents_consent_text_version_fkey
  foreign key (consent_text_version) references public.consent_text_versions(version) not valid;

-- =====================================================================
-- 2. TRANSCRIPT SEGMENTS (4.2)
--    Built automatically when a transcript is approved. Deleted with the
--    transcript (FK cascade). char_start/char_end are 0-based offsets into
--    consult_transcripts.transcript_text: transcript_text[char_start:char_end].
-- =====================================================================
create table public.transcript_segments (
  id                  uuid primary key default gen_random_uuid(),
  transcript_id       uuid not null references public.consult_transcripts(id) on delete cascade,
  appointment_id      uuid not null references public.appointments(id) on delete cascade,
  seq                 integer not null check (seq >= 1),
  speaker             text check (char_length(speaker) <= 64),
  speaker_confidence  numeric(4,3) check (speaker_confidence between 0 and 1),
  start_sec           numeric(10,3) check (start_sec >= 0),
  end_sec             numeric(10,3) check (end_sec >= 0),
  text                text not null,
  char_start          integer check (char_start >= 0),
  char_end            integer,
  created_at          timestamptz not null default now(),
  unique (transcript_id, seq),
  check ((char_start is null) = (char_end is null)),
  check (char_end is null or char_end >= char_start),
  check (end_sec is null or start_sec is null or end_sec >= start_sec)
);
create index transcript_segments_appointment_idx on public.transcript_segments (appointment_id, seq);

-- Build segments for one approved transcript. Safe to call again: does
-- nothing if the transcript already has segments or is not approved.
create or replace function public.build_transcript_segments(p_transcript_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_t        public.consult_transcripts;
  v_seg      record;
  v_text     text;
  v_cursor   integer := 0;     -- 0-based search position in transcript_text
  v_pos      integer;
  v_seq      integer := 0;
  v_rest     text;
  v_offset   integer;
  v_ws       text;
  v_sentence text;
  v_label    text;
  v_speaker  text;
begin
  select * into v_t from public.consult_transcripts where id = p_transcript_id;
  if not found or v_t.status <> 'approved' then
    return 0;
  end if;
  if exists (select 1 from public.transcript_segments where transcript_id = p_transcript_id) then
    return 0;
  end if;

  if v_t.segments is not null and jsonb_typeof(v_t.segments) = 'array'
     and jsonb_array_length(v_t.segments) > 0 then
    -- From the structured segments. Offsets are found by searching forward
    -- from the end of the previous segment; null if the text is not found.
    for v_seg in
      select e.value as seg
        from jsonb_array_elements(v_t.segments) with ordinality as e(value, ord)
       order by e.ord
    loop
      v_text := v_seg.seg ->> 'text';
      continue when v_text is null or btrim(v_text) = '';
      v_seq := v_seq + 1;
      v_pos := strpos(substr(v_t.transcript_text, v_cursor + 1), v_text);
      if v_pos > 0 then
        v_pos := v_cursor + v_pos - 1;
        v_cursor := v_pos + char_length(v_text);
      else
        v_pos := null;
      end if;

      insert into public.transcript_segments
        (transcript_id, appointment_id, seq, speaker, speaker_confidence,
         start_sec, end_sec, text, char_start, char_end)
      values
        (v_t.id, v_t.appointment_id, v_seq,
         left(v_seg.seg ->> 'speaker', 64),
         case when jsonb_typeof(v_seg.seg -> 'speaker_confidence') = 'number'
              then least(greatest((v_seg.seg ->> 'speaker_confidence')::numeric, 0), 1) end,
         case when jsonb_typeof(v_seg.seg -> 'start_sec') = 'number'
              then (v_seg.seg ->> 'start_sec')::numeric end,
         case when jsonb_typeof(v_seg.seg -> 'end_sec') = 'number'
              then (v_seg.seg ->> 'end_sec')::numeric end,
         v_text, v_pos, v_pos + char_length(v_text));
    end loop;
  else
    -- No structured segments: split transcript_text into sentences.
    -- A leading "Name: " label becomes the speaker and is carried forward.
    v_rest := v_t.transcript_text;
    v_offset := 0;
    loop
      v_ws := substring(v_rest from '^\s*');
      v_offset := v_offset + char_length(v_ws);
      v_rest := substr(v_rest, char_length(v_ws) + 1);
      exit when v_rest = '';

      v_label := substring(v_rest from '^([^:.!?\n]{1,40}):\s');
      if v_label is not null then
        v_speaker := btrim(v_label);
        v_ws := substring(v_rest from '^[^:]*:\s*');
        v_offset := v_offset + char_length(v_ws);
        v_rest := substr(v_rest, char_length(v_ws) + 1);
        exit when v_rest = '';
      end if;

      v_sentence := substring(v_rest from '^.*?[.!?]+(?=\s|$)');
      if v_sentence is null or v_sentence = '' then
        v_sentence := v_rest;
      end if;

      v_seq := v_seq + 1;
      insert into public.transcript_segments
        (transcript_id, appointment_id, seq, speaker, text, char_start, char_end)
      values
        (v_t.id, v_t.appointment_id, v_seq, left(v_speaker, 64), v_sentence,
         v_offset, v_offset + char_length(v_sentence));

      v_offset := v_offset + char_length(v_sentence);
      v_rest := substr(v_rest, char_length(v_sentence) + 1);
    end loop;
  end if;

  return v_seq;
end $$;

create or replace function public.consult_transcripts_after_approve()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    perform public.build_transcript_segments(new.id);
  end if;
  return null;
end $$;

create trigger consult_transcripts_after_approve
  after insert or update of status on public.consult_transcripts
  for each row execute function public.consult_transcripts_after_approve();

-- Backfill transcripts that were approved before this migration.
select public.build_transcript_segments(id)
  from public.consult_transcripts
 where status = 'approved';

-- =====================================================================
-- 3. REGISTRIES (4.3)
-- =====================================================================
-- Shape rules for decision question options (used by a CHECK constraint):
--   yes_no: exactly yes / no / not_stated
--   choice: at least two distinct values, always including 'unclear'
--   score:  at least two distinct integer levels, each described in words
create or replace function public.decision_question_options_ok(p_kind text, p_options jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_options) is distinct from 'array' then false
    when exists (select 1 from jsonb_array_elements(p_options) o
                  where jsonb_typeof(o) <> 'object'
                     or coalesce(btrim(o ->> 'value'), '') = '') then false
    when (select count(distinct o ->> 'value') from jsonb_array_elements(p_options) o)
         <> jsonb_array_length(p_options) then false
    when p_kind = 'yes_no' then
      (select array_agg(o ->> 'value' order by o ->> 'value') from jsonb_array_elements(p_options) o)
        = array['no', 'not_stated', 'yes']
    when p_kind = 'choice' then
      jsonb_array_length(p_options) >= 2
      and exists (select 1 from jsonb_array_elements(p_options) o where o ->> 'value' = 'unclear')
    when p_kind = 'score' then
      jsonb_array_length(p_options) >= 2
      and not exists (select 1 from jsonb_array_elements(p_options) o
                       where jsonb_typeof(o -> 'level') is distinct from 'number'
                          or coalesce(btrim(o ->> 'description'), '') = '')
      and (select count(distinct o -> 'level') from jsonb_array_elements(p_options) o)
          = jsonb_array_length(p_options)
    else false
  end
$$;

create table public.decision_questions (
  id                       text not null check (id ~ '^[a-z][a-z0-9_]{1,62}$'),
  version                  integer not null check (version >= 1),
  kind                     text not null check (kind in ('yes_no', 'choice', 'score')),
  text                     text not null check (char_length(text) between 1 and 1000),
  options                  jsonb not null,
  threshold                numeric(4,3) not null check (threshold > 0 and threshold <= 1),
  threshold_model_version  text,          -- thresholds are calibrated for one model version
  active                   boolean not null default true,
  created_at               timestamptz not null default now(),
  primary key (id, version),
  check (public.decision_question_options_ok(kind, options))
);
create unique index decision_questions_one_active_version on public.decision_questions (id) where active;

create table public.clinical_fields (
  id            text not null check (id ~ '^[a-z][a-z0-9_]{1,62}$'),
  version       integer not null check (version >= 1),
  label         text not null,
  value_schema  jsonb not null check (jsonb_typeof(value_schema) = 'object'),
  unit          text,
  code_system   text,
  topic         text not null check (topic ~ '^[a-z][a-z0-9_]{1,62}$'),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  primary key (id, version)
);
create unique index clinical_fields_one_active_version on public.clinical_fields (id) where active;

-- One row per engine. `capability` says which interface it implements;
-- at most one engine per capability can be enabled, so the servers never
-- have to choose (and never fall back).
create table public.model_registry (
  engine               text primary key check (engine ~ '^[a-z][a-z0-9_]{1,62}$'),
  capability           text not null check (capability in ('decision', 'extraction', 'search', 'places')),
  provider             text not null,
  model                text not null,
  model_version        text not null,
  region               text,
  zero_data_retention  boolean not null default false,
  allow_health_data    boolean not null default false,
  enabled              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index model_registry_one_enabled_per_capability
  on public.model_registry (capability) where enabled;

create trigger set_updated_at before update on public.model_registry
  for each row execute function public.set_updated_at();

-- Every engine starts disabled. Real engines never get health data until
-- their privacy terms and hosting region are confirmed. The sample seed
-- (04_agent_layer_sample.sql) enables the mock engines.
insert into public.model_registry
  (engine, capability, provider, model, model_version, region, zero_data_retention, allow_health_data, enabled)
values
  ('jev',             'decision',   'TypeSafe AI',   'system-one',        'unknown', null, false, false, false),
  ('llm_adapter',     'decision',   'TypeSafe AI',   'system-one-llm',    'unknown', null, false, false, false),
  ('slm',             'extraction', 'openai-compat', 'unknown',           'unknown', null, false, false, false),
  ('tavily',          'search',     'Tavily',        'search-api',        'v1',      null, false, false, false),
  ('google_places',   'places',     'Google',        'places-api-new',    'v1',      null, false, false, false),
  ('mock_decision',   'decision',   'healthmcp',     'mock-keywords',     '1',       'local', true, true, false),
  ('mock_extraction', 'extraction', 'healthmcp',     'mock-regex',        '1',       'local', true, true, false),
  ('mock_search',     'search',     'healthmcp',     'mock-fixtures',     '1',       'local', true, true, false),
  ('mock_places',     'places',     'healthmcp',     'mock-fixtures',     '1',       'local', true, true, false)
on conflict (engine) do nothing;

-- =====================================================================
-- 4. DRAFT CLINICAL FACTS, OPEN ITEMS, GP QUERIES, NOTIFICATIONS (4.4)
--    Agents (service_role) can only INSERT drafts / open rows. Approval,
--    resolution and answers happen only through the human-only functions
--    in section 6.
-- =====================================================================
create table public.clinical_facts (
  id                  uuid primary key default gen_random_uuid(),
  appointment_id      uuid not null references public.appointments(id),
  patient_id          uuid not null references public.patients(id),       -- filled from the appointment
  field_id            text not null,
  field_version       integer not null,
  value               jsonb not null,
  unit                text,
  code_system         text,
  code                text,
  status              text not null default 'draft'
                        check (status in ('draft', 'approved', 'rejected', 'superseded')),
  negated             boolean not null default false,
  experiencer         text not null default 'patient' check (experiencer in ('patient', 'family', 'other')),
  temporality         text not null default 'current' check (temporality in ('current', 'past', 'future', 'unknown')),
  source              text not null check (source in ('transcript', 'clinician_entered')),
  source_segment_ids  uuid[] not null default '{}',
  quote_hash          text check (quote_hash ~ '^[0-9a-f]{64}$'),          -- sha256 of the quote; never the quote
  char_start          integer check (char_start >= 0),
  char_end            integer,
  confidence          numeric(4,3) check (confidence between 0 and 1),
  engine              text,
  model_version       text,
  value_edited        boolean not null default false,                     -- clinician changed the value on approval
  idempotency_key     text unique check (char_length(idempotency_key) between 8 and 200),
  created_by_agent    text,
  approved_by         uuid,
  approved_at         timestamptz,
  superseded_by       uuid references public.clinical_facts(id),
  valid_from          date not null default current_date,
  valid_to            date,
  source_removed_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (field_id, field_version) references public.clinical_fields(id, version),
  check ((char_start is null) = (char_end is null)),
  check (char_end is null or char_end >= char_start),
  check (valid_to is null or valid_to >= valid_from),
  check (status not in ('approved', 'superseded') or (approved_by is not null and approved_at is not null)),
  check (status <> 'superseded' or superseded_by is not null),
  check (source <> 'transcript' or source_removed_at is not null or cardinality(source_segment_ids) > 0)
);
create index clinical_facts_appointment_idx on public.clinical_facts (appointment_id, status);
create index clinical_facts_patient_idx     on public.clinical_facts (patient_id, field_id, status);

create table public.open_items (
  id                uuid primary key default gen_random_uuid(),
  appointment_id    uuid not null references public.appointments(id),
  kind              text not null check (kind in ('missing_info', 'conflict', 'urgent')),
  severity          smallint check (severity between 0 and 10),
  description       text not null check (char_length(description) between 1 and 2000),
  related_fact_ids  uuid[] not null default '{}',
  status            text not null default 'open' check (status in ('open', 'resolved')),
  resolution        text check (char_length(resolution) <= 2000),
  resolved_by       uuid,
  resolved_at       timestamptz,
  idempotency_key   text unique check (char_length(idempotency_key) between 8 and 200),
  created_by_agent  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (kind <> 'urgent' or severity is not null),
  check (status <> 'resolved' or (resolved_by is not null and resolved_at is not null))
);
create index open_items_appointment_idx on public.open_items (appointment_id, status);

create table public.gp_queries (
  id                uuid primary key default gen_random_uuid(),
  appointment_id    uuid not null references public.appointments(id),
  question          text not null check (char_length(question) between 1 and 2000),
  context_fact_ids  uuid[] not null default '{}',
  status            text not null default 'open' check (status in ('open', 'answered')),
  answer            text check (char_length(answer) <= 4000),
  answered_by       uuid,
  answered_at       timestamptz,
  idempotency_key   text unique check (char_length(idempotency_key) between 8 and 200),
  created_by_agent  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (status <> 'answered' or (answer is not null and answered_by is not null and answered_at is not null))
);
create index gp_queries_appointment_idx on public.gp_queries (appointment_id, status);

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facilities(id),
  appointment_id  uuid references public.appointments(id),
  kind            text not null check (kind ~ '^[a-z][a-z0-9_]{1,62}$'),
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);
create index notifications_facility_idx on public.notifications (facility_id, created_at desc) where read_at is null;

do $$
declare t text;
begin
  foreach t in array array['clinical_facts', 'open_items', 'gp_queries'] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Facts: patient_id always comes from the appointment; agents may only add drafts.
create or replace function public.clinical_facts_before_write()
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
    if new.appointment_id is distinct from old.appointment_id
       or new.patient_id   is distinct from old.patient_id
       or new.field_id     is distinct from old.field_id then
      raise exception 'Fact cannot be moved to another appointment, patient or field' using errcode = '23514';
    end if;
    if old.status in ('rejected', 'superseded') and new.status is distinct from old.status then
      raise exception 'Rejected and superseded facts are final' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger clinical_facts_before_write
  before insert or update on public.clinical_facts
  for each row execute function public.clinical_facts_before_write();

-- Agents insert as service_role: only drafts / open rows, never pre-approved.
-- (security invoker, so current_user is the inserting role.)
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
    end if;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['clinical_facts', 'open_items', 'gp_queries'] loop
    execute format(
      'create trigger agent_insert_guard before insert on public.%I
         for each row execute function public.agent_insert_guard()', t);
  end loop;
end $$;

-- Urgent open items notify the facility (ids only, no text).
create or replace function public.open_items_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'urgent' then
    insert into public.notifications (facility_id, appointment_id, kind)
    select a.facility_id, a.id, 'urgent_open_item'
      from public.appointments a where a.id = new.appointment_id;
  end if;
  return null;
end $$;

create trigger open_items_after_insert
  after insert on public.open_items
  for each row execute function public.open_items_after_insert();

-- =====================================================================
-- 5. DELETION CASCADE (4.5)
--    When an approved transcript is deleted (consent withdrawal, or any
--    other deletion) everything the agents derived from it goes too.
--    Drafts are only ever made from approved transcripts, so deleting a
--    transcript that was never approved (rejection, expiry) leaves the
--    appointment's agent output alone.
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

    -- TODO(legal): confirm retention policy for approved facts after consent withdrawal
    update public.clinical_facts
       set source_segment_ids = '{}', quote_hash = null, char_start = null, char_end = null,
           source_removed_at = now()
     where appointment_id = old.appointment_id
       and status in ('approved', 'superseded')
       and source = 'transcript'
       and source_removed_at is null;
  end if;
  -- transcript_segments are removed by their foreign key (on delete cascade).
  return old;
end $$;

create trigger consult_transcripts_before_delete
  before delete on public.consult_transcripts
  for each row execute function public.consult_transcripts_before_delete();

-- =====================================================================
-- 6. HUMAN-ONLY FUNCTIONS (4.6): called by the app, never by agents.
-- =====================================================================
-- True for staff, or for the clinician treating this appointment.
create or replace function public._can_review_appointment(p_appointment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.is_staff(), false)
      or exists (select 1 from public.appointments a
                  where a.id = p_appointment_id
                    and a.clinician_id = public.current_clinician_id())
$$;

create or replace function public._lock_fact_for_review(p_fact_id uuid)
returns public.clinical_facts language plpgsql security definer set search_path = '' as $$
declare
  v_f public.clinical_facts;
begin
  select * into v_f from public.clinical_facts where id = p_fact_id for update;
  if not found or not public._can_review_appointment(v_f.appointment_id) then
    raise exception 'Fact not found' using errcode = '42501';
  end if;
  return v_f;
end $$;

create or replace function public.approve_fact(p_fact_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_f public.clinical_facts := public._lock_fact_for_review(p_fact_id);
begin
  if v_f.status <> 'draft' then
    raise exception 'Only draft facts can be approved';
  end if;
  update public.clinical_facts
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_fact_id;
end $$;

create or replace function public.edit_and_approve_fact(p_fact_id uuid, p_value jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_f public.clinical_facts := public._lock_fact_for_review(p_fact_id);
begin
  if v_f.status <> 'draft' then
    raise exception 'Only draft facts can be approved';
  end if;
  if p_value is null then
    raise exception 'A value is required';
  end if;
  update public.clinical_facts
     set value = p_value, value_edited = (p_value is distinct from v_f.value),
         status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_fact_id;
end $$;

create or replace function public.reject_fact(p_fact_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_f public.clinical_facts := public._lock_fact_for_review(p_fact_id);
begin
  if v_f.status <> 'draft' then
    raise exception 'Only draft facts can be rejected';
  end if;
  update public.clinical_facts set status = 'rejected' where id = p_fact_id;
end $$;

-- Replaces an approved fact with a clinician-entered value from today.
create or replace function public.supersede_fact(p_old_id uuid, p_new_value jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_f      public.clinical_facts := public._lock_fact_for_review(p_old_id);
  v_new_id uuid;
begin
  if v_f.status <> 'approved' then
    raise exception 'Only approved facts can be superseded';
  end if;
  if p_new_value is null then
    raise exception 'A value is required';
  end if;

  insert into public.clinical_facts
    (appointment_id, patient_id, field_id, field_version, value, unit, code_system, code,
     status, negated, experiencer, temporality, source, approved_by, approved_at, valid_from)
  values
    (v_f.appointment_id, v_f.patient_id, v_f.field_id, v_f.field_version, p_new_value,
     v_f.unit, v_f.code_system, v_f.code, 'approved', v_f.negated, v_f.experiencer,
     v_f.temporality, 'clinician_entered', auth.uid(), now(), current_date)
  returning id into v_new_id;

  update public.clinical_facts
     set status = 'superseded', superseded_by = v_new_id,
         valid_to = greatest(current_date, valid_from)
   where id = p_old_id;

  return v_new_id;
end $$;

create or replace function public.resolve_open_item(p_open_item_id uuid, p_resolution text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_o public.open_items;
begin
  select * into v_o from public.open_items where id = p_open_item_id for update;
  if not found or not public._can_review_appointment(v_o.appointment_id) then
    raise exception 'Open item not found' using errcode = '42501';
  end if;
  if v_o.status <> 'open' then
    raise exception 'Open item is already resolved';
  end if;
  update public.open_items
     set status = 'resolved', resolution = p_resolution, resolved_by = auth.uid(), resolved_at = now()
   where id = p_open_item_id;
end $$;

create or replace function public.answer_gp_query(p_gp_query_id uuid, p_answer text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_q public.gp_queries;
begin
  select * into v_q from public.gp_queries where id = p_gp_query_id for update;
  if not found or not public._can_review_appointment(v_q.appointment_id) then
    raise exception 'GP query not found' using errcode = '42501';
  end if;
  if v_q.status <> 'open' then
    raise exception 'GP query is already answered';
  end if;
  if coalesce(btrim(p_answer), '') = '' then
    raise exception 'An answer is required';
  end if;
  update public.gp_queries
     set status = 'answered', answer = p_answer, answered_by = auth.uid(), answered_at = now()
   where id = p_gp_query_id;
end $$;

-- verify_plan_version(id) is in 20261027010000 (it needs insurance_plan_versions).

-- =====================================================================
-- 7. PROCESSING ELIGIBILITY (4.1)
--    Both parties consented with a wording that covers AI analysis, neither
--    withdrew, and an approved transcript exists. Used by the transcript
--    MCP server (service_role); not callable by app users.
-- =====================================================================
create or replace function public.get_processing_eligibility(p_appointment_id uuid)
returns table (eligible boolean, reasons text[])
language plpgsql stable set search_path = '' as $$
declare
  v_reasons text[] := '{}';
  v_party   public.consent_party;
  v_c       record;
begin
  if not exists (select 1 from public.appointments where id = p_appointment_id) then
    return query select false, array['appointment_not_found'];
    return;
  end if;

  foreach v_party in array array['patient', 'clinician']::public.consent_party[] loop
    select rc.consent_given, rc.withdrawn_at, ctv.covers_ai_analysis
      into v_c
      from public.recording_consents rc
      left join public.consent_text_versions ctv on ctv.version = rc.consent_text_version
     where rc.appointment_id = p_appointment_id and rc.party = v_party;
    if not found or not v_c.consent_given then
      v_reasons := v_reasons || (v_party::text || '_consent_missing');
    elsif v_c.withdrawn_at is not null then
      v_reasons := v_reasons || (v_party::text || '_consent_withdrawn');
    elsif not coalesce(v_c.covers_ai_analysis, false) then
      v_reasons := v_reasons || (v_party::text || '_consent_version_excludes_ai');
    end if;
  end loop;

  if not exists (select 1 from public.consult_transcripts
                  where appointment_id = p_appointment_id and status = 'approved') then
    v_reasons := v_reasons || 'no_approved_transcript'::text;
  end if;

  return query select cardinality(v_reasons) = 0, v_reasons;
end $$;

-- =====================================================================
-- 8. APPEND-ONLY AGENT LOGS (spec 3.3)
--    Ids and hashes only: never transcript text, quotes or review text.
--    No role (not even service_role) can update or delete; rows are added
--    only through the security definer functions below, which only
--    mcp_server may call. Triggers block UPDATE/DELETE/TRUNCATE for
--    everyone, including the table owner.
-- =====================================================================
create table public.agent_access_log (
  id              bigint generated always as identity primary key,
  agent_id        text not null check (char_length(agent_id) <= 64),
  mode            text not null check (mode in ('user', 'job')),
  user_id         uuid,
  job_id          text check (char_length(job_id) <= 128),
  patient_id      uuid,
  appointment_id  uuid,
  server          text not null check (char_length(server) <= 64),
  tool            text not null check (char_length(tool) <= 64),
  ok              boolean not null,
  error_code      text check (char_length(error_code) <= 64),
  latency_ms      integer not null check (latency_ms >= 0),
  created_at      timestamptz not null default now()
);
create index agent_access_log_created_idx on public.agent_access_log (created_at desc);
create index agent_access_log_appointment_idx on public.agent_access_log (appointment_id) where appointment_id is not null;

create table public.decision_log (
  id                          bigint generated always as identity primary key,
  agent_id                    text not null check (char_length(agent_id) <= 64),
  job_id                      text check (char_length(job_id) <= 128),
  appointment_id              uuid,
  server                      text not null check (char_length(server) <= 64),
  tool                        text not null check (char_length(tool) <= 64),
  engine                      text not null check (char_length(engine) <= 64),
  model                       text,
  model_version               text,
  prompt_or_question_version  text,
  input_refs                  jsonb not null default '{}'::jsonb,
  input_hash                  text check (input_hash ~ '^[0-9a-f]{64}$'),
  output                      jsonb not null default '{}'::jsonb,
  probability                 numeric(5,4) check (probability between 0 and 1),
  latency_ms                  integer check (latency_ms >= 0),
  created_at                  timestamptz not null default now()
);
create index decision_log_appointment_idx on public.decision_log (appointment_id, created_at);

create table public.agent_notes (
  id              bigint generated always as identity primary key,
  agent_id        text not null check (char_length(agent_id) <= 64),
  mode            text not null check (mode in ('user', 'job')),
  user_id         uuid,
  job_id          text check (char_length(job_id) <= 128),
  appointment_id  uuid,
  server          text not null check (char_length(server) <= 64),
  note            text not null check (char_length(note) between 1 and 1000),
  created_at      timestamptz not null default now()
);

create or replace function public.append_only_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

do $$
declare t text;
begin
  foreach t in array array['agent_access_log', 'decision_log', 'agent_notes'] loop
    execute format(
      'create trigger append_only_row before update or delete on public.%I
         for each row execute function public.append_only_guard()', t);
    execute format(
      'create trigger append_only_truncate before truncate on public.%I
         for each statement execute function public.append_only_guard()', t);
  end loop;
end $$;

create or replace function public.log_agent_access(
  p_agent_id       text,
  p_mode           text,
  p_user_id        uuid,
  p_job_id         text,
  p_patient_id     uuid,
  p_appointment_id uuid,
  p_server         text,
  p_tool           text,
  p_ok             boolean,
  p_error_code     text,
  p_latency_ms     integer
) returns bigint language sql security definer set search_path = '' as $$
  insert into public.agent_access_log
    (agent_id, mode, user_id, job_id, patient_id, appointment_id, server, tool, ok, error_code, latency_ms)
  values
    (p_agent_id, p_mode, p_user_id, p_job_id, p_patient_id, p_appointment_id, p_server, p_tool,
     p_ok, p_error_code, greatest(coalesce(p_latency_ms, 0), 0))
  returning id
$$;

create or replace function public.log_decision(
  p_agent_id                   text,
  p_job_id                     text,
  p_appointment_id             uuid,
  p_server                     text,
  p_tool                       text,
  p_engine                     text,
  p_model                      text,
  p_model_version              text,
  p_prompt_or_question_version text,
  p_input_refs                 jsonb,
  p_input_hash                 text,
  p_output                     jsonb,
  p_probability                numeric,
  p_latency_ms                 integer
) returns bigint language sql security definer set search_path = '' as $$
  insert into public.decision_log
    (agent_id, job_id, appointment_id, server, tool, engine, model, model_version,
     prompt_or_question_version, input_refs, input_hash, output, probability, latency_ms)
  values
    (p_agent_id, p_job_id, p_appointment_id, p_server, p_tool, p_engine, p_model, p_model_version,
     p_prompt_or_question_version, coalesce(p_input_refs, '{}'::jsonb), p_input_hash,
     coalesce(p_output, '{}'::jsonb), p_probability, p_latency_ms)
  returning id
$$;

create or replace function public.log_agent_note(
  p_agent_id       text,
  p_mode           text,
  p_user_id        uuid,
  p_job_id         text,
  p_appointment_id uuid,
  p_server         text,
  p_note           text
) returns bigint language sql security definer set search_path = '' as $$
  insert into public.agent_notes (agent_id, mode, user_id, job_id, appointment_id, server, note)
  values (p_agent_id, p_mode, p_user_id, p_job_id, p_appointment_id, p_server, p_note)
  returning id
$$;

-- Personal-information guard for web searches: does the text contain a
-- sample/real patient's full name? Returns only a boolean; names never
-- leave the database.
create or replace function public.text_mentions_patient_name(p_text text)
returns boolean language sql stable security definer set search_path = '' as $$
  with t as (
    select ' ' || btrim(regexp_replace(lower(coalesce(p_text, '')), '[^[:alnum:]]+', ' ', 'g')) || ' ' as norm
  ),
  n as (
    select btrim(regexp_replace(lower(first_name), '[^[:alnum:]]+', ' ', 'g')) as first_n,
           btrim(regexp_replace(lower(coalesce(preferred_name, first_name)), '[^[:alnum:]]+', ' ', 'g')) as pref_n,
           btrim(regexp_replace(lower(last_name), '[^[:alnum:]]+', ' ', 'g')) as last_n
      from public.patients
  )
  select exists (
    select 1 from n, t
     where n.last_n <> ''
       and (position(' ' || n.first_n || ' ' || n.last_n || ' ' in t.norm) > 0
         or position(' ' || n.pref_n  || ' ' || n.last_n || ' ' in t.norm) > 0
         or position(' ' || n.last_n  || ' ' || n.first_n || ' ' in t.norm) > 0)
  )
$$;

-- =====================================================================
-- 9. ROW LEVEL SECURITY AND TABLE PRIVILEGES
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'consent_text_versions', 'transcript_segments', 'decision_questions', 'clinical_fields',
    'model_registry', 'clinical_facts', 'open_items', 'gp_queries', 'notifications',
    'agent_access_log', 'decision_log', 'agent_notes'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Reference data: signed-in users read; staff manage.
do $$
declare t text;
begin
  foreach t in array array['consent_text_versions', 'decision_questions', 'clinical_fields'] loop
    execute format('create policy "read: signed-in users" on public.%I
                      for select to authenticated using (true)', t);
    execute format('create policy "write: staff" on public.%I
                      for all to authenticated
                      using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

-- Model registry: staff manage it; the MCP servers read it as mcp_server.
create policy "read: staff" on public.model_registry
  for select to authenticated using ((select public.is_staff()));
create policy "write: staff" on public.model_registry
  for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "read: mcp servers" on public.model_registry
  for select to mcp_server using (true);
grant select on public.model_registry to mcp_server;

-- Segments: the appointment's patient and treating clinician read; nobody writes directly.
create policy "read: patient or treating clinician" on public.transcript_segments
  for select to authenticated
  using (exists (select 1 from public.appointments a
                  where a.id = appointment_id
                    and (a.patient_id = (select public.current_patient_id())
                         or a.clinician_id = (select public.current_clinician_id()))));
revoke insert, update, delete, truncate on public.transcript_segments from authenticated, service_role;

-- Facts: treating clinician and staff see everything for their appointments;
-- the patient sees approved (and superseded, for history) facts only.
create policy "read: treating clinician or staff" on public.clinical_facts
  for select to authenticated
  using ((select public.is_staff())
         or exists (select 1 from public.appointments a
                     where a.id = appointment_id
                       and a.clinician_id = (select public.current_clinician_id())));
create policy "read: patient, approved only" on public.clinical_facts
  for select to authenticated
  using (status in ('approved', 'superseded')
         and patient_id = (select public.current_patient_id()));

do $$
declare t text;
begin
  foreach t in array array['open_items', 'gp_queries'] loop
    execute format('create policy "read: treating clinician or staff" on public.%I
       for select to authenticated
       using ((select public.is_staff())
              or exists (select 1 from public.appointments a
                          where a.id = appointment_id
                            and a.clinician_id = (select public.current_clinician_id())))', t);
  end loop;
end $$;

-- Writes only through the functions above (app) or as drafts (agents).
revoke insert, update, delete, truncate on public.clinical_facts, public.open_items, public.gp_queries
  from authenticated;
revoke update, delete, truncate on public.clinical_facts, public.open_items, public.gp_queries
  from service_role;

-- Notifications: staff and the appointment's clinician read and mark as read.
create policy "read: staff or appointment clinician" on public.notifications
  for select to authenticated
  using ((select public.is_staff())
         or exists (select 1 from public.appointments a
                     where a.id = appointment_id
                       and a.clinician_id = (select public.current_clinician_id())));
create policy "update: staff or appointment clinician" on public.notifications
  for update to authenticated
  using ((select public.is_staff())
         or exists (select 1 from public.appointments a
                     where a.id = appointment_id
                       and a.clinician_id = (select public.current_clinician_id())))
  with check ((select public.is_staff())
         or exists (select 1 from public.appointments a
                     where a.id = appointment_id
                       and a.clinician_id = (select public.current_clinician_id())));
revoke insert, delete, truncate on public.notifications from authenticated, service_role;
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Logs: no API role reads or writes them directly.
revoke all on public.agent_access_log, public.decision_log, public.agent_notes
  from authenticated, service_role, mcp_server;

-- =====================================================================
-- 10. FUNCTION PERMISSIONS
-- =====================================================================
revoke all on function
  public.build_transcript_segments(uuid),
  public.consult_transcripts_after_approve(),
  public.decision_question_options_ok(text, jsonb),
  public.clinical_facts_before_write(),
  public.agent_insert_guard(),
  public.open_items_after_insert(),
  public.consult_transcripts_before_delete(),
  public._can_review_appointment(uuid),
  public._lock_fact_for_review(uuid),
  public.approve_fact(uuid),
  public.edit_and_approve_fact(uuid, jsonb),
  public.reject_fact(uuid),
  public.supersede_fact(uuid, jsonb),
  public.resolve_open_item(uuid, text),
  public.answer_gp_query(uuid, text),
  public.get_processing_eligibility(uuid),
  public.append_only_guard(),
  public.log_agent_access(text, text, uuid, text, uuid, uuid, text, text, boolean, text, integer),
  public.log_decision(text, text, uuid, text, text, text, text, text, text, jsonb, text, jsonb, numeric, integer),
  public.log_agent_note(text, text, uuid, text, uuid, text, text),
  public.text_mentions_patient_name(text)
from public, anon, authenticated, service_role;

-- Used inside CHECK constraints: anyone who may insert questions must be able to run it.
grant execute on function public.decision_question_options_ok(text, jsonb) to authenticated, service_role;

-- Human-only review functions (app-facing, intentionally callable by signed-in users;
-- each one checks for the treating clinician or staff). Never granted to service_role.
grant execute on function
  public.approve_fact(uuid),
  public.edit_and_approve_fact(uuid, jsonb),
  public.reject_fact(uuid),
  public.supersede_fact(uuid, jsonb),
  public.resolve_open_item(uuid, text),
  public.answer_gp_query(uuid, text)
to authenticated;

-- Background jobs.
grant execute on function
  public.get_processing_eligibility(uuid),
  public.build_transcript_segments(uuid)
to service_role;

-- MCP server bookkeeping.
grant execute on function
  public.log_agent_access(text, text, uuid, text, uuid, uuid, text, text, boolean, text, integer),
  public.log_decision(text, text, uuid, text, text, text, text, text, text, jsonb, text, jsonb, numeric, integer),
  public.log_agent_note(text, text, uuid, text, uuid, text, text),
  public.text_mentions_patient_name(text)
to mcp_server;

commit;
