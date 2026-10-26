-- =====================================================================
-- Health booking schema for Supabase (Postgres 15+)
--
-- Covers:
--   * Patients, clinicians, facilities (hospitals / GP clinics)
--   * Effective-dated history (insurance, residency, address, affiliations,
--     registrations, billing policy) with no-overlap constraints
--   * Booking: schedules -> generated slots -> appointments, double-booking
--     prevention, holds, cancellation, rescheduling, no-show tracking
--   * Recording consent, transcription sessions, transcripts
--     (audio is NEVER stored; approved transcripts are kept, rejected or
--     unreviewed ones are deleted)
--   * Per-appointment clinician ratings
--   * Row Level Security, Realtime and pg_cron jobs
--
-- Roles assumed (Supabase defaults): anon, authenticated, service_role.
-- Staff/admin users are identified by auth.users.raw_app_meta_data:
--   {"role": "staff"} or {"role": "admin"}  (set server-side only)
-- =====================================================================

create extension if not exists btree_gist;

-- =====================================================================
-- 1. ENUM TYPES
-- =====================================================================
create type public.facility_type          as enum ('hospital', 'gp_clinic', 'specialist_clinic');
create type public.billing_policy         as enum ('bulk_billed', 'mixed', 'private_only');
create type public.clinician_type         as enum ('gp', 'specialist', 'nurse', 'allied_health');
create type public.residency_category     as enum ('citizen', 'permanent_resident', 'temporary_visa', 'visitor', 'other');
create type public.insurance_cover_type   as enum ('hospital', 'extras', 'combined');
create type public.address_type           as enum ('residential', 'postal', 'billing');
create type public.registration_status    as enum ('registered', 'registered_with_conditions', 'suspended', 'cancelled');
create type public.slot_status            as enum ('available', 'held', 'booked', 'blocked');
create type public.schedule_exception_type as enum ('unavailable', 'extra_session');
create type public.appointment_status     as enum ('booked', 'confirmed', 'checked_in', 'in_consultation',
                                                   'completed', 'cancelled', 'no_show', 'rescheduled');
create type public.booking_channel        as enum ('web', 'mobile', 'phone', 'reception');
create type public.claim_status           as enum ('draft', 'submitted', 'approved', 'rejected', 'paid');
create type public.consent_party          as enum ('patient', 'clinician');
create type public.consent_method         as enum ('in_app', 'verbal_recorded', 'written');
create type public.recording_status       as enum ('started', 'awaiting_review', 'approved', 'rejected',
                                                   'expired', 'failed', 'consent_withdrawn');
create type public.transcript_status      as enum ('pending_patient_review', 'approved');
create type public.moderation_status      as enum ('visible', 'hidden', 'flagged');

-- =====================================================================
-- 2. GENERIC HELPERS
-- =====================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- True when the caller's JWT app_metadata.role is staff or admin.
create or replace function public.is_staff()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('staff', 'admin')
$$;

-- =====================================================================
-- 3. REFERENCE TABLES
-- =====================================================================
create table public.residency_statuses (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,          -- e.g. 'AU_CITIZEN', 'PR_189', 'VISA_500'
  category          public.residency_category not null,
  visa_subclass     text,                          -- e.g. '500' (null for citizens)
  name              text not null,                 -- e.g. 'Student visa'
  medicare_eligible boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.insurance_providers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  phone       text,
  website     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.insurance_plans (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null references public.insurance_providers(id),
  plan_name    text not null,
  cover_type   public.insurance_cover_type not null,
  tier         text check (tier in ('gold', 'silver', 'bronze', 'basic')),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (provider_id, plan_name)
);

-- =====================================================================
-- 4. PATIENTS (+ history)
-- =====================================================================
create table public.patients (
  id                              uuid primary key default gen_random_uuid(),
  auth_user_id                    uuid unique references auth.users(id) on delete set null,
  first_name                      text not null,
  last_name                       text not null,
  preferred_name                  text,
  date_of_birth                   date not null check (date_of_birth <= current_date),
  sex                             text check (sex in ('female', 'male', 'intersex', 'not_stated')),
  gender_identity                 text,
  email                           text,
  phone                           text,
  blood_type                      text check (blood_type in ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
  medicare_number                 text check (medicare_number ~ '^\d{10}$'),
  medicare_irn                    smallint check (medicare_irn between 1 and 9),
  medicare_expiry                 date,
  ihi_number                      text check (ihi_number ~ '^\d{16}$'),
  emergency_contact_name          text,
  emergency_contact_phone         text,
  emergency_contact_relationship  text,
  is_active                       boolean not null default true,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

-- Address history: one current address per type; old rows kept with valid_to.
create table public.patient_addresses (
  id             uuid primary key default gen_random_uuid(),
  patient_id     uuid not null references public.patients(id) on delete cascade,
  address_type   public.address_type not null default 'residential',
  address_line1  text not null,
  address_line2  text,
  suburb         text not null,
  state          text not null,
  postcode       text not null,
  country        text not null default 'Australia',
  valid_from     date not null default current_date,
  valid_to       date,                                     -- null = current
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    patient_id with =, address_type with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- Residency / visa history.
create table public.patient_residency (
  id                   uuid primary key default gen_random_uuid(),
  patient_id           uuid not null references public.patients(id) on delete cascade,
  residency_status_id  uuid not null references public.residency_statuses(id),
  visa_grant_number    text,
  valid_from           date not null,
  valid_to             date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    patient_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- Insurance history: ONE policy at a time per patient.
create table public.patient_insurance_policies (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.patients(id) on delete cascade,
  plan_id            uuid not null references public.insurance_plans(id),
  membership_number  text not null,
  is_primary_holder  boolean not null default true,
  valid_from         date not null,
  valid_to           date,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    patient_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- =====================================================================
-- 5. FACILITIES (hospitals and clinics) (+ history)
-- =====================================================================
create table public.facilities (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  facility_type  public.facility_type not null,
  abn            text check (abn ~ '^\d{11}$'),
  phone          text,
  email          text,
  address_line1  text not null,
  address_line2  text,
  suburb         text not null,
  state          text not null,
  postcode       text not null,
  country        text not null default 'Australia',
  timezone       text not null default 'Australia/Brisbane',   -- IANA name; used for slot times
  latitude       numeric(9,6),
  longitude      numeric(9,6),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Billing policy history (e.g. a clinic stops bulk billing on a date).
create table public.facility_billing_policies (
  id              uuid primary key default gen_random_uuid(),
  facility_id     uuid not null references public.facilities(id) on delete cascade,
  billing_policy  public.billing_policy not null,
  notes           text,
  valid_from      date not null,
  valid_to        date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    facility_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- =====================================================================
-- 6. CLINICIANS (+ history)
-- =====================================================================
create table public.clinicians (
  id                         uuid primary key default gen_random_uuid(),
  auth_user_id               uuid unique references auth.users(id) on delete set null,
  first_name                 text not null,
  last_name                  text not null,
  sex                        text check (sex in ('female', 'male', 'intersex', 'not_stated')),
  email                      text,
  phone                      text,
  clinician_type             public.clinician_type not null default 'gp',
  specialty                  text,
  ahpra_registration_number  text unique check (ahpra_registration_number ~ '^[A-Z]{3}\d{10}$'),
  is_active                  boolean not null default true,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create table public.clinician_qualifications (
  id             uuid primary key default gen_random_uuid(),
  clinician_id   uuid not null references public.clinicians(id) on delete cascade,
  qualification  text not null,          -- e.g. 'MBBS', 'FRACGP'
  institution    text,
  year_awarded   smallint check (year_awarded between 1900 and 2100),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- AHPRA registration status history.
create table public.clinician_registrations (
  id            uuid primary key default gen_random_uuid(),
  clinician_id  uuid not null references public.clinicians(id) on delete cascade,
  status        public.registration_status not null,
  conditions    text,
  valid_from    date not null,
  valid_to      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    clinician_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- Which facility a clinician worked at, and when.
create table public.clinician_affiliations (
  id                        uuid primary key default gen_random_uuid(),
  clinician_id              uuid not null references public.clinicians(id) on delete cascade,
  facility_id               uuid not null references public.facilities(id),
  role                      text,                     -- e.g. 'GP', 'Registrar', 'VMO'
  medicare_provider_number  text check (medicare_provider_number ~ '^\d{6}[0-9A-Z]{2}$'),
  valid_from                date not null,
  valid_to                  date,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  check (valid_to is null or valid_to > valid_from),
  exclude using gist (
    clinician_id with =, facility_id with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);

-- =====================================================================
-- 7. BOOKING: schedules, exceptions, slots
-- =====================================================================
-- Recurring weekly availability. weekday: 1 = Monday ... 7 = Sunday (ISO).
create table public.clinician_schedules (
  id            uuid primary key default gen_random_uuid(),
  clinician_id  uuid not null references public.clinicians(id) on delete cascade,
  facility_id   uuid not null references public.facilities(id),
  weekday       smallint not null check (weekday between 1 and 7),
  start_time    time not null,
  end_time      time not null,
  slot_minutes  smallint not null check (slot_minutes between 5 and 240),
  valid_from    date not null default current_date,
  valid_to      date,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_time > start_time),
  check (valid_to is null or valid_to > valid_from)
);

-- Leave / holidays ('unavailable') or one-off extra sessions.
create table public.schedule_exceptions (
  id              uuid primary key default gen_random_uuid(),
  clinician_id    uuid not null references public.clinicians(id) on delete cascade,
  facility_id     uuid references public.facilities(id),   -- null + unavailable = all facilities
  exception_type  public.schedule_exception_type not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  slot_minutes    smallint check (slot_minutes between 5 and 240),
  reason          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (ends_at > starts_at),
  check (exception_type <> 'extra_session' or (facility_id is not null and slot_minutes is not null))
);

-- Concrete bookable slots (generated by public.generate_slots()).
create table public.appointment_slots (
  id                   uuid primary key default gen_random_uuid(),
  clinician_id         uuid not null references public.clinicians(id),
  facility_id          uuid not null references public.facilities(id),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,
  status               public.slot_status not null default 'available',
  held_by_patient_id   uuid references public.patients(id) on delete set null,
  held_until           timestamptz,
  source_schedule_id   uuid references public.clinician_schedules(id) on delete set null,
  source_exception_id  uuid references public.schedule_exceptions(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (ends_at > starts_at),
  check (status <> 'held' or (held_by_patient_id is not null and held_until is not null)),
  -- A clinician can never have two overlapping slots (across any facility).
  exclude using gist (
    clinician_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  )
);
create index appointment_slots_facility_start_idx on public.appointment_slots (facility_id, starts_at);
create index appointment_slots_status_start_idx   on public.appointment_slots (status, starts_at);

-- =====================================================================
-- 8. APPOINTMENTS (booking + visit in one row) and status history
-- =====================================================================
create table public.appointments (
  id                             uuid primary key default gen_random_uuid(),
  slot_id                        uuid not null references public.appointment_slots(id),
  patient_id                     uuid not null references public.patients(id),
  clinician_id                   uuid not null references public.clinicians(id),
  facility_id                    uuid not null references public.facilities(id),

  -- History snapshots: the exact rows in force for this appointment
  clinician_affiliation_id       uuid not null references public.clinician_affiliations(id),
  patient_insurance_policy_id    uuid references public.patient_insurance_policies(id),

  scheduled_start                timestamptz not null,
  scheduled_end                  timestamptz not null,
  status                         public.appointment_status not null default 'booked',
  visit_type                     text,          -- e.g. 'standard', 'long', 'telehealth'
  reason                         text,

  -- Booking tracking
  booking_channel                public.booking_channel not null default 'web',
  booked_at                      timestamptz not null default now(),
  booked_by                      uuid,          -- auth user who made the booking
  confirmed_at                   timestamptz,
  reminder_sent_at               timestamptz,

  -- Attendance tracking
  checked_in_at                  timestamptz,   -- patient arrival time
  consult_started_at             timestamptz,
  consult_ended_at               timestamptz,
  no_show_marked_at              timestamptz,

  -- Cancellation / rescheduling
  cancelled_at                   timestamptz,
  cancelled_by                   uuid,
  cancellation_reason            text,
  rescheduled_to_appointment_id  uuid references public.appointments(id),

  -- Visit outcome and money (amounts copied at the time, never recalculated)
  clinical_notes                 text,
  fee_charged                    numeric(10,2) check (fee_charged >= 0),
  medicare_rebate                numeric(10,2) check (medicare_rebate >= 0),
  gap_amount                     numeric(10,2) check (gap_amount >= 0),

  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),
  check (scheduled_end > scheduled_start)
);

-- Only one live appointment per slot: the database-level double-booking guard.
create unique index one_active_booking_per_slot
  on public.appointments (slot_id)
  where status not in ('cancelled', 'rescheduled');

create index appointments_patient_idx   on public.appointments (patient_id, scheduled_start desc);
create index appointments_clinician_idx on public.appointments (clinician_id, scheduled_start);
create index appointments_open_idx      on public.appointments (scheduled_start)
  where status in ('booked', 'confirmed');

create table public.appointment_status_history (
  id              bigint generated always as identity primary key,
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  from_status     public.appointment_status,
  to_status       public.appointment_status not null,
  changed_at      timestamptz not null default now(),
  changed_by      uuid default auth.uid()
);
create index appointment_status_history_appt_idx on public.appointment_status_history (appointment_id, changed_at);

-- =====================================================================
-- 9. INSURANCE CLAIMS
-- =====================================================================
create table public.insurance_claims (
  id                           uuid primary key default gen_random_uuid(),
  appointment_id               uuid not null references public.appointments(id),
  patient_insurance_policy_id  uuid not null references public.patient_insurance_policies(id),
  claim_number                 text unique,
  amount_claimed               numeric(10,2) not null check (amount_claimed >= 0),
  amount_approved              numeric(10,2) check (amount_approved >= 0),
  amount_paid                  numeric(10,2) check (amount_paid >= 0),
  status                       public.claim_status not null default 'draft',
  submitted_at                 timestamptz,
  processed_at                 timestamptz,
  rejection_reason             text,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
create index insurance_claims_appointment_idx on public.insurance_claims (appointment_id);

-- =====================================================================
-- 10. RECORDING CONSENT, SESSIONS AND TRANSCRIPTS
--     Audio is never stored. A session row records that audio was
--     processed and discarded; the transcript is kept only if approved.
-- =====================================================================
create table public.recording_consents (
  id                    uuid primary key default gen_random_uuid(),
  appointment_id        uuid not null references public.appointments(id) on delete cascade,
  party                 public.consent_party not null,
  patient_id            uuid references public.patients(id),
  clinician_id          uuid references public.clinicians(id),
  consent_given         boolean not null,
  consent_text_version  text not null,          -- which consent wording was shown
  method                public.consent_method not null default 'in_app',
  given_at              timestamptz not null default now(),
  withdrawn_at          timestamptz,
  withdrawal_reason     text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (appointment_id, party),
  check ((party = 'patient'   and patient_id   is not null and clinician_id is null)
      or (party = 'clinician' and clinician_id is not null and patient_id   is null))
);

create table public.recording_sessions (
  id                  uuid primary key default gen_random_uuid(),
  appointment_id      uuid not null references public.appointments(id) on delete cascade,
  started_by          uuid not null,             -- auth user who started recording
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  duration_seconds    integer check (duration_seconds >= 0),
  engine              text,                      -- speech-to-text provider
  engine_model        text,
  status              public.recording_status not null default 'started',
  audio_discarded_at  timestamptz,               -- when the in-memory audio was dropped
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index recording_sessions_appt_idx on public.recording_sessions (appointment_id);

create table public.consult_transcripts (
  id                    uuid primary key default gen_random_uuid(),
  recording_session_id  uuid not null unique references public.recording_sessions(id) on delete cascade,
  appointment_id        uuid not null references public.appointments(id) on delete cascade,
  transcript_text       text not null,
  segments              jsonb,          -- optional [{speaker, start_sec, end_sec, text}]
  summary_text          text,           -- optional generated summary
  language              text not null default 'en-AU',
  status                public.transcript_status not null default 'pending_patient_review',
  review_expires_at     timestamptz not null,   -- unreviewed drafts are deleted after this
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (status <> 'approved' or approved_at is not null)
);
create index consult_transcripts_appt_idx on public.consult_transcripts (appointment_id);
create index consult_transcripts_pending_idx on public.consult_transcripts (review_expires_at)
  where status = 'pending_patient_review';

-- =====================================================================
-- 11. CLINICIAN RATINGS (one per appointment)
-- =====================================================================
create table public.clinician_ratings (
  id                    uuid primary key default gen_random_uuid(),
  appointment_id        uuid not null unique references public.appointments(id) on delete cascade,
  patient_id            uuid not null references public.patients(id),
  clinician_id          uuid not null references public.clinicians(id),
  rating                smallint not null check (rating between 1 and 5),
  rating_communication  smallint check (rating_communication between 1 and 5),
  rating_wait_time      smallint check (rating_wait_time between 1 and 5),
  would_recommend       boolean,
  comment               text check (char_length(comment) <= 2000),
  is_anonymous          boolean not null default false,
  moderation_status     public.moderation_status not null default 'visible',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index clinician_ratings_clinician_idx on public.clinician_ratings (clinician_id);

-- =====================================================================
-- 12. updated_at TRIGGERS
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'residency_statuses','insurance_providers','insurance_plans','patients',
    'patient_addresses','patient_residency','patient_insurance_policies',
    'facilities','facility_billing_policies','clinicians','clinician_qualifications',
    'clinician_registrations','clinician_affiliations','clinician_schedules',
    'schedule_exceptions','appointment_slots','appointments','insurance_claims',
    'recording_consents','recording_sessions','consult_transcripts','clinician_ratings'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- =====================================================================
-- 13. IDENTITY AND HISTORY LOOKUP HELPERS
-- =====================================================================
create or replace function public.current_patient_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.patients where auth_user_id = auth.uid()
$$;

create or replace function public.current_clinician_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.clinicians where auth_user_id = auth.uid()
$$;

-- Insurance policy in force for a patient on a date (or null if uninsured).
create or replace function public.policy_on(p_patient_id uuid, p_date date)
returns uuid language sql stable set search_path = '' as $$
  select id from public.patient_insurance_policies
  where patient_id = p_patient_id
    and daterange(valid_from, valid_to, '[)') @> p_date
$$;

-- Clinician's affiliation with a facility on a date (or null).
create or replace function public.affiliation_on(p_clinician_id uuid, p_facility_id uuid, p_date date)
returns uuid language sql stable set search_path = '' as $$
  select id from public.clinician_affiliations
  where clinician_id = p_clinician_id
    and facility_id  = p_facility_id
    and daterange(valid_from, valid_to, '[)') @> p_date
$$;

-- Local calendar date of a moment at a facility.
create or replace function public.facility_local_date(p_facility_id uuid, p_at timestamptz)
returns date language sql stable set search_path = '' as $$
  select (p_at at time zone f.timezone)::date from public.facilities f where f.id = p_facility_id
$$;

-- =====================================================================
-- 14. SLOT GENERATION AND EXCEPTION SYNC
-- =====================================================================
-- Block future available/held slots that overlap 'unavailable' exceptions,
-- and unblock slots whose exception was removed.
-- Booked slots are never touched. To find bookings that now clash with leave:
--   select a.* from appointments a join schedule_exceptions e
--     on e.clinician_id = a.clinician_id and e.exception_type = 'unavailable'
--    and (e.facility_id is null or e.facility_id = a.facility_id)
--    and tstzrange(e.starts_at, e.ends_at) && tstzrange(a.scheduled_start, a.scheduled_end)
--  where a.status in ('booked', 'confirmed');
create or replace function public.sync_slot_blocks(p_clinician_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.appointment_slots s
     set status = 'blocked', held_by_patient_id = null, held_until = null
   where s.status in ('available', 'held')
     and s.starts_at > now()
     and (p_clinician_id is null or s.clinician_id = p_clinician_id)
     and exists (
       select 1 from public.schedule_exceptions e
        where e.exception_type = 'unavailable'
          and e.clinician_id = s.clinician_id
          and (e.facility_id is null or e.facility_id = s.facility_id)
          and tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'));

  update public.appointment_slots s
     set status = 'available'
   where s.status = 'blocked'
     and s.starts_at > now()
     and (p_clinician_id is null or s.clinician_id = p_clinician_id)
     and not exists (
       select 1 from public.schedule_exceptions e
        where e.exception_type = 'unavailable'
          and e.clinician_id = s.clinician_id
          and (e.facility_id is null or e.facility_id = s.facility_id)
          and tstzrange(e.starts_at, e.ends_at, '[)') && tstzrange(s.starts_at, s.ends_at, '[)'))
     and not exists (
       select 1 from public.appointments a
        where a.slot_id = s.id and a.status not in ('cancelled', 'rescheduled'));
end $$;

-- Create slots for every day in [p_from, p_to] from schedules and extra sessions.
-- Safe to re-run: existing or overlapping slots are skipped. Returns slots created.
create or replace function public.generate_slots(p_from date, p_to date)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_regular integer;
  v_extra   integer;
begin
  if p_to < p_from then
    raise exception 'p_to must be on or after p_from';
  end if;

  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  windows as (
    select s.id as schedule_id, s.clinician_id, s.facility_id, s.slot_minutes,
           ((dy.day + s.start_time)::timestamp at time zone f.timezone) as win_start,
           ((dy.day + s.end_time)::timestamp   at time zone f.timezone) as win_end
      from public.clinician_schedules s
      join days dy
        on extract(isodow from dy.day) = s.weekday
       and dy.day >= s.valid_from
       and (s.valid_to is null or dy.day < s.valid_to)
      join public.facilities f on f.id = s.facility_id and f.is_active
      join public.clinicians c on c.id = s.clinician_id and c.is_active
     where public.affiliation_on(s.clinician_id, s.facility_id, dy.day) is not null
  ),
  candidate as (
    select w.schedule_id, w.clinician_id, w.facility_id,
           g as slot_start,
           g + make_interval(mins => w.slot_minutes) as slot_end
      from windows w,
           generate_series(w.win_start,
                            w.win_end - make_interval(mins => w.slot_minutes),
                            make_interval(mins => w.slot_minutes)) g
  )
  insert into public.appointment_slots (clinician_id, facility_id, starts_at, ends_at, source_schedule_id)
  select clinician_id, facility_id, slot_start, slot_end, schedule_id
    from candidate
   where slot_start > now()
  on conflict do nothing;
  get diagnostics v_regular = row_count;

  with candidate as (
    select e.id as exception_id, e.clinician_id, e.facility_id,
           g as slot_start,
           g + make_interval(mins => e.slot_minutes) as slot_end
      from public.schedule_exceptions e,
           generate_series(e.starts_at,
                           e.ends_at - make_interval(mins => e.slot_minutes),
                           make_interval(mins => e.slot_minutes)) g
     where e.exception_type = 'extra_session'
       and (e.starts_at at time zone 'UTC')::date <= p_to + 1
       and (e.ends_at   at time zone 'UTC')::date >= p_from - 1
  )
  insert into public.appointment_slots (clinician_id, facility_id, starts_at, ends_at, source_exception_id)
  select clinician_id, facility_id, slot_start, slot_end, exception_id
    from candidate
   where slot_start > now()
  on conflict do nothing;
  get diagnostics v_extra = row_count;

  perform public.sync_slot_blocks(null);
  return v_regular + v_extra;
end $$;

-- Keep slots in sync immediately when leave/extra sessions change.
create or replace function public.schedule_exceptions_after_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.exception_type = 'extra_session' then
    perform public.generate_slots(
      (new.starts_at at time zone 'UTC')::date,
      (new.ends_at   at time zone 'UTC')::date);
  end if;
  perform public.sync_slot_blocks(coalesce(new.clinician_id, old.clinician_id));
  return null;
end $$;

create trigger schedule_exceptions_after_change
  after insert or update or delete on public.schedule_exceptions
  for each row execute function public.schedule_exceptions_after_change();

-- =====================================================================
-- 15. BOOKING FUNCTIONS (call from the app with supabase.rpc)
-- =====================================================================
-- Reserve a slot for 5 minutes while the patient completes the booking form.
create or replace function public.hold_slot(p_slot_id uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  v_patient uuid := public.current_patient_id();
  v_until   timestamptz;
begin
  if v_patient is null then
    raise exception 'Only patients can hold slots' using errcode = '42501';
  end if;

  update public.appointment_slots
     set status = 'held', held_by_patient_id = v_patient,
         held_until = now() + interval '5 minutes'
   where id = p_slot_id
     and starts_at > now()
     and (status = 'available'
          or (status = 'held' and (held_until < now() or held_by_patient_id = v_patient)))
  returning held_until into v_until;

  if not found then
    raise exception 'Slot is no longer available' using errcode = 'P0001';
  end if;
  return v_until;
end $$;

-- Internal: claims the slot atomically and creates the appointment.
create or replace function public._book_slot(
  p_slot_id    uuid,
  p_patient_id uuid,
  p_channel    public.booking_channel,
  p_reason     text,
  p_visit_type text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_slot        public.appointment_slots;
  v_local_date  date;
  v_affiliation uuid;
  v_appt_id     uuid;
begin
  -- Atomic claim. If two people book at once, the second UPDATE waits for the
  -- first to commit, re-checks the WHERE clause, matches nothing, and fails.
  update public.appointment_slots
     set status = 'booked', held_by_patient_id = null, held_until = null
   where id = p_slot_id
     and starts_at > now()
     and (status = 'available'
          or (status = 'held' and (held_until < now() or held_by_patient_id = p_patient_id)))
  returning * into v_slot;

  if not found then
    raise exception 'Slot is no longer available' using errcode = 'P0001';
  end if;

  v_local_date  := public.facility_local_date(v_slot.facility_id, v_slot.starts_at);
  v_affiliation := public.affiliation_on(v_slot.clinician_id, v_slot.facility_id, v_local_date);
  if v_affiliation is null then
    raise exception 'Clinician is not affiliated with this facility on %', v_local_date;
  end if;

  insert into public.appointments (
    slot_id, patient_id, clinician_id, facility_id,
    clinician_affiliation_id, patient_insurance_policy_id,
    scheduled_start, scheduled_end, booking_channel, booked_by, reason, visit_type)
  values (
    v_slot.id, p_patient_id, v_slot.clinician_id, v_slot.facility_id,
    v_affiliation, public.policy_on(p_patient_id, v_local_date),
    v_slot.starts_at, v_slot.ends_at, p_channel, auth.uid(), p_reason, p_visit_type)
  returning id into v_appt_id;

  return v_appt_id;
end $$;

-- Patients book for themselves; staff pass p_patient_id to book on behalf.
create or replace function public.book_slot(
  p_slot_id    uuid,
  p_reason     text default null,
  p_visit_type text default null,
  p_channel    public.booking_channel default 'web',
  p_patient_id uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_patient uuid;
begin
  if p_patient_id is not null then
    if not public.is_staff() then
      raise exception 'Only staff can book for another patient' using errcode = '42501';
    end if;
    v_patient := p_patient_id;
  else
    v_patient := public.current_patient_id();
    if v_patient is null then
      raise exception 'No patient profile for this user' using errcode = '42501';
    end if;
  end if;

  return public._book_slot(p_slot_id, v_patient, p_channel, p_reason, p_visit_type);
end $$;

create or replace function public.cancel_appointment(p_appointment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_appt public.appointments;
begin
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Appointment not found';
  end if;

  -- coalesce(..., false): a null comparison must never count as permission.
  if not coalesce(public.is_staff()
          or v_appt.clinician_id = public.current_clinician_id()
          or (v_appt.patient_id = public.current_patient_id() and v_appt.scheduled_start > now()), false) then
    raise exception 'Not allowed to cancel this appointment' using errcode = '42501';
  end if;

  update public.appointments
     set status = 'cancelled', cancellation_reason = p_reason, cancelled_by = auth.uid()
   where id = p_appointment_id;
end $$;

-- Books the new slot and marks the old appointment 'rescheduled' in one transaction.
create or replace function public.reschedule_appointment(p_appointment_id uuid, p_new_slot_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_appt   public.appointments;
  v_new_id uuid;
begin
  select * into v_appt from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Appointment not found';
  end if;

  if not coalesce(public.is_staff()
          or (v_appt.patient_id = public.current_patient_id() and v_appt.scheduled_start > now()), false) then
    raise exception 'Not allowed to reschedule this appointment' using errcode = '42501';
  end if;

  v_new_id := public._book_slot(p_new_slot_id, v_appt.patient_id, v_appt.booking_channel,
                                v_appt.reason, v_appt.visit_type);

  update public.appointments
     set status = 'rescheduled', rescheduled_to_appointment_id = v_new_id
   where id = p_appointment_id;

  return v_new_id;
end $$;

-- Slots open on a local date at the facility. Filters are optional.
create or replace function public.get_available_slots(
  p_date            date,
  p_facility_id     uuid default null,
  p_clinician_id    uuid default null,
  p_clinician_type  public.clinician_type default null
) returns table (
  slot_id         uuid,
  starts_at       timestamptz,
  ends_at         timestamptz,
  local_start     timestamp,
  clinician_id    uuid,
  clinician_name  text,
  clinician_type  public.clinician_type,
  specialty       text,
  facility_id     uuid,
  facility_name   text,
  facility_tz     text
) language sql stable set search_path = '' as $$
  select s.id, s.starts_at, s.ends_at, s.starts_at at time zone f.timezone,
         c.id, c.first_name || ' ' || c.last_name, c.clinician_type, c.specialty,
         f.id, f.name, f.timezone
    from public.appointment_slots s
    join public.facilities f on f.id = s.facility_id
    join public.clinicians c on c.id = s.clinician_id
   where (s.status = 'available' or (s.status = 'held' and s.held_until < now()))
     and s.starts_at > now()
     and (s.starts_at at time zone f.timezone)::date = p_date
     and (p_facility_id    is null or s.facility_id    = p_facility_id)
     and (p_clinician_id   is null or s.clinician_id   = p_clinician_id)
     and (p_clinician_type is null or c.clinician_type = p_clinician_type)
   order by f.name, c.last_name, s.starts_at
$$;

-- =====================================================================
-- 16. APPOINTMENT STATUS RULES, TIMESTAMPS AND HISTORY
-- =====================================================================
-- security definer so the insurance lookup works whoever performs check-in.
create or replace function public.appointments_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  if new.status is distinct from old.status then
    v_ok := case old.status
      when 'booked'          then new.status in ('confirmed','checked_in','cancelled','no_show','rescheduled')
      when 'confirmed'       then new.status in ('checked_in','cancelled','no_show','rescheduled')
      when 'checked_in'      then new.status in ('in_consultation','cancelled')
      when 'in_consultation' then new.status = 'completed'
      else false                                     -- completed/cancelled/no_show/rescheduled are final
    end;
    if not v_ok then
      raise exception 'Invalid appointment status change: % -> %', old.status, new.status
        using errcode = '23514';
    end if;

    case new.status
      when 'confirmed' then
        new.confirmed_at := coalesce(new.confirmed_at, now());
      when 'checked_in' then
        new.checked_in_at := coalesce(new.checked_in_at, now());
        -- Re-resolve the insurance policy in force on the visit date, in case
        -- it changed between booking and arrival.
        new.patient_insurance_policy_id := public.policy_on(
          new.patient_id, public.facility_local_date(new.facility_id, new.scheduled_start));
      when 'in_consultation' then
        new.consult_started_at := coalesce(new.consult_started_at, now());
      when 'completed' then
        new.consult_ended_at := coalesce(new.consult_ended_at, now());
      when 'cancelled' then
        new.cancelled_at := coalesce(new.cancelled_at, now());
        new.cancelled_by := coalesce(new.cancelled_by, auth.uid());
      when 'no_show' then
        new.no_show_marked_at := coalesce(new.no_show_marked_at, now());
      else
        null;
    end case;
  end if;

  -- Booking facts are fixed once created.
  if new.slot_id is distinct from old.slot_id
     or new.patient_id is distinct from old.patient_id
     or new.clinician_id is distinct from old.clinician_id
     or new.facility_id is distinct from old.facility_id
     or new.scheduled_start is distinct from old.scheduled_start then
    raise exception 'Slot, patient, clinician and time cannot be changed; reschedule instead'
      using errcode = '23514';
  end if;

  return new;
end $$;

create trigger appointments_before_update
  before update on public.appointments
  for each row execute function public.appointments_before_update();

create or replace function public.appointments_after_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.appointment_status_history (appointment_id, from_status, to_status)
    values (new.id, null, new.status);
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.appointment_status_history (appointment_id, from_status, to_status)
    values (new.id, old.status, new.status);

    -- Free the slot for the next person if the time is still in the future.
    if new.status in ('cancelled', 'rescheduled') then
      update public.appointment_slots
         set status = 'available'
       where id = new.slot_id and status = 'booked' and starts_at > now();
      perform public.sync_slot_blocks(new.clinician_id);   -- stays blocked if on leave
    end if;
  end if;
  return null;
end $$;

create trigger appointments_after_write
  after insert or update on public.appointments
  for each row execute function public.appointments_after_write();

-- =====================================================================
-- 17. CLAIMS: policy defaults to the one on the appointment, and must
--     belong to the same patient and be valid on the visit date.
-- =====================================================================
create or replace function public.insurance_claims_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_appt public.appointments;
  v_ok   boolean;
begin
  select * into v_appt from public.appointments where id = new.appointment_id;

  if new.patient_insurance_policy_id is null then
    new.patient_insurance_policy_id := v_appt.patient_insurance_policy_id;
  end if;
  if new.patient_insurance_policy_id is null then
    raise exception 'Patient had no insurance policy on the visit date' using errcode = '23514';
  end if;

  select exists (
    select 1 from public.patient_insurance_policies p
     where p.id = new.patient_insurance_policy_id
       and p.patient_id = v_appt.patient_id
       and daterange(p.valid_from, p.valid_to, '[)')
           @> public.facility_local_date(v_appt.facility_id, v_appt.scheduled_start)
  ) into v_ok;
  if not v_ok then
    raise exception 'Policy does not belong to this patient or was not valid on the visit date'
      using errcode = '23514';
  end if;

  if new.status = 'submitted' then new.submitted_at := coalesce(new.submitted_at, now()); end if;
  if new.status in ('approved','rejected','paid') then new.processed_at := coalesce(new.processed_at, now()); end if;
  return new;
end $$;

create trigger insurance_claims_before_write
  before insert or update on public.insurance_claims
  for each row execute function public.insurance_claims_before_write();

-- =====================================================================
-- 18. MONITORING JOBS
-- =====================================================================
create or replace function public.release_expired_holds()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.appointment_slots
     set status = 'available', held_by_patient_id = null, held_until = null
   where status = 'held' and held_until < now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.mark_no_shows(p_grace interval default interval '30 minutes')
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.appointments
     set status = 'no_show'
   where status in ('booked', 'confirmed')
     and scheduled_start < now() - p_grace;
  get diagnostics n = row_count;
  return n;
end $$;

-- =====================================================================
-- 19. RECORDING CONSENT AND TRANSCRIPT FUNCTIONS
-- =====================================================================
-- Called by the patient or the clinician of the appointment.
create or replace function public.give_recording_consent(
  p_appointment_id       uuid,
  p_consent_text_version text,
  p_method               public.consent_method default 'in_app'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_appt  public.appointments;
  v_party public.consent_party;
  v_id    uuid;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'Appointment not found';
  end if;
  if v_appt.status in ('completed','cancelled','no_show','rescheduled') then
    raise exception 'Consent can only be given for an upcoming or current appointment';
  end if;

  if v_appt.patient_id = public.current_patient_id() then
    v_party := 'patient';
  elsif v_appt.clinician_id = public.current_clinician_id() then
    v_party := 'clinician';
  else
    raise exception 'Only the patient or clinician of this appointment can consent' using errcode = '42501';
  end if;

  insert into public.recording_consents
    (appointment_id, party, patient_id, clinician_id, consent_given, consent_text_version, method)
  values
    (p_appointment_id, v_party,
     case when v_party = 'patient'   then v_appt.patient_id   end,
     case when v_party = 'clinician' then v_appt.clinician_id end,
     true, p_consent_text_version, p_method)
  on conflict (appointment_id, party) do update
     set consent_given = true, given_at = now(), withdrawn_at = null, withdrawal_reason = null,
         consent_text_version = excluded.consent_text_version, method = excluded.method
  returning id into v_id;

  return v_id;
end $$;

-- Both parties consented and neither has withdrawn.
create or replace function public.recording_allowed(p_appointment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select count(*) = 2
    from public.recording_consents
   where appointment_id = p_appointment_id
     and consent_given
     and withdrawn_at is null
$$;

-- Withdrawing consent deletes every transcript for the appointment.
create or replace function public.withdraw_recording_consent(p_appointment_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_appt  public.appointments;
  v_party public.consent_party;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if v_appt.patient_id = public.current_patient_id() then
    v_party := 'patient';
  elsif v_appt.clinician_id = public.current_clinician_id() then
    v_party := 'clinician';
  else
    raise exception 'Not a participant of this appointment' using errcode = '42501';
  end if;

  update public.recording_consents
     set withdrawn_at = now(), withdrawal_reason = p_reason
   where appointment_id = p_appointment_id and party = v_party and withdrawn_at is null;

  delete from public.consult_transcripts where appointment_id = p_appointment_id;

  update public.recording_sessions
     set status = 'consent_withdrawn', audio_discarded_at = coalesce(audio_discarded_at, now())
   where appointment_id = p_appointment_id;
end $$;

-- Called by the Edge Function with the USER's token before transcribing.
create or replace function public.start_recording_session(p_appointment_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_appt public.appointments;
  v_id   uuid;
begin
  select * into v_appt from public.appointments where id = p_appointment_id;
  if not found then
    raise exception 'Appointment not found';
  end if;
  if not coalesce(v_appt.patient_id = public.current_patient_id()
          or v_appt.clinician_id = public.current_clinician_id(), false) then
    raise exception 'Not a participant of this appointment' using errcode = '42501';
  end if;
  if v_appt.status not in ('checked_in', 'in_consultation') then
    raise exception 'Recording is only allowed during the consultation';
  end if;
  if not public.recording_allowed(p_appointment_id) then
    raise exception 'Both patient and clinician must consent before recording' using errcode = '42501';
  end if;

  insert into public.recording_sessions (appointment_id, started_by)
  values (p_appointment_id, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Called by the Edge Function with the SERVICE ROLE after transcription.
-- Returns null (and stores nothing) if consent was withdrawn meanwhile.
create or replace function public.save_transcript_draft(
  p_session_id        uuid,
  p_transcript_text   text,
  p_segments          jsonb default null,
  p_summary_text      text default null,
  p_language          text default 'en-AU',
  p_engine            text default null,
  p_engine_model      text default null,
  p_duration_seconds  integer default null,
  p_review_window     interval default interval '7 days'
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_session public.recording_sessions;
  v_id      uuid;
begin
  select * into v_session from public.recording_sessions where id = p_session_id for update;
  if not found or v_session.status <> 'started' then
    raise exception 'Recording session is not open';
  end if;

  if not public.recording_allowed(v_session.appointment_id) then
    update public.recording_sessions
       set status = 'consent_withdrawn', audio_discarded_at = now(), ended_at = now()
     where id = p_session_id;
    return null;
  end if;

  insert into public.consult_transcripts
    (recording_session_id, appointment_id, transcript_text, segments, summary_text,
     language, review_expires_at)
  values
    (p_session_id, v_session.appointment_id, p_transcript_text, p_segments, p_summary_text,
     coalesce(p_language, 'en-AU'), now() + p_review_window)
  returning id into v_id;

  update public.recording_sessions
     set status = 'awaiting_review', ended_at = now(), audio_discarded_at = now(),
         duration_seconds = p_duration_seconds, engine = p_engine, engine_model = p_engine_model
   where id = p_session_id;

  return v_id;
end $$;

create or replace function public.mark_recording_failed(p_session_id uuid, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.recording_sessions
     set status = 'failed', error_message = left(p_error, 1000),
         ended_at = now(), audio_discarded_at = now()
   where id = p_session_id and status = 'started'
$$;

-- Patient keeps the transcript.
create or replace function public.approve_transcript(p_transcript_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_t public.consult_transcripts;
begin
  select t.* into v_t
    from public.consult_transcripts t
    join public.appointments a on a.id = t.appointment_id
   where t.id = p_transcript_id
     and a.patient_id = public.current_patient_id()
   for update of t;
  if not found then
    raise exception 'Transcript not found' using errcode = '42501';
  end if;
  if v_t.status <> 'pending_patient_review' then
    raise exception 'Transcript is not awaiting review';
  end if;
  if v_t.review_expires_at < now() then
    raise exception 'Review window has expired';
  end if;

  update public.consult_transcripts
     set status = 'approved', approved_at = now()
   where id = p_transcript_id;
  update public.recording_sessions set status = 'approved' where id = v_t.recording_session_id;
end $$;

-- Patient discards the transcript: the text is deleted permanently.
create or replace function public.reject_transcript(p_transcript_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_t public.consult_transcripts;
begin
  select t.* into v_t
    from public.consult_transcripts t
    join public.appointments a on a.id = t.appointment_id
   where t.id = p_transcript_id
     and a.patient_id = public.current_patient_id()
   for update of t;
  if not found then
    raise exception 'Transcript not found' using errcode = '42501';
  end if;
  if v_t.status <> 'pending_patient_review' then
    raise exception 'Only transcripts awaiting review can be rejected';
  end if;

  delete from public.consult_transcripts where id = p_transcript_id;
  update public.recording_sessions set status = 'rejected' where id = v_t.recording_session_id;
end $$;

-- Deletes drafts the patient never reviewed, and closes abandoned sessions.
create or replace function public.purge_expired_transcripts()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  with gone as (
    delete from public.consult_transcripts
     where status = 'pending_patient_review' and review_expires_at < now()
    returning recording_session_id
  )
  update public.recording_sessions s
     set status = 'expired'
    from gone where s.id = gone.recording_session_id;
  get diagnostics n = row_count;

  update public.recording_sessions
     set status = 'failed', error_message = 'Abandoned: no transcript received',
         ended_at = now(), audio_discarded_at = coalesce(audio_discarded_at, now())
   where status = 'started' and started_at < now() - interval '3 hours';

  return n;
end $$;

-- Approved transcripts are read-only.
create or replace function public.consult_transcripts_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'approved'
     and (new.transcript_text is distinct from old.transcript_text
          or new.segments     is distinct from old.segments
          or new.summary_text is distinct from old.summary_text
          or new.status       is distinct from old.status) then
    raise exception 'Approved transcripts cannot be changed' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger consult_transcripts_before_update
  before update on public.consult_transcripts
  for each row execute function public.consult_transcripts_before_update();

-- =====================================================================
-- 20. RATINGS RULES AND SUMMARY
-- =====================================================================
create or replace function public.clinician_ratings_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_appt public.appointments;
begin
  if tg_op = 'INSERT' then
    select * into v_appt from public.appointments where id = new.appointment_id;
    if not found then
      raise exception 'Appointment not found';
    end if;
    new.patient_id   := v_appt.patient_id;      -- filled from the appointment, not the client
    new.clinician_id := v_appt.clinician_id;
    if not public.is_staff() then
      new.moderation_status := 'visible';
    end if;
  else
    if new.appointment_id is distinct from old.appointment_id
       or new.patient_id   is distinct from old.patient_id
       or new.clinician_id is distinct from old.clinician_id then
      raise exception 'Rating cannot be moved to another appointment';
    end if;
    if not public.is_staff() and new.moderation_status is distinct from old.moderation_status then
      raise exception 'Only staff can moderate ratings' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger clinician_ratings_before_write
  before insert or update on public.clinician_ratings
  for each row execute function public.clinician_ratings_before_write();

-- True if the current patient may rate this appointment now.
create or replace function public.can_rate_appointment(p_appointment_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.appointments a
     where a.id = p_appointment_id
       and a.patient_id = public.current_patient_id()
       and a.status = 'completed'
       and a.consult_ended_at > now() - interval '30 days')
$$;

-- Public aggregate (no patient data). Only 'visible' ratings count.
create or replace function public.get_clinician_rating_summary(p_clinician_id uuid default null)
returns table (
  clinician_id          uuid,
  rating_count          bigint,
  avg_rating            numeric,
  avg_communication     numeric,
  avg_wait_time         numeric,
  pct_would_recommend   numeric
) language sql stable security definer set search_path = '' as $$
  select r.clinician_id,
         count(*),
         round(avg(r.rating), 2),
         round(avg(r.rating_communication), 2),
         round(avg(r.rating_wait_time), 2),
         round(100.0 * avg(case when r.would_recommend then 1 when r.would_recommend is false then 0 end), 1)
    from public.clinician_ratings r
   where r.moderation_status = 'visible'
     and (p_clinician_id is null or r.clinician_id = p_clinician_id)
   group by r.clinician_id
$$;

-- A clinician's own ratings; patient name hidden when the rating is anonymous.
create or replace function public.get_my_ratings_as_clinician()
returns table (
  rating_id             uuid,
  appointment_id        uuid,
  visit_date            timestamptz,
  rating                smallint,
  rating_communication  smallint,
  rating_wait_time      smallint,
  would_recommend       boolean,
  comment               text,
  patient_display_name  text,
  created_at            timestamptz
) language sql stable security definer set search_path = '' as $$
  select r.id, r.appointment_id, a.scheduled_start, r.rating, r.rating_communication,
         r.rating_wait_time, r.would_recommend, r.comment,
         case when r.is_anonymous then null
              else coalesce(p.preferred_name, p.first_name) || ' ' || left(p.last_name, 1) || '.' end,
         r.created_at
    from public.clinician_ratings r
    join public.appointments a on a.id = r.appointment_id
    join public.patients p     on p.id = r.patient_id
   where r.clinician_id = public.current_clinician_id()
     and r.moderation_status = 'visible'
   order by a.scheduled_start desc
$$;

-- =====================================================================
-- 21. ROW LEVEL SECURITY
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'residency_statuses','insurance_providers','insurance_plans','patients',
    'patient_addresses','patient_residency','patient_insurance_policies',
    'facilities','facility_billing_policies','clinicians','clinician_qualifications',
    'clinician_registrations','clinician_affiliations','clinician_schedules',
    'schedule_exceptions','appointment_slots','appointments','appointment_status_history',
    'insurance_claims','recording_consents','recording_sessions','consult_transcripts',
    'clinician_ratings'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Directory / reference data: any signed-in user can read; staff manage.
do $$
declare t text;
begin
  foreach t in array array[
    'residency_statuses','insurance_providers','insurance_plans','facilities',
    'facility_billing_policies','clinicians','clinician_qualifications',
    'clinician_registrations','clinician_affiliations','clinician_schedules',
    'appointment_slots'
  ] loop
    execute format('create policy "read: signed-in users" on public.%I
                      for select to authenticated using (true)', t);
    execute format('create policy "write: staff" on public.%I
                      for all to authenticated
                      using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

-- Clinicians can edit their own profile.
create policy "update: own clinician profile" on public.clinicians
  for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

-- Schedule exceptions: reasons are private to the clinician and staff.
create policy "read: own or staff" on public.schedule_exceptions
  for select to authenticated
  using ((select public.is_staff()) or clinician_id = (select public.current_clinician_id()));
create policy "write: own or staff" on public.schedule_exceptions
  for all to authenticated
  using ((select public.is_staff()) or clinician_id = (select public.current_clinician_id()))
  with check ((select public.is_staff()) or clinician_id = (select public.current_clinician_id()));

-- Patients: self, staff, or clinicians who have an appointment with them.
create policy "read: self, staff, treating clinician" on public.patients
  for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or (select public.is_staff())
    or exists (select 1 from public.appointments a
                where a.patient_id = patients.id
                  and a.clinician_id = (select public.current_clinician_id()))
  );
create policy "insert: self or staff" on public.patients
  for insert to authenticated
  with check (auth_user_id = (select auth.uid()) or (select public.is_staff()));
create policy "update: self or staff" on public.patients
  for update to authenticated
  using (auth_user_id = (select auth.uid()) or (select public.is_staff()))
  with check (auth_user_id = (select auth.uid()) or (select public.is_staff()));

-- Patient-owned history: patient reads/adds/edits own; staff everything.
do $$
declare t text;
begin
  foreach t in array array['patient_addresses','patient_residency','patient_insurance_policies'] loop
    execute format('create policy "read: own or staff" on public.%I for select to authenticated
       using (patient_id = (select public.current_patient_id()) or (select public.is_staff()))', t);
    execute format('create policy "insert: own or staff" on public.%I for insert to authenticated
       with check (patient_id = (select public.current_patient_id()) or (select public.is_staff()))', t);
    execute format('create policy "update: own or staff" on public.%I for update to authenticated
       using (patient_id = (select public.current_patient_id()) or (select public.is_staff()))
       with check (patient_id = (select public.current_patient_id()) or (select public.is_staff()))', t);
    execute format('create policy "delete: staff" on public.%I for delete to authenticated
       using ((select public.is_staff()))', t);
  end loop;
end $$;

-- Appointments: created only through book_slot(). Patients read own;
-- clinicians read/update their own; staff everything.
create policy "read: patient, clinician, staff" on public.appointments
  for select to authenticated
  using (
    patient_id = (select public.current_patient_id())
    or clinician_id = (select public.current_clinician_id())
    or (select public.is_staff())
  );
create policy "update: clinician or staff" on public.appointments
  for update to authenticated
  using (clinician_id = (select public.current_clinician_id()) or (select public.is_staff()))
  with check (clinician_id = (select public.current_clinician_id()) or (select public.is_staff()));

-- Child rows follow the visibility of their appointment (appointments RLS applies).
create policy "read: via appointment" on public.appointment_status_history
  for select to authenticated
  using (exists (select 1 from public.appointments a where a.id = appointment_id));

create policy "read: via appointment" on public.recording_consents
  for select to authenticated
  using (exists (select 1 from public.appointments a where a.id = appointment_id));

create policy "read: via appointment" on public.recording_sessions
  for select to authenticated
  using (exists (select 1 from public.appointments a where a.id = appointment_id));

-- Claims: patient reads own; staff manage.
create policy "read: patient or staff" on public.insurance_claims
  for select to authenticated
  using (
    (select public.is_staff())
    or exists (select 1 from public.appointments a
                where a.id = appointment_id
                  and a.patient_id = (select public.current_patient_id()))
  );
create policy "write: staff" on public.insurance_claims
  for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- Transcripts: patient sees drafts and approved; clinician sees approved only.
-- No direct writes: use approve_transcript() / reject_transcript().
create policy "read: patient (all) or clinician (approved)" on public.consult_transcripts
  for select to authenticated
  using (
    exists (select 1 from public.appointments a
             where a.id = appointment_id
               and (a.patient_id = (select public.current_patient_id())
                    or (a.clinician_id = (select public.current_clinician_id())
                        and consult_transcripts.status = 'approved')))
  );

-- Ratings: patient writes own for completed visits within 30 days.
-- Clinicians use get_my_ratings_as_clinician(); everyone can use the summary.
create policy "read: own or staff" on public.clinician_ratings
  for select to authenticated
  using (patient_id = (select public.current_patient_id()) or (select public.is_staff()));
create policy "insert: patient for completed visit" on public.clinician_ratings
  for insert to authenticated
  with check (public.can_rate_appointment(appointment_id)
              and patient_id = (select public.current_patient_id()));
create policy "update: own within 30 days, or staff" on public.clinician_ratings
  for update to authenticated
  using ((select public.is_staff())
         or (patient_id = (select public.current_patient_id())
             and created_at > now() - interval '30 days'))
  with check ((select public.is_staff()) or patient_id = (select public.current_patient_id()));
create policy "delete: staff" on public.clinician_ratings
  for delete to authenticated
  using ((select public.is_staff()));

-- =====================================================================
-- 22. FUNCTION PERMISSIONS
-- =====================================================================
-- Nothing for anonymous users.
revoke all on all functions in schema public from public, anon;

-- Internal / job-only functions: service role (and pg_cron) only.
revoke execute on function
  public._book_slot(uuid, uuid, public.booking_channel, text, text),
  public.generate_slots(date, date),
  public.sync_slot_blocks(uuid),
  public.release_expired_holds(),
  public.mark_no_shows(interval),
  public.save_transcript_draft(uuid, text, jsonb, text, text, text, text, integer, interval),
  public.mark_recording_failed(uuid, text),
  public.purge_expired_transcripts()
from authenticated;

grant execute on function
  public._book_slot(uuid, uuid, public.booking_channel, text, text),
  public.generate_slots(date, date),
  public.sync_slot_blocks(uuid),
  public.release_expired_holds(),
  public.mark_no_shows(interval),
  public.save_transcript_draft(uuid, text, jsonb, text, text, text, text, integer, interval),
  public.mark_recording_failed(uuid, text),
  public.purge_expired_transcripts()
to service_role;

-- App-facing functions.
grant execute on function
  public.is_staff(),
  public.current_patient_id(),
  public.current_clinician_id(),
  public.policy_on(uuid, date),
  public.affiliation_on(uuid, uuid, date),
  public.facility_local_date(uuid, timestamptz),
  public.hold_slot(uuid),
  public.book_slot(uuid, text, text, public.booking_channel, uuid),
  public.cancel_appointment(uuid, text),
  public.reschedule_appointment(uuid, uuid),
  public.get_available_slots(date, uuid, uuid, public.clinician_type),
  public.give_recording_consent(uuid, text, public.consent_method),
  public.recording_allowed(uuid),
  public.withdraw_recording_consent(uuid, text),
  public.start_recording_session(uuid),
  public.approve_transcript(uuid),
  public.reject_transcript(uuid),
  public.can_rate_appointment(uuid),
  public.get_clinician_rating_summary(uuid),
  public.get_my_ratings_as_clinician()
to authenticated, service_role;

-- No anonymous table access at all (health data).
revoke all on all tables in schema public from anon;

-- =====================================================================
-- 23. REALTIME: slot changes are pushed to clients instantly
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.appointment_slots;
  end if;
end $$;

-- =====================================================================
-- 24. SCHEDULED JOBS (pg_cron). Times are UTC; 16:00 UTC = 02:00 Brisbane.
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('release-expired-slot-holds', '* * * * *',
                          $job$select public.release_expired_holds()$job$);
    perform cron.schedule('mark-no-shows', '*/10 * * * *',
                          $job$select public.mark_no_shows()$job$);
    perform cron.schedule('generate-slots-8-weeks', '0 16 * * *',
                          $job$select public.generate_slots(current_date, current_date + 56)$job$);
    perform cron.schedule('purge-expired-transcripts', '15 * * * *',
                          $job$select public.purge_expired_transcripts()$job$);
  else
    raise notice 'pg_cron not available: enable it in the Supabase dashboard and re-run section 24';
  end if;
end $$;
