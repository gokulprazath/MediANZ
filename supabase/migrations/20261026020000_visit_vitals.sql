-- =====================================================================
-- Vital signs recorded during a visit.
-- Run after:
--   20261026000000_health_booking_schema.sql
--   20261026010000_security_advisor_fixes.sql
--
-- One row = one set of measurements taken at a point in time.
-- A visit can have several rows (e.g. blood pressure re-checked later).
-- Every field is optional, but each row must contain at least one reading.
--
-- Units:
--   temperature_c     degrees Celsius
--   spo2_percent      blood oxygen saturation, %
--   bp_systolic/diastolic  mmHg
--   height_cm         centimetres
--   weight_kg         kilograms
--   bmi               calculated automatically when height and weight are present
-- =====================================================================

create table public.visit_vitals (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  patient_id      uuid not null references public.patients(id),   -- filled from the appointment

  temperature_c   numeric(4,1) check (temperature_c between 30 and 45),
  spo2_percent    smallint     check (spo2_percent between 50 and 100),
  bp_systolic     smallint     check (bp_systolic between 50 and 300),
  bp_diastolic    smallint     check (bp_diastolic between 20 and 200),
  height_cm       numeric(5,1) check (height_cm between 30 and 250),
  weight_kg       numeric(5,1) check (weight_kg between 0.5 and 400),
  bmi             numeric(4,1) generated always as (
                    case when height_cm is not null and weight_kg is not null
                         then round(weight_kg / ((height_cm / 100.0) * (height_cm / 100.0)), 1) end
                  ) stored,

  notes           text check (char_length(notes) <= 1000),   -- e.g. 'BP re-checked after 5 min rest'
  recorded_at     timestamptz not null default now(),
  recorded_by     uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Blood pressure is entered as a pair
  check ((bp_systolic is null) = (bp_diastolic is null)),
  check (bp_systolic is null or bp_systolic > bp_diastolic),
  -- At least one measurement per row
  check (num_nonnulls(temperature_c, spo2_percent, bp_systolic, height_cm, weight_kg) > 0)
);

create index visit_vitals_appointment_idx on public.visit_vitals (appointment_id, recorded_at);
create index visit_vitals_patient_idx     on public.visit_vitals (patient_id, recorded_at desc);

create trigger set_updated_at before update on public.visit_vitals
  for each row execute function public.set_updated_at();

-- Fill patient_id from the appointment and only allow readings for visits
-- that are under way or finished.
create or replace function public.visit_vitals_before_write()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_appt public.appointments;
begin
  select * into v_appt from public.appointments where id = new.appointment_id;
  if not found then
    raise exception 'Appointment not found';
  end if;

  if tg_op = 'INSERT' then
    if v_appt.status not in ('checked_in', 'in_consultation', 'completed') then
      raise exception 'Vitals can only be recorded once the patient has checked in (status is %)', v_appt.status
        using errcode = '23514';
    end if;
  elsif new.appointment_id is distinct from old.appointment_id then
    raise exception 'Vitals cannot be moved to another appointment' using errcode = '23514';
  end if;

  new.patient_id := v_appt.patient_id;
  return new;
end $$;

create trigger visit_vitals_before_write
  before insert or update on public.visit_vitals
  for each row execute function public.visit_vitals_before_write();

revoke execute on function public.visit_vitals_before_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
--   Patient:   reads own vitals
--   Clinician: reads and records vitals for their own appointments
--   Staff:     reads and records all (e.g. a practice nurse at reception)
--   Deleting:  staff only (corrections should normally be an update)
-- ---------------------------------------------------------------------
alter table public.visit_vitals enable row level security;
revoke all on public.visit_vitals from anon;

create policy "read: patient, clinician, staff" on public.visit_vitals
  for select to authenticated
  using (
    patient_id = (select public.current_patient_id())
    or (select public.is_staff())
    or exists (select 1 from public.appointments a
                where a.id = appointment_id
                  and a.clinician_id = (select public.current_clinician_id()))
  );

create policy "insert: clinician of visit or staff" on public.visit_vitals
  for insert to authenticated
  with check (
    (select public.is_staff())
    or exists (select 1 from public.appointments a
                where a.id = appointment_id
                  and a.clinician_id = (select public.current_clinician_id()))
  );

create policy "update: clinician of visit or staff" on public.visit_vitals
  for update to authenticated
  using (
    (select public.is_staff())
    or exists (select 1 from public.appointments a
                where a.id = appointment_id
                  and a.clinician_id = (select public.current_clinician_id()))
  )
  with check (
    (select public.is_staff())
    or exists (select 1 from public.appointments a
                where a.id = appointment_id
                  and a.clinician_id = (select public.current_clinician_id()))
  );

create policy "delete: staff" on public.visit_vitals
  for delete to authenticated
  using ((select public.is_staff()));

-- ---------------------------------------------------------------------
-- Convenience view: the latest value of each measurement per visit.
-- security_invoker = on means the table's RLS rules above still apply.
-- ---------------------------------------------------------------------
create or replace view public.visit_vitals_latest
with (security_invoker = on) as
select
  a.id as appointment_id,
  a.patient_id,
  a.scheduled_start as visit_start,
  (select v.temperature_c from public.visit_vitals v where v.appointment_id = a.id and v.temperature_c is not null order by v.recorded_at desc limit 1) as temperature_c,
  (select v.spo2_percent  from public.visit_vitals v where v.appointment_id = a.id and v.spo2_percent  is not null order by v.recorded_at desc limit 1) as spo2_percent,
  (select v.bp_systolic   from public.visit_vitals v where v.appointment_id = a.id and v.bp_systolic   is not null order by v.recorded_at desc limit 1) as bp_systolic,
  (select v.bp_diastolic  from public.visit_vitals v where v.appointment_id = a.id and v.bp_systolic   is not null order by v.recorded_at desc limit 1) as bp_diastolic,
  (select v.height_cm     from public.visit_vitals v where v.appointment_id = a.id and v.height_cm     is not null order by v.recorded_at desc limit 1) as height_cm,
  (select v.weight_kg     from public.visit_vitals v where v.appointment_id = a.id and v.weight_kg     is not null order by v.recorded_at desc limit 1) as weight_kg,
  (select v.bmi           from public.visit_vitals v where v.appointment_id = a.id and v.bmi           is not null order by v.recorded_at desc limit 1) as bmi,
  (select max(v.recorded_at) from public.visit_vitals v where v.appointment_id = a.id) as last_recorded_at
from public.appointments a
where exists (select 1 from public.visit_vitals v where v.appointment_id = a.id);

revoke all on public.visit_vitals_latest from anon;
grant select on public.visit_vitals_latest to authenticated;
