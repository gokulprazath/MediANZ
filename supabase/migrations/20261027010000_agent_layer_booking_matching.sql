-- =====================================================================
-- Agent layer, part 2 of 2: booking proposals, GP matching, fees,
-- insurance plan coverage, facility review summaries, web research log.
--
-- Run after 20261027000000_agent_layer.sql.
-- Runs as one transaction: if anything fails, nothing is saved.
-- =====================================================================
begin;

-- =====================================================================
-- 1. BOOKING PROPOSALS (4.7)
--    The patient assistant can only PROPOSE. The app shows a confirmation
--    card; the booking happens only when the patient taps Confirm, which
--    calls confirm_booking_proposal() with the patient's own token.
-- =====================================================================
create table public.booking_proposals (
  id                     uuid primary key default gen_random_uuid(),
  patient_id             uuid not null references public.patients(id),
  kind                   text not null check (kind in ('book', 'cancel', 'reschedule')),
  slot_id                uuid references public.appointment_slots(id),
  appointment_id         uuid references public.appointments(id),
  new_slot_id            uuid references public.appointment_slots(id),
  reason                 text check (char_length(reason) <= 500),
  visit_type             text check (char_length(visit_type) <= 32),
  status                 text not null default 'pending'
                           check (status in ('pending', 'confirmed', 'declined', 'expired')),
  expires_at             timestamptz not null default now() + interval '10 minutes',
  created_by_agent       text check (char_length(created_by_agent) <= 64),
  created_at             timestamptz not null default now(),
  confirmed_at           timestamptz,
  result_appointment_id  uuid references public.appointments(id),
  check (   (kind = 'book'       and slot_id is not null and appointment_id is null     and new_slot_id is null)
         or (kind = 'cancel'     and slot_id is null     and appointment_id is not null and new_slot_id is null)
         or (kind = 'reschedule' and slot_id is null     and appointment_id is not null and new_slot_id is not null)),
  check (status <> 'confirmed' or confirmed_at is not null)
);
create index booking_proposals_patient_idx on public.booking_proposals (patient_id, created_at desc);
create index booking_proposals_pending_idx on public.booking_proposals (expires_at) where status = 'pending';

-- New proposals: always pending, 10-minute expiry, and cancel/reschedule
-- only for the proposing patient's own appointments.
create or replace function public.booking_proposals_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.status := 'pending';
  new.created_at := now();
  new.expires_at := now() + interval '10 minutes';
  new.confirmed_at := null;
  new.result_appointment_id := null;

  if new.kind in ('cancel', 'reschedule')
     and not exists (select 1 from public.appointments a
                      where a.id = new.appointment_id and a.patient_id = new.patient_id) then
    raise exception 'Appointment not found' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger booking_proposals_before_insert
  before insert on public.booking_proposals
  for each row execute function public.booking_proposals_before_insert();

-- Called by the app when the patient taps Confirm. Books, cancels or
-- reschedules in the same transaction and returns the resulting appointment id.
create or replace function public.confirm_booking_proposal(p_proposal_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_p     public.booking_proposals;
  v_appt  uuid;
begin
  select * into v_p from public.booking_proposals where id = p_proposal_id for update;
  if not found or v_p.patient_id is distinct from public.current_patient_id() then
    raise exception 'Proposal not found' using errcode = '42501';
  end if;
  if v_p.status <> 'pending' then
    raise exception 'Proposal is no longer pending';
  end if;
  if v_p.expires_at <= now() then
    raise exception 'Proposal has expired';
  end if;

  case v_p.kind
    when 'book' then
      v_appt := public.book_slot(v_p.slot_id, v_p.reason, v_p.visit_type);
    when 'cancel' then
      perform public.cancel_appointment(v_p.appointment_id, v_p.reason);
      v_appt := v_p.appointment_id;
    when 'reschedule' then
      v_appt := public.reschedule_appointment(v_p.appointment_id, v_p.new_slot_id);
  end case;

  update public.booking_proposals
     set status = 'confirmed', confirmed_at = now(), result_appointment_id = v_appt
   where id = p_proposal_id;
  return v_appt;
end $$;

create or replace function public.decline_booking_proposal(p_proposal_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_p public.booking_proposals;
begin
  select * into v_p from public.booking_proposals where id = p_proposal_id for update;
  if not found or v_p.patient_id is distinct from public.current_patient_id() then
    raise exception 'Proposal not found' using errcode = '42501';
  end if;
  if v_p.status <> 'pending' then
    raise exception 'Proposal is no longer pending';
  end if;
  update public.booking_proposals set status = 'declined' where id = p_proposal_id;
end $$;

-- Housekeeping (pg_cron, below).
create or replace function public.expire_booking_proposals()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.booking_proposals set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- =====================================================================
-- 2. MATCHING DATA (4.8)
-- =====================================================================
alter table public.clinicians
  add column if not exists languages               text[]  not null default '{en}',
  add column if not exists accepting_new_patients  boolean not null default true,
  add column if not exists offers_telehealth       boolean not null default false,
  add column if not exists special_interests       text[]  not null default '{}';

alter table public.facilities
  add column if not exists google_place_id text unique;

create table public.patient_gp_preferences (
  patient_id               uuid primary key references public.patients(id) on delete cascade,
  preferred_languages      text[] not null default '{}',
  preferred_clinician_sex  text check (preferred_clinician_sex in ('female', 'male', 'intersex', 'not_stated')),
  preferred_facility_ids   uuid[] not null default '{}',
  telehealth_ok            boolean not null default false,
  max_distance_km          integer check (max_distance_km between 1 and 500),
  updated_at               timestamptz not null default now()
);

create table public.clinician_preferences (
  clinician_id  uuid primary key references public.clinicians(id) on delete cascade,
  prefs         jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object'),
  updated_at    timestamptz not null default now()
);

create table public.clinician_match_scores (
  clinician_id     uuid not null references public.clinicians(id) on delete cascade,
  factor           text not null check (factor ~ '^[a-z][a-z0-9_]{1,62}$'),
  score            numeric(5,4) not null check (score between 0 and 1),
  scoring_version  text not null,
  computed_at      timestamptz not null default now(),
  primary key (clinician_id, factor, scoring_version)
);

-- Fee per facility, visit type and (optionally) clinician. A clinician-specific
-- row overrides the facility-wide one (clinician_id null).
create table public.fee_schedules (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facilities(id),
  clinician_id     uuid references public.clinicians(id),
  visit_type       text not null check (char_length(visit_type) between 1 and 32),
  mbs_item         text,
  fee              numeric(10,2) not null check (fee >= 0),
  medicare_rebate  numeric(10,2) not null default 0 check (medicare_rebate >= 0),
  valid_from       date not null,
  valid_to         date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    facility_id with =,
    (coalesce(clinician_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    visit_type with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- What a plan covers, effective-dated. Drafts come from insurer websites
-- (research job); only staff verify them (verify_plan_version). Patients
-- and agents only ever see verified versions.
create table public.insurance_plan_versions (
  id                   uuid primary key default gen_random_uuid(),
  plan_id              uuid not null references public.insurance_plans(id),
  valid_from           date not null,
  valid_to             date,
  hospital_inclusions  jsonb not null default '[]'::jsonb,
  hospital_exclusions  jsonb not null default '[]'::jsonb,
  hospital_restricted  jsonb not null default '[]'::jsonb,
  excess               numeric(10,2) check (excess >= 0),
  extras_limits        jsonb not null default '{}'::jsonb,
  waiting_periods      jsonb not null default '{}'::jsonb,
  gp_benefit           jsonb not null default '{"covered": false}'::jsonb check (jsonb_typeof(gp_benefit) = 'object'),
  source               text not null check (source in ('phio_dataset', 'insurer_site')),
  source_url           text,
  retrieved_at         timestamptz,
  content_hash         text check (content_hash ~ '^[0-9a-f]{64}$'),
  status               text not null default 'draft' check (status in ('draft', 'verified')),
  verified_by          uuid,
  verified_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  check (status <> 'verified' or verified_at is not null),
  -- Verified versions of one plan never overlap.
  exclude using gist (
    plan_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  ) where (status = 'verified')
);
create index insurance_plan_versions_plan_idx on public.insurance_plan_versions (plan_id, valid_from);

-- The research job (service_role) may create verified versions only from the
-- official PHIO dataset; insurer-website versions are always drafts, and it
-- can never change a verified version.
create or replace function public.insurance_plan_versions_agent_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'service_role' then
    if tg_op = 'UPDATE' and old.status = 'verified' then
      raise exception 'Verified plan versions cannot be changed by jobs' using errcode = '42501';
    end if;
    if new.status = 'verified' and new.source <> 'phio_dataset' then
      raise exception 'Only staff can verify plan versions from insurer sites' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      raise exception 'Only staff can verify plan versions' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger insurance_plan_versions_agent_guard
  before insert or update on public.insurance_plan_versions
  for each row execute function public.insurance_plan_versions_agent_guard();

-- Staff only. Closes the previous open-ended verified version, if any.
create or replace function public.verify_plan_version(p_plan_version_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v public.insurance_plan_versions;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can verify plan versions' using errcode = '42501';
  end if;
  select * into v from public.insurance_plan_versions where id = p_plan_version_id for update;
  if not found then
    raise exception 'Plan version not found';
  end if;
  if v.status <> 'draft' then
    raise exception 'Plan version is already verified';
  end if;

  update public.insurance_plan_versions
     set valid_to = v.valid_from
   where plan_id = v.plan_id
     and status = 'verified'
     and id <> v.id
     and valid_from < v.valid_from
     and (valid_to is null or valid_to > v.valid_from);

  update public.insurance_plan_versions
     set status = 'verified', verified_by = auth.uid(), verified_at = now()
   where id = p_plan_version_id;
end $$;

-- Rating and count only; review text is never stored.
create table public.facility_review_summaries (
  facility_id           uuid not null references public.facilities(id) on delete cascade,
  source                text not null check (source in ('google_places')),
  rating                numeric(2,1) check (rating between 0 and 5),
  review_count          integer not null default 0 check (review_count >= 0),
  non_clinical_summary  text check (char_length(non_clinical_summary) <= 1000),
  source_url            text,
  retrieved_at          timestamptz not null,
  primary key (facility_id, source)
);

-- Web research audit trail (append-only, hashes and domains only).
create table public.web_research_log (
  id              bigint generated always as identity primary key,
  job_id          text check (char_length(job_id) <= 128),
  tool            text not null check (char_length(tool) <= 64),
  query_hash      text check (query_hash ~ '^[0-9a-f]{64}$'),
  domains         text[] not null default '{}',
  urls            text[] not null default '{}',
  result_count    integer not null default 0 check (result_count >= 0),
  blocked_reason  text check (char_length(blocked_reason) <= 64),
  created_at      timestamptz not null default now()
);

create trigger append_only_row before update or delete on public.web_research_log
  for each row execute function public.append_only_guard();
create trigger append_only_truncate before truncate on public.web_research_log
  for each statement execute function public.append_only_guard();

create or replace function public.log_web_research(
  p_job_id         text,
  p_tool           text,
  p_query_hash     text,
  p_domains        text[],
  p_urls           text[],
  p_result_count   integer,
  p_blocked_reason text
) returns bigint language sql security definer set search_path = '' as $$
  insert into public.web_research_log (job_id, tool, query_hash, domains, urls, result_count, blocked_reason)
  values (p_job_id, p_tool, p_query_hash, coalesce(p_domains, '{}'), coalesce(p_urls, '{}'),
          greatest(coalesce(p_result_count, 0), 0), p_blocked_reason)
  returning id
$$;

do $$
declare t text;
begin
  foreach t in array array['patient_gp_preferences', 'clinician_preferences', 'fee_schedules',
                           'insurance_plan_versions'] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- =====================================================================
-- 3. find_gp_candidates (4.8): hard filters only; ranking is done by the
--    matching MCP server. Runs with the caller's rights (RLS applies).
-- =====================================================================
create or replace function public.find_gp_candidates(
  p_date_from       date,
  p_date_to         date,
  p_lat             numeric default null,
  p_lng             numeric default null,
  p_max_km          numeric default null,
  p_clinician_type  public.clinician_type default 'gp',
  p_languages       text[] default null,
  p_sex             text default null,
  p_telehealth      boolean default null
) returns table (
  clinician_id       uuid,
  clinician_name     text,
  clinician_type     public.clinician_type,
  specialty          text,
  sex                text,
  languages          text[],
  offers_telehealth  boolean,
  facility_id        uuid,
  facility_name      text,
  facility_suburb    text,
  distance_km        numeric,
  next_slot_id       uuid,
  next_slot_start    timestamptz,
  next_slot_local    timestamp,
  facility_tz        text
) language plpgsql stable set search_path = '' as $$
begin
  if p_date_from is null or p_date_to is null or p_date_to < p_date_from then
    raise exception 'Invalid date range';
  end if;
  if p_date_to - p_date_from > 31 then
    raise exception 'Date range is limited to 31 days';
  end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'Latitude and longitude must be given together';
  end if;

  return query
  with base as (
    select c.id as c_id, c.first_name || ' ' || c.last_name as c_name, c.clinician_type as c_type,
           c.specialty as c_specialty, c.sex as c_sex, c.languages as c_languages,
           c.offers_telehealth as c_tele, f.id as f_id, f.name as f_name, f.suburb as f_suburb,
           f.timezone as f_tz,
           case when p_lat is null or f.latitude is null then null
                else round((2 * 6371 * asin(sqrt(
                       power(sin(radians((f.latitude - p_lat)::float8) / 2), 2)
                     + cos(radians(p_lat::float8)) * cos(radians(f.latitude::float8))
                       * power(sin(radians((f.longitude - p_lng)::float8) / 2), 2))))::numeric, 1)
           end as dist
      from public.clinicians c
      join public.clinician_affiliations ca on ca.clinician_id = c.id
      join public.facilities f on f.id = ca.facility_id
     where c.is_active and f.is_active
       and (p_clinician_type is null or c.clinician_type = p_clinician_type)
       and (c.accepting_new_patients
            -- existing patients of this clinician can still book
            or exists (select 1 from public.appointments a
                        where a.clinician_id = c.id
                          and a.patient_id = public.current_patient_id()
                          and a.status = 'completed'))
       and (p_languages is null or cardinality(p_languages) = 0 or c.languages && p_languages)
       and (p_sex is null or c.sex = p_sex)
       and (p_telehealth is distinct from true or c.offers_telehealth)
       -- affiliated for at least part of the range (checked per slot below)
       and daterange(ca.valid_from, ca.valid_to, '[)') && daterange(p_date_from, p_date_to, '[]')
  )
  select b.c_id, b.c_name, b.c_type, b.c_specialty, b.c_sex, b.c_languages, b.c_tele,
         b.f_id, b.f_name, b.f_suburb, b.dist, s.id, s.starts_at, (s.starts_at at time zone b.f_tz), b.f_tz
    from base b
    cross join lateral (
      select sl.id, sl.starts_at
        from public.appointment_slots sl
       where sl.clinician_id = b.c_id
         and sl.facility_id = b.f_id
         and (sl.status = 'available' or (sl.status = 'held' and sl.held_until < now()))
         and sl.starts_at > now()
         and (sl.starts_at at time zone b.f_tz)::date between p_date_from and p_date_to
         and public.affiliation_on(b.c_id, b.f_id, (sl.starts_at at time zone b.f_tz)::date) is not null
       order by sl.starts_at
       limit 1
    ) s
   where p_max_km is null or b.dist is null or b.dist <= p_max_km
   order by s.starts_at, b.dist nulls last, b.c_name;
end $$;

-- =====================================================================
-- 4. estimate_fees (4.8): always an estimate.
--    Medicare rebate only if the patient's residency on that date is
--    Medicare-eligible; insurance benefit only from the VERIFIED plan
--    version in force on that date. Callable for yourself, by staff, or
--    by background jobs (service_role).
--
--    gp_benefit shape: {"covered": false}
--                   or {"covered": true, "basis": "mbs_percent", "percent": 100}
--                   or {"covered": true, "basis": "fixed", "amount": 20.00}
--    mbs_percent is a percentage of the schedule's medicare_rebate amount
--    (the MBS benefit), as paid by overseas student / visitor cover.
-- =====================================================================
create or replace function public.estimate_fees(
  p_patient_id    uuid,
  p_facility_id   uuid,
  p_clinician_id  uuid,
  p_visit_type    text,
  p_date          date
) returns table (
  fee_schedule_id    uuid,
  mbs_item           text,
  fee                numeric,
  medicare_eligible  boolean,
  medicare_rebate    numeric,
  policy_id          uuid,
  plan_id            uuid,
  plan_version_id    uuid,
  insurance_benefit  numeric,
  gap                numeric,
  is_estimate        boolean
) language plpgsql stable set search_path = '' as $$
declare
  v_fs        public.fee_schedules;
  v_eligible  boolean;
  v_rebate    numeric := 0;
  v_policy    uuid;
  v_plan      uuid;
  v_version   public.insurance_plan_versions;
  v_benefit   numeric := 0;
begin
  if not (coalesce(p_patient_id = public.current_patient_id(), false)
          or coalesce(public.is_staff(), false)
          or current_user = 'service_role') then
    raise exception 'Not allowed to estimate fees for this patient' using errcode = '42501';
  end if;

  select fs.* into v_fs
    from public.fee_schedules fs
   where fs.facility_id = p_facility_id
     and fs.visit_type = p_visit_type
     and (fs.clinician_id = p_clinician_id or fs.clinician_id is null)
     and daterange(fs.valid_from, fs.valid_to, '[)') @> p_date
   order by fs.clinician_id nulls last
   limit 1;
  if not found then
    return;   -- no rows: no fee schedule for this visit
  end if;

  select rs.medicare_eligible into v_eligible
    from public.patient_residency pr
    join public.residency_statuses rs on rs.id = pr.residency_status_id
   where pr.patient_id = p_patient_id
     and daterange(pr.valid_from, pr.valid_to, '[)') @> p_date;
  v_eligible := coalesce(v_eligible, false);
  if v_eligible then
    v_rebate := least(v_fs.medicare_rebate, v_fs.fee);
  end if;

  v_policy := public.policy_on(p_patient_id, p_date);
  if v_policy is not null then
    select pip.plan_id into v_plan from public.patient_insurance_policies pip where pip.id = v_policy;
    select ipv.* into v_version
      from public.insurance_plan_versions ipv
     where ipv.plan_id = v_plan
       and ipv.status = 'verified'
       and daterange(ipv.valid_from, ipv.valid_to, '[)') @> p_date;
    if found and coalesce((v_version.gp_benefit ->> 'covered')::boolean, false) then
      v_benefit := case v_version.gp_benefit ->> 'basis'
        when 'mbs_percent' then round(v_fs.medicare_rebate
                                      * coalesce((v_version.gp_benefit ->> 'percent')::numeric, 0) / 100, 2)
        when 'fixed'       then coalesce((v_version.gp_benefit ->> 'amount')::numeric, 0)
        else 0
      end;
      v_benefit := greatest(least(v_benefit, v_fs.fee - v_rebate), 0);
    end if;
  end if;

  return query select
    v_fs.id, v_fs.mbs_item, v_fs.fee, v_eligible, v_rebate, v_policy, v_plan,
    case when v_version.id is not null then v_version.id end,
    v_benefit, greatest(v_fs.fee - v_rebate - v_benefit, 0), true;
end $$;

-- =====================================================================
-- 5. ROW LEVEL SECURITY AND TABLE PRIVILEGES
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'booking_proposals', 'patient_gp_preferences', 'clinician_preferences', 'clinician_match_scores',
    'fee_schedules', 'insurance_plan_versions', 'facility_review_summaries', 'web_research_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Proposals: patients read and create their own; status changes only through
-- confirm_booking_proposal / decline_booking_proposal.
create policy "read: own or staff" on public.booking_proposals
  for select to authenticated
  using (patient_id = (select public.current_patient_id()) or (select public.is_staff()));
create policy "insert: own" on public.booking_proposals
  for insert to authenticated
  with check (patient_id = (select public.current_patient_id()));
revoke update, delete, truncate on public.booking_proposals from authenticated;

-- GP preferences: the patient manages their own; staff everything.
create policy "read: own or staff" on public.patient_gp_preferences
  for select to authenticated
  using (patient_id = (select public.current_patient_id()) or (select public.is_staff()));
create policy "write: own or staff" on public.patient_gp_preferences
  for all to authenticated
  using (patient_id = (select public.current_patient_id()) or (select public.is_staff()))
  with check (patient_id = (select public.current_patient_id()) or (select public.is_staff()));

-- Documentation preferences: the clinician manages their own; staff everything.
create policy "read: own or staff" on public.clinician_preferences
  for select to authenticated
  using (clinician_id = (select public.current_clinician_id()) or (select public.is_staff()));
create policy "write: own or staff" on public.clinician_preferences
  for all to authenticated
  using (clinician_id = (select public.current_clinician_id()) or (select public.is_staff()))
  with check (clinician_id = (select public.current_clinician_id()) or (select public.is_staff()));

-- Directory-style data: signed-in users read; staff manage.
do $$
declare t text;
begin
  foreach t in array array['clinician_match_scores', 'fee_schedules', 'facility_review_summaries'] loop
    execute format('create policy "read: signed-in users" on public.%I
                      for select to authenticated using (true)', t);
    execute format('create policy "write: staff" on public.%I
                      for all to authenticated
                      using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

-- Plan versions: signed-in users see verified versions; staff see and manage all.
create policy "read: verified, or staff" on public.insurance_plan_versions
  for select to authenticated
  using (status = 'verified' or (select public.is_staff()));
create policy "write: staff" on public.insurance_plan_versions
  for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
revoke delete, truncate on public.insurance_plan_versions from service_role;

-- Web research log: append-only, written only through log_web_research().
revoke all on public.web_research_log from authenticated, service_role, mcp_server;

-- =====================================================================
-- 6. FUNCTION PERMISSIONS
-- =====================================================================
revoke all on function
  public.booking_proposals_before_insert(),
  public.confirm_booking_proposal(uuid),
  public.decline_booking_proposal(uuid),
  public.expire_booking_proposals(),
  public.insurance_plan_versions_agent_guard(),
  public.verify_plan_version(uuid),
  public.log_web_research(text, text, text, text[], text[], integer, text),
  public.find_gp_candidates(date, date, numeric, numeric, numeric, public.clinician_type, text[], text, boolean),
  public.estimate_fees(uuid, uuid, uuid, text, date)
from public, anon, authenticated, service_role;

-- App-facing (intentional): the patient confirms or declines, staff verify.
-- Never granted to service_role: agents cannot confirm bookings or verify plans.
grant execute on function
  public.confirm_booking_proposal(uuid),
  public.decline_booking_proposal(uuid),
  public.verify_plan_version(uuid)
to authenticated;

-- Read-only lookups (security invoker: RLS applies to the caller).
grant execute on function
  public.find_gp_candidates(date, date, numeric, numeric, numeric, public.clinician_type, text[], text, boolean),
  public.estimate_fees(uuid, uuid, uuid, text, date)
to authenticated, service_role;

grant execute on function public.expire_booking_proposals() to service_role;
grant execute on function public.log_web_research(text, text, text, text[], text[], integer, text) to mcp_server;

-- =====================================================================
-- 7. SCHEDULED JOB: expire stale proposals every minute (if pg_cron exists).
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('expire-booking-proposals', '* * * * *',
                          $job$select public.expire_booking_proposals()$job$);
  else
    raise notice 'pg_cron not enabled: expire-booking-proposals job not scheduled';
  end if;
end $$;

commit;
