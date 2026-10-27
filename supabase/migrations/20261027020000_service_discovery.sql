-- =====================================================================
-- Service discovery, problem-specific insurance and research workflow.
--
-- Adds a service catalogue, clinician service offerings, effective-dated
-- prices, extracted insurance rules, clinic acceptance evidence, patient
-- policy documents, and a staff-verified research pipeline.
--
-- Coverage is never invented. Rows extracted by jobs are unverified drafts
-- until staff approve them. Nothing here submits an insurance claim.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Facility discovery metadata
-- ---------------------------------------------------------------------
alter table public.facilities
  add column if not exists description text check (char_length(description) <= 2000),
  add column if not exists website     text;

-- ---------------------------------------------------------------------
-- 2. Service catalogue
-- ---------------------------------------------------------------------
create table public.service_catalog (
  id                        uuid primary key default gen_random_uuid(),
  code                      text not null unique check (code = lower(code) and code ~ '^[a-z][a-z0-9_]{1,63}$'),
  name                      text not null check (char_length(name) between 1 and 160),
  category                  text not null check (char_length(category) between 1 and 64),
  insurance_category        text check (char_length(insurance_category) between 1 and 64),
  required_specialty        text check (char_length(required_specialty) between 1 and 160),
  default_duration_minutes  smallint not null default 30 check (default_duration_minutes between 5 and 480),
  active                    boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index service_catalog_category_idx on public.service_catalog (category) where active;

create table public.service_aliases (
  alias       text primary key check (alias = lower(alias) and char_length(alias) between 2 and 120),
  service_id  uuid not null references public.service_catalog(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index service_aliases_service_idx on public.service_aliases (service_id);

create table public.clinician_services (
  id           uuid primary key default gen_random_uuid(),
  clinician_id uuid not null references public.clinicians(id) on delete cascade,
  service_id   uuid not null references public.service_catalog(id) on delete cascade,
  facility_id  uuid references public.facilities(id) on delete cascade,
  active       boolean not null default true,
  notes        text check (char_length(notes) <= 500),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index clinician_services_unique
  on public.clinician_services
     (clinician_id, service_id, coalesce(facility_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index clinician_services_service_idx on public.clinician_services (service_id) where active;

create table public.service_prices (
  id               uuid primary key default gen_random_uuid(),
  facility_id      uuid not null references public.facilities(id) on delete cascade,
  clinician_id     uuid references public.clinicians(id) on delete cascade,
  service_id       uuid not null references public.service_catalog(id) on delete cascade,
  mbs_item         text,
  fee              numeric(10,2) not null check (fee >= 0),
  medicare_rebate  numeric(10,2) not null default 0 check (medicare_rebate >= 0 and medicare_rebate <= fee),
  valid_from       date not null,
  valid_to         date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    facility_id with =,
    coalesce(clinician_id, '00000000-0000-0000-0000-000000000000'::uuid) with =,
    service_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);
create index service_prices_lookup_idx
  on public.service_prices (facility_id, service_id, valid_from desc);

-- ---------------------------------------------------------------------
-- 3. Insurance coverage and clinic acceptance evidence
-- ---------------------------------------------------------------------
create table public.insurance_service_rules (
  id                   uuid primary key default gen_random_uuid(),
  plan_id              uuid not null references public.insurance_plans(id) on delete cascade,
  service_id           uuid references public.service_catalog(id) on delete cascade,
  insurance_category   text check (char_length(insurance_category) between 1 and 64),
  coverage_status      text not null check (coverage_status in (
                         'covered', 'partially_covered', 'not_covered', 'waiting_period',
                         'limit_reached', 'pre_auth_required', 'no_policy', 'unknown')),
  benefit_type         text not null default 'none'
                         check (benefit_type in ('none', 'fixed', 'percent', 'mbs_percent')),
  benefit_value        numeric(10,2) check (benefit_value >= 0),
  annual_limit         numeric(10,2) check (annual_limit >= 0),
  waiting_period_days  integer not null default 0 check (waiting_period_days between 0 and 3650),
  requires_preauth     boolean not null default false,
  verification_level   text not null default 'fallback_unverified'
                         check (verification_level in ('verified', 'primary_extracted', 'fallback_unverified')),
  source_type          text not null check (source_type in (
                         'phio', 'privatehealth', 'insurer_site', 'provider_directory',
                         'clinic_site', 'patient_document', 'staff')),
  source_url           text check (char_length(source_url) <= 2000),
  source_quote         text check (char_length(source_quote) <= 1000),
  retrieved_at         timestamptz,
  content_hash         text check (content_hash ~ '^[0-9a-f]{64}$'),
  valid_from           date not null default current_date,
  valid_to             date,
  active               boolean not null default true,
  verified_by          uuid,
  verified_at          timestamptz,
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (service_id is not null or insurance_category is not null),
  check (valid_to is null or valid_to > valid_from),
  check (verification_level <> 'verified' or verified_at is not null),
  check (benefit_type = 'none' or benefit_value is not null)
);
create index insurance_service_rules_lookup_idx
  on public.insurance_service_rules (plan_id, service_id, insurance_category, valid_from desc)
  where active;

create table public.facility_insurance_acceptances (
  id                   uuid primary key default gen_random_uuid(),
  facility_id          uuid not null references public.facilities(id) on delete cascade,
  insurer_provider_id  uuid not null references public.insurance_providers(id) on delete cascade,
  plan_id              uuid references public.insurance_plans(id) on delete cascade,
  service_id           uuid references public.service_catalog(id) on delete cascade,
  insurance_category   text check (char_length(insurance_category) between 1 and 64),
  accepted             boolean not null,
  claim_mode           text not null default 'unknown'
                         check (claim_mode in ('direct', 'manual', 'not_supported', 'unknown')),
  verification_level   text not null default 'fallback_unverified'
                         check (verification_level in ('verified', 'primary_extracted', 'fallback_unverified')),
  source_type          text not null check (source_type in (
                         'phio', 'privatehealth', 'insurer_site', 'provider_directory',
                         'clinic_site', 'patient_document', 'staff')),
  source_url           text check (char_length(source_url) <= 2000),
  source_quote         text check (char_length(source_quote) <= 1000),
  retrieved_at         timestamptz,
  content_hash         text check (content_hash ~ '^[0-9a-f]{64}$'),
  valid_from           date not null default current_date,
  valid_to             date,
  active               boolean not null default true,
  verified_by          uuid,
  verified_at          timestamptz,
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (accepted or claim_mode in ('not_supported', 'unknown')),
  check (valid_to is null or valid_to > valid_from),
  check (verification_level <> 'verified' or verified_at is not null)
);
create index facility_acceptances_lookup_idx
  on public.facility_insurance_acceptances
     (facility_id, insurer_provider_id, service_id, insurance_category, valid_from desc)
  where active;

create table public.patient_insurance_documents (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.patients(id) on delete cascade,
  plan_id        uuid references public.insurance_plans(id) on delete set null,
  storage_path   text not null unique check (char_length(storage_path) between 1 and 500),
  file_name      text not null check (char_length(file_name) between 1 and 255),
  status         text not null default 'uploaded'
                   check (status in ('uploaded', 'pending_review', 'verified', 'rejected', 'expired')),
  uploaded_at    timestamptz not null default now(),
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  review_notes   text check (char_length(review_notes) <= 1000),
  expires_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index patient_insurance_documents_patient_idx
  on public.patient_insurance_documents (patient_id, uploaded_at desc);

-- Jobs may write facts, but never authoritative coverage or acceptance.
create or replace function public.insurance_evidence_agent_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'service_role' then
    if tg_op = 'UPDATE' and old.verification_level = 'verified' then
      raise exception 'Verified insurance evidence cannot be changed by jobs' using errcode = '42501';
    end if;
    if new.verification_level = 'verified' then
      raise exception 'Only staff can verify insurance evidence' using errcode = '42501';
    end if;
    if tg_table_name = 'insurance_service_rules' then
      new.verification_level := case
        when new.source_type in ('phio', 'privatehealth') then 'primary_extracted'
        else 'fallback_unverified'
      end;
    else
      new.verification_level := 'fallback_unverified';
    end if;
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end $$;

create trigger insurance_service_rules_agent_guard
  before insert or update on public.insurance_service_rules
  for each row execute function public.insurance_evidence_agent_guard();
create trigger facility_acceptances_agent_guard
  before insert or update on public.facility_insurance_acceptances
  for each row execute function public.insurance_evidence_agent_guard();

-- Staff verification. Only staff can make evidence authoritative.
create or replace function public.verify_insurance_rule(p_rule_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can verify insurance rules' using errcode = '42501';
  end if;
  update public.insurance_service_rules
     set verification_level = 'verified', verified_by = auth.uid(), verified_at = now()
   where id = p_rule_id;
  if not found then raise exception 'Insurance rule not found'; end if;
end $$;

create or replace function public.verify_facility_acceptance(p_acceptance_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can verify clinic acceptance' using errcode = '42501';
  end if;
  update public.facility_insurance_acceptances
     set verification_level = 'verified', verified_by = auth.uid(), verified_at = now()
   where id = p_acceptance_id;
  if not found then raise exception 'Clinic acceptance not found'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Research targets, runs and staff-reviewed drafts
-- ---------------------------------------------------------------------
create table public.research_targets (
  id                   uuid primary key default gen_random_uuid(),
  target_type          text not null check (target_type in ('plan_coverage', 'facility_acceptance')),
  plan_id              uuid references public.insurance_plans(id) on delete cascade,
  facility_id          uuid references public.facilities(id) on delete cascade,
  insurer_provider_id  uuid references public.insurance_providers(id) on delete cascade,
  service_id           uuid references public.service_catalog(id) on delete cascade,
  insurance_category   text check (char_length(insurance_category) between 1 and 64),
  url                  text check (char_length(url) <= 2000),
  source_type          text not null check (source_type in (
                         'phio', 'privatehealth', 'insurer_site', 'provider_directory', 'clinic_site')),
  priority             smallint not null default 100,
  active               boolean not null default true,
  last_run_at          timestamptz,
  next_run_at          timestamptz not null default now(),
  last_status          text check (last_status in ('ok', 'blocked', 'error')),
  last_error           text check (char_length(last_error) <= 1000),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (
    (target_type = 'plan_coverage'
      and plan_id is not null
      and (service_id is not null or insurance_category is not null))
    or
    (target_type = 'facility_acceptance'
      and facility_id is not null and insurer_provider_id is not null)
  )
);
create index research_targets_due_idx
  on public.research_targets (next_run_at, priority) where active;

create table public.research_runs (
  id             uuid primary key default gen_random_uuid(),
  target_id      uuid references public.research_targets(id) on delete set null,
  job_id         text check (char_length(job_id) <= 128),
  source_url     text check (char_length(source_url) <= 2000),
  status         text not null check (status in ('running', 'ok', 'blocked', 'error')),
  pages_fetched  integer not null default 0 check (pages_fetched >= 0),
  drafts_created integer not null default 0 check (drafts_created >= 0),
  errors         integer not null default 0 check (errors >= 0),
  notes          text[] not null default '{}',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index research_runs_target_idx on public.research_runs (target_id, started_at desc);

create table public.research_drafts (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null references public.research_runs(id) on delete cascade,
  target_id            uuid references public.research_targets(id) on delete set null,
  kind                 text not null check (kind in ('coverage', 'acceptance')),
  plan_id              uuid references public.insurance_plans(id) on delete cascade,
  facility_id          uuid references public.facilities(id) on delete cascade,
  insurer_provider_id  uuid references public.insurance_providers(id) on delete cascade,
  service_id           uuid references public.service_catalog(id) on delete cascade,
  insurance_category   text check (char_length(insurance_category) between 1 and 64),
  coverage_status      text check (coverage_status in (
                         'covered', 'partially_covered', 'not_covered', 'waiting_period',
                         'limit_reached', 'pre_auth_required', 'no_policy', 'unknown')),
  benefit_type         text check (benefit_type in ('none', 'fixed', 'percent', 'mbs_percent')),
  benefit_value        numeric(10,2) check (benefit_value >= 0),
  annual_limit         numeric(10,2) check (annual_limit >= 0),
  waiting_period_days  integer check (waiting_period_days between 0 and 3650),
  requires_preauth     boolean,
  accepted             boolean,
  claim_mode           text check (claim_mode in ('direct', 'manual', 'not_supported', 'unknown')),
  source_type          text not null check (source_type in (
                         'phio', 'privatehealth', 'insurer_site', 'provider_directory', 'clinic_site')),
  source_url           text check (char_length(source_url) <= 2000),
  evidence_quote       text not null check (char_length(evidence_quote) between 1 and 1000),
  content_hash         text check (content_hash ~ '^[0-9a-f]{64}$'),
  confidence           numeric(5,4) not null check (confidence between 0 and 1),
  status               text not null default 'pending'
                         check (status in ('pending', 'approved', 'rejected')),
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_reason        text check (char_length(review_reason) <= 500),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (
    (kind = 'coverage' and plan_id is not null and coverage_status is not null
      and (service_id is not null or insurance_category is not null))
    or
    (kind = 'acceptance' and facility_id is not null and insurer_provider_id is not null
      and accepted is not null and claim_mode is not null)
  ),
  check (status <> 'approved' or reviewed_at is not null)
);
create index research_drafts_pending_idx
  on public.research_drafts (created_at) where status = 'pending';

create or replace function public.approve_research_draft(
  p_draft_id uuid,
  p_valid_from date default current_date
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v public.research_drafts;
  v_id uuid;
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can approve research drafts' using errcode = '42501';
  end if;

  select * into v from public.research_drafts where id = p_draft_id for update;
  if not found then raise exception 'Research draft not found'; end if;
  if v.status <> 'pending' then raise exception 'Research draft is no longer pending'; end if;

  if v.kind = 'coverage' then
    insert into public.insurance_service_rules (
      plan_id, service_id, insurance_category, coverage_status, benefit_type, benefit_value,
      annual_limit, waiting_period_days, requires_preauth, verification_level, source_type,
      source_url, source_quote, retrieved_at, content_hash, valid_from, verified_by, verified_at)
    values (
      v.plan_id, v.service_id, v.insurance_category, v.coverage_status,
      coalesce(v.benefit_type, 'none'), v.benefit_value, v.annual_limit,
      coalesce(v.waiting_period_days, 0), coalesce(v.requires_preauth, false),
      'verified', v.source_type, v.source_url, v.evidence_quote, now(), v.content_hash,
      p_valid_from, auth.uid(), now())
    returning id into v_id;
  else
    insert into public.facility_insurance_acceptances (
      facility_id, insurer_provider_id, service_id, insurance_category, accepted, claim_mode,
      verification_level, source_type, source_url, source_quote, retrieved_at, content_hash,
      valid_from, verified_by, verified_at)
    values (
      v.facility_id, v.insurer_provider_id, v.service_id, v.insurance_category,
      v.accepted, v.claim_mode, 'verified', v.source_type, v.source_url, v.evidence_quote,
      now(), v.content_hash, p_valid_from, auth.uid(), now())
    returning id into v_id;
  end if;

  update public.research_drafts
     set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_draft_id;
  return v_id;
end $$;

create or replace function public.reject_research_draft(p_draft_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can reject research drafts' using errcode = '42501';
  end if;
  update public.research_drafts
     set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
         review_reason = p_reason
   where id = p_draft_id and status = 'pending';
  if not found then raise exception 'Pending research draft not found'; end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Appointment quote and idempotency columns
-- ---------------------------------------------------------------------
alter table public.appointments
  add column if not exists service_id uuid references public.service_catalog(id),
  add column if not exists quoted_fee numeric(10,2) check (quoted_fee >= 0),
  add column if not exists quoted_medicare_rebate numeric(10,2) check (quoted_medicare_rebate >= 0),
  add column if not exists quoted_insurance_benefit numeric(10,2) check (quoted_insurance_benefit >= 0),
  add column if not exists quoted_gap numeric(10,2) check (quoted_gap >= 0),
  add column if not exists coverage_status text check (coverage_status in (
                        'covered', 'partially_covered', 'not_covered', 'waiting_period',
                        'limit_reached', 'pre_auth_required', 'no_policy', 'unknown')),
  add column if not exists claim_mode text check (claim_mode in (
                        'direct', 'manual', 'not_supported', 'unknown')),
  add column if not exists coverage_verification_level text check (coverage_verification_level in (
                        'verified', 'primary_extracted', 'fallback_unverified')),
  add column if not exists quote_checked_at timestamptz,
  add column if not exists idempotency_key text check (char_length(idempotency_key) between 8 and 128);

create unique index appointments_patient_idempotency_idx
  on public.appointments (patient_id, idempotency_key)
  where idempotency_key is not null;

-- Book with a service and re-check the price inside the same transaction.
-- The caller has already evaluated coverage; quoted values are snapshotted.
create or replace function public.book_service_slot(
  p_slot_id                    uuid,
  p_service_id                 uuid,
  p_reason                     text,
  p_idempotency_key            text,
  p_expected_fee               numeric,
  p_expected_gap               numeric,
  p_quoted_medicare_rebate     numeric,
  p_quoted_insurance_benefit   numeric,
  p_coverage_status            text,
  p_claim_mode                 text,
  p_verification                text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_patient      uuid := public.current_patient_id();
  v_service      public.service_catalog;
  v_slot         public.appointment_slots;
  v_local_date   date;
  v_fee          numeric;
  v_affiliation  uuid;
  v_appt         uuid;
begin
  if v_patient is null then
    raise exception 'Only patients can book slots' using errcode = '42501';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) < 8 then
    raise exception 'A valid idempotency key is required';
  end if;

  select id into v_appt
    from public.appointments
   where patient_id = v_patient and idempotency_key = p_idempotency_key;
  if found then return v_appt; end if;

  select * into v_service from public.service_catalog
   where id = p_service_id and active;
  if not found then raise exception 'Unknown or inactive service'; end if;

  select * into v_slot from public.appointment_slots where id = p_slot_id;
  if not found then raise exception 'Slot is no longer available' using errcode = 'P0001'; end if;
  if v_slot.ends_at - v_slot.starts_at < make_interval(mins => v_service.default_duration_minutes) then
    raise exception 'Slot is too short for this service';
  end if;
  if not exists (
    select 1 from public.clinician_services cs
     where cs.clinician_id = v_slot.clinician_id
       and cs.service_id = p_service_id
       and cs.active
       and (cs.facility_id is null or cs.facility_id = v_slot.facility_id)
  ) then
    raise exception 'Clinician does not offer this service';
  end if;

  v_local_date := public.facility_local_date(v_slot.facility_id, v_slot.starts_at);
  v_affiliation := public.affiliation_on(v_slot.clinician_id, v_slot.facility_id, v_local_date);
  if v_affiliation is null then
    raise exception 'Clinician is not affiliated with this facility on %', v_local_date;
  end if;

  select sp.fee into v_fee
    from public.service_prices sp
   where sp.facility_id = v_slot.facility_id
     and sp.service_id = p_service_id
     and (sp.clinician_id = v_slot.clinician_id or sp.clinician_id is null)
     and daterange(sp.valid_from, sp.valid_to, '[)') @> v_local_date
   order by sp.clinician_id nulls last, sp.valid_from desc
   limit 1;

  if p_expected_fee is not null and v_fee is distinct from p_expected_fee then
    raise exception 'Quote has changed' using errcode = 'P0001';
  end if;

  v_appt := public._book_slot(p_slot_id, v_patient, 'web', p_reason, v_service.code);

  update public.appointments
     set service_id = p_service_id,
         quoted_fee = v_fee,
         quoted_medicare_rebate = p_quoted_medicare_rebate,
         quoted_insurance_benefit = p_quoted_insurance_benefit,
         quoted_gap = p_expected_gap,
         coverage_status = p_coverage_status,
         claim_mode = p_claim_mode,
         coverage_verification_level = p_verification,
         quote_checked_at = now(),
         idempotency_key = p_idempotency_key
   where id = v_appt;

  return v_appt;
end $$;

-- Keep updated_at fresh on the new mutable tables.
do $$
declare t text;
begin
  foreach t in array array[
    'service_catalog', 'clinician_services', 'service_prices', 'insurance_service_rules',
    'facility_insurance_acceptances', 'patient_insurance_documents', 'research_targets',
    'research_drafts'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. RLS and privileges
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'service_catalog', 'service_aliases', 'clinician_services', 'service_prices',
    'insurance_service_rules', 'facility_insurance_acceptances',
    'patient_insurance_documents', 'research_targets', 'research_runs', 'research_drafts'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'service_catalog', 'service_aliases', 'clinician_services', 'service_prices',
    'facility_insurance_acceptances'
  ] loop
    execute format('create policy "read: signed-in users" on public.%I
                      for select to authenticated using (true)', t);
    execute format('create policy "write: staff" on public.%I
                      for all to authenticated
                      using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

-- Coverage rules are visible only for the signed-in patient's own plans.
create policy "read: own plan or staff" on public.insurance_service_rules
  for select to authenticated
  using (
    (select public.is_staff())
    or exists (
      select 1 from public.patient_insurance_policies p
       where p.patient_id = (select public.current_patient_id())
         and p.plan_id = insurance_service_rules.plan_id
    )
  );
create policy "write: staff" on public.insurance_service_rules
  for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

create policy "read: own or staff" on public.patient_insurance_documents
  for select to authenticated
  using (patient_id = (select public.current_patient_id()) or (select public.is_staff()));
create policy "insert: own" on public.patient_insurance_documents
  for insert to authenticated
  with check (patient_id = (select public.current_patient_id()));
create policy "update: staff" on public.patient_insurance_documents
  for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "delete: staff" on public.patient_insurance_documents
  for delete to authenticated using ((select public.is_staff()));

do $$
declare t text;
begin
  foreach t in array array['research_targets', 'research_runs', 'research_drafts'] loop
    execute format('create policy "read: staff" on public.%I
                      for select to authenticated using ((select public.is_staff()))', t);
    execute format('create policy "write: staff" on public.%I
                      for all to authenticated
                      using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

revoke all on function
  public.insurance_evidence_agent_guard(),
  public.verify_insurance_rule(uuid),
  public.verify_facility_acceptance(uuid),
  public.approve_research_draft(uuid, date),
  public.reject_research_draft(uuid, text),
  public.book_service_slot(uuid, uuid, text, text, numeric, numeric, numeric, numeric, text, text, text)
from public, anon;

grant execute on function
  public.verify_insurance_rule(uuid),
  public.verify_facility_acceptance(uuid),
  public.approve_research_draft(uuid, date),
  public.reject_research_draft(uuid, text),
  public.book_service_slot(uuid, uuid, text, text, numeric, numeric, numeric, numeric, text, text, text)
to authenticated;

-- Jobs write evidence drafts but cannot confirm bookings or verify evidence.
grant insert, update on
  public.insurance_service_rules,
  public.facility_insurance_acceptances,
  public.research_targets,
  public.research_runs,
  public.research_drafts
to service_role;

revoke execute on function public.book_service_slot(
  uuid, uuid, text, text, numeric, numeric, numeric, numeric, text, text, text
) from service_role;

commit;
