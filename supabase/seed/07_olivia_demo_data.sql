-- =====================================================================
-- More sample data for Olivia Brown, for demos and evaluators.
-- Run in the SQL Editor after seeds 01-06 and every migration.
--
-- Adds (all with Dr Asha Rao, at Southbank Family Medical unless noted):
--   * two more past visits with vitals and ratings: a post-viral cough
--     (about 200 days ago, at Paddington GP Clinic, where Dr Rao worked
--     until 90 days ago) and a fatigue visit 35 days ago where blood tests
--     were ordered;
--   * an approved transcript of the fatigue visit (both consents, v2).
--     Approving queues it for the consult-notes worker, which drafts AI
--     facts and key points for Dr Rao's review queue;
--   * an answered question from Olivia about her iron supplement;
--   * a booked review ("Repeat iron studies review") about two weeks out;
--   * a visit that is CHECKED IN NOW, with Olivia's recording consent, so
--     Dr Rao can consent and record straight away (Calendar -> today, or
--     the patient's "Live" page). Booked or confirmed visits that are not
--     checked in become no-shows 30 minutes after they start (pg_cron
--     mark-no-shows); a checked-in visit stays open until it is completed.
--
-- Safe to re-run: the past rows have fixed ids and are skipped when they
-- exist; a new checked-in visit is only created when Olivia has no visit
-- checked in or in consultation, so re-run it before a demo for a fresh
-- one. Nothing is updated or deleted except the new visit's own status.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Past visits (inserted with realistic timestamps; history by hand)
-- ---------------------------------------------------------------------
alter table public.appointments disable trigger appointments_after_write;

do $$
declare
  r          record;
  v_tz       text;
  v_day      date;
  v_start    timestamptz;
  v_end      timestamptz;
  v_booked   timestamptz;
  v_checkin  timestamptz;
  v_cstart   timestamptz;
  v_cend     timestamptz;
  v_reminder timestamptz;
begin
  for r in
    select v.id::uuid as id, v.slot_id::uuid as slot_id, v.facility_id::uuid as facility_id, v.day_off::int as day_off,
           v.start_time::time as start_time, v.mins::int as mins, v.late_min::int as late_min,
           v.wait_min::int as wait_min, v.consult_min::int as consult_min, v.reason, v.fee::numeric as fee,
           v.rebate::numeric as rebate, v.gap::numeric as gap, v.notes, v.booked_days_before::int as booked_days_before,
           v.channel::public.booking_channel as channel
    from (values
      -- id, slot, facility, day offset, start, minutes, arrival (min vs start), consult start, consult length,
      -- reason, fee, rebate, gap, notes, booked N days before, channel
      ('60000000-0000-4000-8000-000000000201','61000000-0000-4000-8000-000000000201','30000000-0000-4000-8000-000000000002', -200,'10:00',15, -6, 3, 11,
        'Cough that will not go away after a cold', 95, 43.90, 51.10,
        'Post-viral cough for 3 weeks, chest clear, afebrile. Honey and steam; return if not settling in 3 weeks.', 2, 'web'),
      ('60000000-0000-4000-8000-000000000202','61000000-0000-4000-8000-000000000202','30000000-0000-4000-8000-000000000001', -35,'09:15',15, -4, 5, 13,
        'Tiredness and low energy for a month', 90, 43.90, 46.10,
        'Four weeks of fatigue, heavier periods, occasional postural dizziness. Ordered FBC, iron studies, TSH, B12 and folate (fasting). Review in 2 weeks.', 4, 'mobile')
    ) as v(id, slot_id, facility_id, day_off, start_time, mins, late_min, wait_min, consult_min, reason, fee, rebate, gap, notes,
           booked_days_before, channel)
    where not exists (select 1 from public.appointments a where a.id = v.id::uuid)
  loop
    select timezone into v_tz from public.facilities where id = r.facility_id;
    v_day := current_date + r.day_off;
    v_day := v_day - greatest(extract(isodow from v_day)::int - 5, 0);  -- weekdays only

    v_start    := (v_day + r.start_time) at time zone v_tz;
    v_end      := v_start + make_interval(mins => r.mins);
    v_booked   := v_start - make_interval(days => r.booked_days_before) - interval '3 hours';
    v_reminder := v_start - interval '1 day';
    v_checkin  := v_start + make_interval(mins => r.late_min);
    v_cstart   := v_start + make_interval(mins => r.wait_min);
    v_cend     := v_cstart + make_interval(mins => r.consult_min);

    insert into public.appointment_slots (id, clinician_id, facility_id, starts_at, ends_at, status, created_at)
    values (r.slot_id, '40000000-0000-4000-8000-000000000001', r.facility_id,
            v_start, v_end, 'booked', v_start - interval '60 days');

    insert into public.appointments (
      id, slot_id, patient_id, clinician_id, facility_id,
      clinician_affiliation_id, patient_insurance_policy_id,
      scheduled_start, scheduled_end, status, visit_type, reason,
      booking_channel, booked_at, confirmed_at, reminder_sent_at,
      checked_in_at, consult_started_at, consult_ended_at,
      clinical_notes, fee_charged, medicare_rebate, gap_amount, created_at)
    values (
      r.id, r.slot_id, '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
      r.facility_id,
      public.affiliation_on('40000000-0000-4000-8000-000000000001', r.facility_id, v_day),
      public.policy_on('50000000-0000-4000-8000-000000000001', v_day),
      v_start, v_end, 'completed', 'standard', r.reason,
      r.channel, v_booked, v_reminder + interval '2 hours', v_reminder,
      v_checkin, v_cstart, v_cend,
      r.notes, r.fee, r.rebate, r.gap, v_booked);

    insert into public.appointment_status_history (appointment_id, from_status, to_status, changed_at, changed_by) values
      (r.id, null,              'booked',          v_booked,                       null),
      (r.id, 'booked',          'confirmed',       v_reminder + interval '2 hours', null),
      (r.id, 'confirmed',       'checked_in',      v_checkin,                      null),
      (r.id, 'checked_in',      'in_consultation', v_cstart,                       null),
      (r.id, 'in_consultation', 'completed',       v_cend,                         null);
  end loop;
end $$;

alter table public.appointments enable trigger appointments_after_write;

-- Vital signs, a few minutes after check-in.
insert into public.visit_vitals
  (appointment_id, temperature_c, spo2_percent, bp_systolic, bp_diastolic, height_cm, weight_kg, notes, recorded_at)
select a.id, v.temp, v.spo2, v.sys, v.dia, 167.0, v.weight, v.notes, a.checked_in_at + make_interval(mins => v.mins)
  from (values
    ('60000000-0000-4000-8000-000000000201', 36.9, 98, 114, 72, 64.8, 'Dry cough, chest clear', 3),
    ('60000000-0000-4000-8000-000000000202', 36.6, 98, 108, 68, 63.1, 'Lying 112/70, standing 104/66', 4)
  ) as v(appointment_id, temp, spo2, sys, dia, weight, notes, mins)
  join public.appointments a on a.id = v.appointment_id::uuid
 where not exists (select 1 from public.visit_vitals x where x.appointment_id = a.id);

-- Ratings (Olivia's last visit, ...0002, keeps the one from seed 01).
insert into public.clinician_ratings
  (appointment_id, patient_id, clinician_id, rating, rating_communication, rating_wait_time, would_recommend, comment, is_anonymous, moderation_status, created_at)
select a.id, a.patient_id, a.clinician_id, v.rating, v.comm, v.wait, true, v.comment, false, 'visible',
       a.consult_ended_at + make_interval(hours => v.hours_after)
  from (values
    ('60000000-0000-4000-8000-000000000201', 5, 5, 5, 'Seen on time and reassured that my cough would settle. It did.', 6),
    ('60000000-0000-4000-8000-000000000202', 5, 5, 4, 'Dr Rao took my tiredness seriously and explained every blood test she ordered.', 3)
  ) as v(appointment_id, rating, comm, wait, comment, hours_after)
  join public.appointments a on a.id = v.appointment_id::uuid
 where not exists (select 1 from public.clinician_ratings x where x.appointment_id = a.id);

-- ---------------------------------------------------------------------
-- 2. Approved transcript of the fatigue visit (...0202)
-- ---------------------------------------------------------------------
insert into public.recording_consents
  (appointment_id, party, patient_id, clinician_id, consent_given, consent_text_version, method, given_at)
select a.id, v.party::public.consent_party,
       case when v.party = 'patient' then a.patient_id end,
       case when v.party = 'clinician' then a.clinician_id end,
       true, 'v2', 'in_app', a.consult_started_at - make_interval(mins => v.mins_before)
  from public.appointments a
 cross join (values ('patient', 2), ('clinician', 1)) as v(party, mins_before)
 where a.id = '60000000-0000-4000-8000-000000000202'
on conflict (appointment_id, party) do nothing;

insert into public.recording_sessions
  (id, appointment_id, started_by, started_at, ended_at, duration_seconds, engine, engine_model, status, audio_discarded_at)
select '70000000-0000-4000-8000-000000000201', a.id,
       coalesce(c.auth_user_id, c.id),
       a.consult_started_at + interval '1 minute', a.consult_ended_at, 690,
       'sample-stt', 'stt-medical-v2', 'approved', a.consult_ended_at + interval '1 minute'
  from public.appointments a
  join public.clinicians c on c.id = a.clinician_id
 where a.id = '60000000-0000-4000-8000-000000000202'
on conflict (id) do nothing;

insert into public.consult_transcripts
  (id, recording_session_id, appointment_id, transcript_text, segments, summary_text, language, status, review_expires_at, approved_at, created_at)
select '71000000-0000-4000-8000-000000000201', '70000000-0000-4000-8000-000000000201', a.id,
  'Dr Rao: Hi Olivia, what brings you in today? '
  || 'Olivia: I have been really tired for about a month. I sleep eight hours and still wake up exhausted. '
  || 'Dr Rao: Any other changes, like your weight, your mood or your periods? '
  || 'Olivia: My periods have been heavier for the last few months. My mood is fine and my weight is about the same. '
  || 'Dr Rao: Do you get short of breath, or dizzy when you stand up? '
  || 'Olivia: A bit dizzy sometimes when I stand up quickly, but no chest pain and no trouble breathing. '
  || 'Dr Rao: Heavier periods can lower your iron, so I would like to check a full blood count, iron studies, thyroid, B12 and folate. '
  || 'Dr Rao: It is a fasting test, so go in the morning before breakfast, and book a follow-up in about two weeks so we can go through the results together. '
  || 'Olivia: Should I start an iron tablet now? '
  || 'Dr Rao: Let us wait for the results so we treat the right thing. Do you smoke at all? '
  || 'Olivia: No, I have never smoked.',
  '[{"speaker":"clinician","start_sec":0,"end_sec":4,"text":"Hi Olivia, what brings you in today?"},
    {"speaker":"patient","start_sec":4,"end_sec":12,"text":"I have been really tired for about a month. I sleep eight hours and still wake up exhausted."},
    {"speaker":"clinician","start_sec":12,"end_sec":17,"text":"Any other changes, like your weight, your mood or your periods?"},
    {"speaker":"patient","start_sec":17,"end_sec":25,"text":"My periods have been heavier for the last few months. My mood is fine and my weight is about the same."},
    {"speaker":"clinician","start_sec":25,"end_sec":30,"text":"Do you get short of breath, or dizzy when you stand up?"},
    {"speaker":"patient","start_sec":30,"end_sec":37,"text":"A bit dizzy sometimes when I stand up quickly, but no chest pain and no trouble breathing."},
    {"speaker":"clinician","start_sec":37,"end_sec":48,"text":"Heavier periods can lower your iron, so I would like to check a full blood count, iron studies, thyroid, B12 and folate."},
    {"speaker":"clinician","start_sec":48,"end_sec":60,"text":"It is a fasting test, so go in the morning before breakfast, and book a follow-up in about two weeks so we can go through the results together."},
    {"speaker":"patient","start_sec":60,"end_sec":63,"text":"Should I start an iron tablet now?"},
    {"speaker":"clinician","start_sec":63,"end_sec":69,"text":"Let us wait for the results so we treat the right thing. Do you smoke at all?"},
    {"speaker":"patient","start_sec":69,"end_sec":71,"text":"No, I have never smoked."}]'::jsonb,
  'Four weeks of fatigue with heavier periods and occasional dizziness on standing; no chest pain or breathlessness. '
  || 'Fasting bloods ordered: full blood count, iron studies, thyroid, B12, folate. Review results in two weeks. Never smoked.',
  'en-AU', 'approved', a.consult_ended_at + interval '7 days', a.consult_ended_at + interval '5 hours', a.consult_ended_at + interval '2 minutes'
  from public.appointments a
 where a.id = '60000000-0000-4000-8000-000000000202'
on conflict (id) do nothing;

-- Segments for the agents (no-op if already built).
select public.build_transcript_segments('71000000-0000-4000-8000-000000000201');

-- ---------------------------------------------------------------------
-- 3. A question Olivia asked after her last visit, answered by Dr Rao
-- ---------------------------------------------------------------------
insert into public.gp_queries
  (id, appointment_id, question, status, answer, answered_by, answered_at, idempotency_key, created_by_agent, created_at)
select '84000000-0000-4000-8000-000000000201', a.id,
       'Is it normal for the iron tablets to make my stools very dark?',
       'answered',
       'Yes. Dark or black stools are a common and harmless effect of iron tablets. If you notice red blood, '
       || 'bad stomach pain or vomiting, call the clinic or get care straight away. Dr Rao',
       c.auth_user_id, a.consult_ended_at + interval '2 days', 'seed07-olivia-iron-stools', 'insights-writer',
       a.consult_ended_at + interval '1 day'
  from public.appointments a
  join public.clinicians c on c.id = a.clinician_id
 where a.id = '60000000-0000-4000-8000-000000000002'
   and c.auth_user_id is not null  -- answered_by is the clinician's login (seed 02)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 4. Upcoming review in about two weeks (through the real booking function)
-- ---------------------------------------------------------------------
do $$
declare
  v_slot uuid;
begin
  if exists (select 1 from public.appointments
              where patient_id = '50000000-0000-4000-8000-000000000001'
                and reason = 'Repeat iron studies review'
                and status in ('booked', 'confirmed')) then
    return;
  end if;
  select s.id into v_slot
    from public.appointment_slots s
   where s.clinician_id = '40000000-0000-4000-8000-000000000001'
     and s.facility_id  = '30000000-0000-4000-8000-000000000001'
     and s.status = 'available'
     and s.starts_at >= (current_date + 14 + time '09:00') at time zone 'Australia/Brisbane'
   order by s.starts_at
   limit 1;
  if v_slot is not null then
    perform public._book_slot(v_slot, '50000000-0000-4000-8000-000000000001', 'mobile', 'Repeat iron studies review', 'standard');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. A visit checked in now, ready to record
-- ---------------------------------------------------------------------
do $$
declare
  v_rao      constant uuid := '40000000-0000-4000-8000-000000000001';
  v_southbnk constant uuid := '30000000-0000-4000-8000-000000000001';
  v_olivia   constant uuid := '50000000-0000-4000-8000-000000000001';
  v_slot     uuid;
  v_start    timestamptz;
  v_appt     uuid;
begin
  if exists (select 1 from public.appointments
              where patient_id = v_olivia and status in ('checked_in', 'in_consultation')) then
    return;  -- one is already open
  end if;

  -- A free slot of Dr Rao's in the next hour, else a new 15-minute slot at the
  -- next free 5-minute mark (outside her usual hours, e.g. for evening demos).
  select s.id into v_slot
    from public.appointment_slots s
   where s.clinician_id = v_rao and s.facility_id = v_southbnk and s.status = 'available'
     and s.starts_at > now() and s.starts_at < now() + interval '1 hour'
   order by s.starts_at
   limit 1;

  if v_slot is null then
    v_start := date_trunc('hour', now())
               + make_interval(mins => (ceil(extract(minute from now()) / 5) * 5)::int + 5);
    while exists (select 1 from public.appointment_slots s
                   where s.clinician_id = v_rao
                     and s.starts_at < v_start + interval '15 minutes'
                     and s.ends_at > v_start) loop
      v_start := v_start + interval '15 minutes';
    end loop;
    insert into public.appointment_slots (clinician_id, facility_id, starts_at, ends_at, status)
    values (v_rao, v_southbnk, v_start, v_start + interval '15 minutes', 'available')
    returning id into v_slot;
  end if;

  v_appt := public._book_slot(v_slot, v_olivia, 'mobile', 'Upset stomach since starting the iron supplement', 'standard');
  update public.appointments set status = 'checked_in' where id = v_appt;

  -- Olivia consented on arrival; Dr Rao consents in the consult panel, then records.
  insert into public.recording_consents
    (appointment_id, party, patient_id, consent_given, consent_text_version, method, given_at)
  values (v_appt, 'patient', v_olivia, true, 'v2', 'in_app', now())
  on conflict (appointment_id, party) do nothing;
end $$;

commit;

-- ---------------------------------------------------------------------
-- Olivia's visits now
-- ---------------------------------------------------------------------
select a.id, a.status, (a.scheduled_start at time zone 'Australia/Brisbane')::timestamp(0) as local_start,
       c.last_name as clinician, a.reason,
       (select count(*) from public.consult_transcripts t where t.appointment_id = a.id and t.status = 'approved') as approved_transcripts
  from public.appointments a
  join public.clinicians c on c.id = a.clinician_id
 where a.patient_id = '50000000-0000-4000-8000-000000000001'
 order by a.scheduled_start;
