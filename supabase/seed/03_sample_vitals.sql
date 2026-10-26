-- =====================================================================
-- Sample vital signs for the past visits in 01_sample_data.sql.
-- Run ONCE in the SQL Editor, after 20261026020000_visit_vitals.sql.
-- Readings are taken a few minutes after each patient checked in.
-- =====================================================================
begin;

insert into public.visit_vitals
  (appointment_id, temperature_c, spo2_percent, bp_systolic, bp_diastolic, height_cm, weight_kg, notes, recorded_at)
select a.id, v.temp, v.spo2, v.sys, v.dia, v.height, v.weight, v.notes,
       a.checked_in_at + make_interval(mins => v.mins_after_checkin)
  from (values
    -- appointment,                             temp, spo2, sys, dia, height, weight, notes, minutes after check-in
    ('60000000-0000-4000-8000-000000000001', 36.6,  99, 118,  76, 167.0, 64.2, null, 3),                                   -- Olivia, annual check
    ('60000000-0000-4000-8000-000000000013', 36.5,  98, 120,  78, 167.0, 63.5, null, 2),                                   -- Olivia, cervical screening
    ('60000000-0000-4000-8000-000000000002', 36.7,  98, 116,  74, 167.0, 62.8, 'Reports tiredness', 4),                     -- Olivia, blood results
    ('60000000-0000-4000-8000-000000000003', 36.8,  97, 142,  91, 181.0, 94.6, 'BP elevated, patient in pain', 5),         -- Jack, back pain
    ('60000000-0000-4000-8000-000000000005', 38.4,  97, 112,  70, 158.5, 52.1, 'Febrile', 2),                              -- Priya, sore throat
    ('60000000-0000-4000-8000-000000000006', 36.6,  99, 110,  68, 158.5, 52.8, null, 3),                                   -- Priya, rash
    ('60000000-0000-4000-8000-000000000008', 36.5,  98, 124,  80, 174.0, 71.3, null, 6),                                   -- Wei, skin check
    ('60000000-0000-4000-8000-000000000009', 36.4,  98, 126,  82, null,  null, 'Pre-vaccination check', 1),                -- Aroha, flu vaccine
    ('60000000-0000-4000-8000-000000000010', 38.1,  98, null, null, 121.5, 23.4, 'Child, BP not taken', 2),                -- Mia, ear pain
    ('60000000-0000-4000-8000-000000000011', 36.6,  96, 148,  92, 172.0, 88.9, 'First reading', 2),                        -- Ahmed, BP review
    ('60000000-0000-4000-8000-000000000012', 36.7,  99, 122,  76, 186.0, 82.0, null, 3),                                   -- Lukas, ankle
    ('60000000-0000-4000-8000-000000000015', 36.5,  95, 118,  77, 164.0, 70.4, 'Asthmatic, SpO2 at usual baseline', 4)     -- Aroha, medication review
  ) as v(appointment_id, temp, spo2, sys, dia, height, weight, notes, mins_after_checkin)
  join public.appointments a on a.id = v.appointment_id::uuid;

-- Ahmed's blood pressure re-checked after resting: a second reading on the same visit.
insert into public.visit_vitals (appointment_id, bp_systolic, bp_diastolic, notes, recorded_at)
select a.id, 134, 84, 'Repeat BP after 5 minutes seated rest', a.checked_in_at + interval '9 minutes'
  from public.appointments a where a.id = '60000000-0000-4000-8000-000000000011';

commit;

select p.first_name, a.reason, l.temperature_c, l.spo2_percent,
       l.bp_systolic || '/' || l.bp_diastolic as bp, l.height_cm, l.weight_kg, l.bmi
  from public.visit_vitals_latest l
  join public.appointments a on a.id = l.appointment_id
  join public.patients p on p.id = l.patient_id
 order by l.visit_start;
