-- =====================================================================
-- Part B (web app): live sync, patient self check-in, the patient's own
-- GP questions, and an agent activity summary for staff.
--
-- Run after every earlier migration (including the agent layer,
-- 20261027000000 to 20261028100000). Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Realtime: appointment status, consents, recording state and GP
--    questions update instantly. Realtime applies each table's RLS.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['appointments', 'recording_consents', 'recording_sessions', 'gp_queries'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 2. Patient self check-in ("I've arrived"): the patient of the
--    appointment only, from 30 minutes before to 15 minutes after the
--    start. The appointments trigger records the arrival time.
-- ---------------------------------------------------------------------
create or replace function public.patient_check_in(p_appointment_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_a public.appointments;
begin
  select * into v_a from public.appointments where id = p_appointment_id for update;
  if not found or v_a.patient_id is distinct from public.current_patient_id() then
    raise exception 'Appointment not found' using errcode = 'P0002';
  end if;
  if v_a.status not in ('booked', 'confirmed') then
    raise exception 'Only a booked appointment can be checked in' using errcode = '23514';
  end if;
  if now() < v_a.scheduled_start - interval '30 minutes'
     or now() > v_a.scheduled_start + interval '15 minutes' then
    raise exception 'Self check-in opens 30 minutes before the appointment and closes 15 minutes after it starts'
      using errcode = '23514';
  end if;
  update public.appointments set status = 'checked_in' where id = v_a.id;
end $$;

revoke all on function public.patient_check_in(uuid) from public, anon, service_role;
grant execute on function public.patient_check_in(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Patients read the GP questions they approved, and the answers.
--    (Writes stay with the agent service and answer_gp_query.)
-- ---------------------------------------------------------------------
drop policy if exists "read: the appointment's patient" on public.gp_queries;
create policy "read: the appointment's patient" on public.gp_queries
  for select to authenticated
  using (exists (select 1 from public.appointments a
                  where a.id = appointment_id
                    and a.patient_id = (select public.current_patient_id())));

-- ---------------------------------------------------------------------
-- 4. Agent activity for the staff operations page. Counts and latency
--    only: no patient, user or appointment ids, and never any text.
-- ---------------------------------------------------------------------
create or replace function public.get_agent_activity(p_hours integer default 24)
returns table (
  agent_id        text,
  server          text,
  tool            text,
  calls           bigint,
  errors          bigint,
  avg_latency_ms  integer,
  p95_latency_ms  integer,
  last_call_at    timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can view agent activity' using errcode = '42501';
  end if;
  return query
    select l.agent_id, l.server, l.tool,
           count(*)::bigint,
           count(*) filter (where not l.ok)::bigint,
           round(avg(l.latency_ms))::integer,
           round(percentile_cont(0.95) within group (order by l.latency_ms))::integer,
           max(l.created_at)
      from public.agent_access_log l
     where l.created_at >= now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)))
     group by l.agent_id, l.server, l.tool
     order by count(*) desc;
end $$;

create or replace function public.get_engine_activity(p_hours integer default 24)
returns table (
  engine          text,
  model           text,
  calls           bigint,
  avg_latency_ms  integer,
  last_call_at    timestamptz
) language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.is_staff(), false) then
    raise exception 'Only staff can view agent activity' using errcode = '42501';
  end if;
  return query
    select d.engine, d.model,
           count(*)::bigint,
           round(avg(d.latency_ms))::integer,
           max(d.created_at)
      from public.decision_log d
     where d.created_at >= now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 720)))
     group by d.engine, d.model
     order by count(*) desc;
end $$;

revoke all on function public.get_agent_activity(integer), public.get_engine_activity(integer)
  from public, anon, service_role;
grant execute on function public.get_agent_activity(integer), public.get_engine_activity(integer)
  to authenticated;

commit;
