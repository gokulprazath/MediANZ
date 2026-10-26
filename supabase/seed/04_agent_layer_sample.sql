-- =====================================================================
-- SAMPLE DATA for the agent layer (development projects only).
-- Run in the SQL Editor after:
--   20261027000000_agent_layer.sql
--   20261027010000_agent_layer_booking_matching.sql
-- and after the earlier seeds (01, 02, 03).
--
-- Safe to re-run: every insert skips rows that already exist, and every
-- update sets a fixed value. Runs as one transaction.
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1. Consent wording versions (also inserted by the migration)
-- ---------------------------------------------------------------------
insert into public.consent_text_versions (version, covers_ai_analysis, published_at) values
  ('v1', false, '2026-01-01'),
  ('v2', true,  '2026-10-27')
on conflict (version) do nothing;

-- ---------------------------------------------------------------------
-- 2. Decision questions (yes/no always yes|no|not_stated; choice always
--    includes unclear; every score level described in words)
-- ---------------------------------------------------------------------
insert into public.decision_questions (id, version, kind, text, options, threshold, threshold_model_version) values
 ('chest_pain_reported', 1, 'yes_no', 'Does the patient report chest pain or chest tightness?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.800, '1'),
 ('shortness_of_breath_reported', 1, 'yes_no', 'Does the patient report shortness of breath?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.800, '1'),
 ('fatigue_reported', 1, 'yes_no', 'Does the patient report tiredness or fatigue?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.700, '1'),
 ('medication_started', 1, 'yes_no', 'Did the clinician start or prescribe a new medication or supplement?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.750, '1'),
 ('follow_up_arranged', 1, 'yes_no', 'Was a follow-up visit or repeat test arranged?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.700, '1'),
 ('smoker_status', 1, 'choice', 'What is the patient''s smoking status?',
  '[{"value":"current","label":"Currently smokes"},{"value":"former","label":"Used to smoke, has quit"},{"value":"never","label":"Has never smoked"},{"value":"unclear","label":"Not stated or unclear"}]',
  0.700, '1'),
 ('pain_severity', 1, 'score', 'How severe is the pain the patient describes?',
  '[{"value":"none","level":0,"description":"No pain mentioned"},{"value":"mild","level":1,"description":"Mild pain that does not limit daily activities"},{"value":"moderate","level":2,"description":"Moderate pain that limits some activities"},{"value":"severe","level":3,"description":"Severe pain that stops normal activities or needs urgent relief"}]',
  0.700, '1'),
 ('urgency_level', 1, 'score', 'How urgently does something discussed need clinical attention?',
  '[{"value":"routine","level":0,"description":"Routine: can wait for the next planned visit"},{"value":"soon","level":1,"description":"Soon: should be reviewed within a few days"},{"value":"urgent","level":2,"description":"Urgent: needs review today"},{"value":"emergency","level":3,"description":"Emergency: needs immediate care (call 000)"}]',
  0.800, '1'),
 -- Attribute questions, added to every engine call for a finding
 ('attr_negated', 1, 'yes_no', 'Is the finding stated as absent (negated)?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.700, '1'),
 ('attr_hypothetical', 1, 'yes_no', 'Is the finding hypothetical or conditional (for example "if that happens")?',
  '[{"value":"yes"},{"value":"no"},{"value":"not_stated"}]', 0.700, '1'),
 ('attr_experiencer', 1, 'choice', 'Who experiences the finding?',
  '[{"value":"patient","label":"The patient"},{"value":"family","label":"A family member"},{"value":"other","label":"Someone else"},{"value":"unclear","label":"Unclear"}]',
  0.700, '1'),
 ('attr_temporality', 1, 'choice', 'When does the finding apply?',
  '[{"value":"current","label":"Now"},{"value":"past","label":"In the past"},{"value":"future","label":"Planned or in the future"},{"value":"unclear","label":"Unclear"}]',
  0.700, '1'),
 -- Evidence question template: the server adds one option per segment id at call time
 ('evidence_segment', 1, 'choice', 'Which segment best supports the answer to the question?',
  '[{"value":"none","label":"No segment supports the answer"},{"value":"unclear","label":"Unclear"}]',
  0.600, '1')
on conflict (id, version) do nothing;

-- ---------------------------------------------------------------------
-- 3. Clinical fields (value_schema is JSON Schema)
-- ---------------------------------------------------------------------
insert into public.clinical_fields (id, version, label, value_schema, unit, code_system, topic) values
 ('bp_reading', 1, 'Blood pressure',
  '{"type":"object","properties":{"systolic":{"type":"integer","minimum":50,"maximum":300},"diastolic":{"type":"integer","minimum":20,"maximum":200}},"required":["systolic","diastolic"],"additionalProperties":false}',
  'mm[Hg]', 'LOINC', 'observation'),
 ('body_temperature', 1, 'Body temperature',
  '{"type":"number","minimum":30,"maximum":45}', 'Cel', 'LOINC', 'observation'),
 ('body_weight', 1, 'Body weight',
  '{"type":"number","minimum":0.5,"maximum":400}', 'kg', 'LOINC', 'observation'),
 ('current_medication', 1, 'Current medication',
  '{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":200},"dose":{"type":"string","maxLength":100},"frequency":{"type":"string","maxLength":100}},"required":["name"],"additionalProperties":false}',
  null, 'AMT', 'medication'),
 ('allergy', 1, 'Allergy',
  '{"type":"object","properties":{"substance":{"type":"string","minLength":1,"maxLength":200},"reaction":{"type":"string","maxLength":200}},"required":["substance"],"additionalProperties":false}',
  null, 'SNOMED CT-AU', 'allergy'),
 ('smoking_status', 1, 'Smoking status',
  '{"type":"string","enum":["current","former","never"]}', null, 'SNOMED CT-AU', 'social_history'),
 ('symptom', 1, 'Symptom',
  '{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":200},"duration":{"type":"string","maxLength":100}},"required":["name"],"additionalProperties":false}',
  null, 'SNOMED CT-AU', 'symptom'),
 ('follow_up', 1, 'Follow-up plan',
  '{"type":"object","properties":{"action":{"type":"string","minLength":1,"maxLength":200},"interval":{"type":"string","maxLength":100}},"required":["action"],"additionalProperties":false}',
  null, null, 'plan')
on conflict (id, version) do nothing;

-- ---------------------------------------------------------------------
-- 4. Model registry: mock engines on, real engines off
-- ---------------------------------------------------------------------
update public.model_registry set enabled = false
 where engine in ('jev', 'llm_adapter', 'slm', 'tavily', 'google_places');

update public.model_registry m set enabled = true
 where m.engine in ('mock_decision', 'mock_extraction', 'mock_search', 'mock_places')
   and not exists (select 1 from public.model_registry o
                    where o.capability = m.capability and o.enabled and o.engine <> m.engine);

-- ---------------------------------------------------------------------
-- 5. Clinician languages (ISO 639-1 codes) and matching flags
-- ---------------------------------------------------------------------
update public.clinicians c set
  languages = v.languages, accepting_new_patients = v.accepting,
  offers_telehealth = v.telehealth, special_interests = v.interests
from (values
  ('40000000-0000-4000-8000-000000000001'::uuid, '{en,hi}'::text[], true,  true,  '{womens_health,preventive_care}'::text[]),
  ('40000000-0000-4000-8000-000000000002'::uuid, '{en,vi}'::text[], true,  true,  '{mens_health,sports_medicine}'::text[]),
  ('40000000-0000-4000-8000-000000000003'::uuid, '{en}'::text[],    false, false, '{mental_health}'::text[]),
  ('40000000-0000-4000-8000-000000000004'::uuid, '{en,es}'::text[], true,  false, '{skin_cancer}'::text[]),
  ('40000000-0000-4000-8000-000000000005'::uuid, '{en,ko}'::text[], true,  true,  '{paediatrics}'::text[]),
  ('40000000-0000-4000-8000-000000000006'::uuid, '{en}'::text[],    true,  false, '{immunisation}'::text[])
) as v(id, languages, accepting, telehealth, interests)
where c.id = v.id;

-- Fictional place ids (the mock Places client knows these).
update public.facilities f set google_place_id = v.place_id
from (values
  ('30000000-0000-4000-8000-000000000001'::uuid, 'sample-place-southbank'),
  ('30000000-0000-4000-8000-000000000002'::uuid, 'sample-place-paddington'),
  ('30000000-0000-4000-8000-000000000003'::uuid, 'sample-place-kedron'),
  ('30000000-0000-4000-8000-000000000004'::uuid, 'sample-place-parramatta')
) as v(id, place_id)
where f.id = v.id and f.google_place_id is distinct from v.place_id;

-- ---------------------------------------------------------------------
-- 6. Patient GP preferences (Olivia, Priya, Ahmed)
-- ---------------------------------------------------------------------
insert into public.patient_gp_preferences
  (patient_id, preferred_languages, preferred_clinician_sex, preferred_facility_ids, telehealth_ok, max_distance_km) values
 ('50000000-0000-4000-8000-000000000001', '{en}',    'female', '{30000000-0000-4000-8000-000000000001}', true,  10),
 ('50000000-0000-4000-8000-000000000003', '{hi,en}', 'female', '{}',                                     true,  15),
 ('50000000-0000-4000-8000-000000000008', '{en}',    null,     '{30000000-0000-4000-8000-000000000004}', false, 20)
on conflict (patient_id) do nothing;

-- Documentation preferences for the clinicians with test logins.
insert into public.clinician_preferences (clinician_id, prefs) values
 ('40000000-0000-4000-8000-000000000001', '{"note_style":"soap","units":"metric","medication_naming":"generic","flag_follow_ups":true}'),
 ('40000000-0000-4000-8000-000000000003', '{"note_style":"problem_list","units":"metric","medication_naming":"generic","flag_follow_ups":false}')
on conflict (clinician_id) do nothing;

-- ---------------------------------------------------------------------
-- 7. Fee schedules for every facility (Southbank stopped bulk billing
--    180 days ago, matching its billing history; Dr Rao has her own
--    standard fee there).
-- ---------------------------------------------------------------------
insert into public.fee_schedules (id, facility_id, clinician_id, visit_type, mbs_item, fee, medicare_rebate, valid_from, valid_to) values
 ('81000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001', null, 'standard',    '23',  43.90, 43.90, '2022-01-01', current_date - 180),
 ('81000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001', null, 'standard',    '23',  85.00, 43.90, current_date - 180, null),
 ('81000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001', null, 'long',        '36', 140.00, 84.90, '2022-01-01', null),
 ('81000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000001', null, 'telehealth',  '91800', 85.00, 43.90, '2022-01-01', null),
 ('81000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000001', null, 'vaccination', null,   0.00,  0.00, '2022-01-01', null),
 ('81000000-0000-4000-8000-000000000006','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001', 'standard', '23', 90.00, 43.90, current_date - 90, null),
 ('81000000-0000-4000-8000-000000000007','30000000-0000-4000-8000-000000000002', null, 'standard',    '23',  95.00, 43.90, '2021-01-01', null),
 ('81000000-0000-4000-8000-000000000008','30000000-0000-4000-8000-000000000002', null, 'long',        '36', 150.00, 84.90, '2021-01-01', null),
 ('81000000-0000-4000-8000-000000000009','30000000-0000-4000-8000-000000000003', null, 'standard',    '104',250.00, 80.85, '2020-01-01', null),
 ('81000000-0000-4000-8000-000000000010','30000000-0000-4000-8000-000000000003', null, 'long',        '104',250.00, 80.85, '2020-01-01', null),
 ('81000000-0000-4000-8000-000000000011','30000000-0000-4000-8000-000000000004', null, 'standard',    '23',  43.90, 43.90, '2023-01-01', null),
 ('81000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000004', null, 'long',        '36',  84.90, 84.90, '2023-01-01', null),
 ('81000000-0000-4000-8000-000000000013','30000000-0000-4000-8000-000000000004', null, 'telehealth',  '91800', 43.90, 43.90, '2023-01-01', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 8. Verified plan versions for every sample plan (+ one draft from an
--    insurer site, which patients and agents must never see).
--    Hospital and extras cover cannot pay for GP visits for Medicare
--    patients; OSHC and visitor cover pay a share of the MBS fee.
-- ---------------------------------------------------------------------
insert into public.insurance_plan_versions
  (id, plan_id, valid_from, valid_to, hospital_inclusions, hospital_exclusions, hospital_restricted,
   excess, extras_limits, waiting_periods, gp_benefit, source, source_url, retrieved_at, content_hash,
   status, verified_at) values
 ('82000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','2024-01-01', null,
  '["all_clinical_categories"]', '[]', '[]', 500.00, '{}',
  '{"pre_existing_conditions_months":12,"pregnancy_months":12,"other_hospital_months":2}',
  '{"covered":false}', 'phio_dataset', 'https://www.privatehealth.gov.au/', now() - interval '20 days',
  null, 'verified', now() - interval '19 days'),
 ('82000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000002','2024-01-01', null,
  '["joint_replacements","heart_and_vascular","cataracts","dental_surgery"]', '["pregnancy_and_birth","weight_loss_surgery"]', '["psychiatric_services"]',
  750.00, '{"general_dental":800,"optical":250,"physiotherapy":500}',
  '{"pre_existing_conditions_months":12,"extras_months":2}',
  '{"covered":false}', 'phio_dataset', 'https://www.privatehealth.gov.au/', now() - interval '20 days',
  null, 'verified', now() - interval '19 days'),
 ('82000000-0000-4000-8000-000000000003','21000000-0000-4000-8000-000000000003','2024-01-01', null,
  '["tonsils_adenoids_and_grommets","bone_joint_and_muscle","joint_reconstructions"]', '["joint_replacements","heart_and_vascular","pregnancy_and_birth"]', '[]',
  750.00, '{}', '{"pre_existing_conditions_months":12}',
  '{"covered":false}', 'phio_dataset', 'https://www.privatehealth.gov.au/', now() - interval '20 days',
  null, 'verified', now() - interval '19 days'),
 ('82000000-0000-4000-8000-000000000004','21000000-0000-4000-8000-000000000004','2024-01-01', null,
  '[]', '[]', '[]', null, '{"general_dental":500,"optical":150}', '{"extras_months":2}',
  '{"covered":false}', 'phio_dataset', 'https://www.privatehealth.gov.au/', now() - interval '20 days',
  null, 'verified', now() - interval '19 days'),
 ('82000000-0000-4000-8000-000000000005','21000000-0000-4000-8000-000000000005','2024-01-01', null,
  '["all_clinical_categories"]', '[]', '[]', 0.00, '{}', '{"pre_existing_conditions_months":12,"pregnancy_months":12}',
  '{"covered":true,"basis":"mbs_percent","percent":100}', 'phio_dataset', 'https://www.privatehealth.gov.au/',
  now() - interval '20 days', null, 'verified', now() - interval '19 days'),
 ('82000000-0000-4000-8000-000000000006','21000000-0000-4000-8000-000000000006','2024-01-01', null,
  '["emergency_hospital"]', '["pre_existing_conditions"]', '[]', 250.00, '{}', '{"pre_existing_conditions_months":12}',
  '{"covered":true,"basis":"mbs_percent","percent":85}', 'phio_dataset', 'https://www.privatehealth.gov.au/',
  now() - interval '20 days', null, 'verified', now() - interval '19 days'),
 ('82000000-0000-4000-8000-000000000007','21000000-0000-4000-8000-000000000001', current_date, null,
  '["all_clinical_categories"]', '[]', '[]', 250.00, '{}', '{"pre_existing_conditions_months":12}',
  '{"covered":false}', 'insurer_site', 'https://sunstate.example.com/cover/gold-hospital', now() - interval '1 day',
  encode(sha256('sample draft'::bytea), 'hex'), 'draft', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 9. Match scores (scoring_version v1) and facility review summaries
--    (summaries are fictional and non-clinical; no review text is stored)
-- ---------------------------------------------------------------------
insert into public.clinician_match_scores (clinician_id, factor, score, scoring_version, computed_at)
select v.clinician_id::uuid, v.factor, v.score, 'v1', now() - interval '1 day'
  from (values
    ('40000000-0000-4000-8000-000000000001','availability',  0.82),
    ('40000000-0000-4000-8000-000000000001','continuity',    0.90),
    ('40000000-0000-4000-8000-000000000001','patient_rating',1.00),
    ('40000000-0000-4000-8000-000000000001','wait_time',     1.00),
    ('40000000-0000-4000-8000-000000000002','availability',  0.75),
    ('40000000-0000-4000-8000-000000000002','continuity',    0.70),
    ('40000000-0000-4000-8000-000000000002','patient_rating',0.70),
    ('40000000-0000-4000-8000-000000000002','wait_time',     0.55),
    ('40000000-0000-4000-8000-000000000003','availability',  0.40),
    ('40000000-0000-4000-8000-000000000003','continuity',    0.65),
    ('40000000-0000-4000-8000-000000000004','availability',  0.30),
    ('40000000-0000-4000-8000-000000000005','availability',  0.85),
    ('40000000-0000-4000-8000-000000000005','patient_rating',1.00),
    ('40000000-0000-4000-8000-000000000006','availability',  0.90)
  ) as v(clinician_id, factor, score)
on conflict (clinician_id, factor, scoring_version) do nothing;

insert into public.facility_review_summaries
  (facility_id, source, rating, review_count, non_clinical_summary, source_url, retrieved_at) values
 ('30000000-0000-4000-8000-000000000001','google_places', 4.6, 212,
  'Reviewers mention friendly reception staff, easy online booking and a clean waiting room. Some say Monday mornings are busy.',
  'https://www.google.com/maps/place/?q=place_id:sample-place-southbank', now() - interval '3 days'),
 ('30000000-0000-4000-8000-000000000002','google_places', 4.2, 138,
  'Reviewers like the central location and helpful front desk. Parking nearby is described as limited.',
  'https://www.google.com/maps/place/?q=place_id:sample-place-paddington', now() - interval '3 days'),
 ('30000000-0000-4000-8000-000000000003','google_places', 3.9, 507,
  'Reviewers mention modern facilities and clear signage. Several comment on long waits at admissions.',
  'https://www.google.com/maps/place/?q=place_id:sample-place-kedron', now() - interval '3 days'),
 ('30000000-0000-4000-8000-000000000004','google_places', 4.4, 96,
  'Reviewers mention short waiting times, multilingual staff and being close to the train station.',
  'https://www.google.com/maps/place/?q=place_id:sample-place-parramatta', now() - interval '3 days')
on conflict (facility_id, source) do nothing;

-- ---------------------------------------------------------------------
-- 10. Olivia's approved transcript (appointment ...0002): build its
--     segments (no-op if already built) and move both consents to v2 so
--     the clinical documentation agent can be tested on it.
-- ---------------------------------------------------------------------
select public.build_transcript_segments('71000000-0000-4000-8000-000000000001');

update public.recording_consents
   set consent_text_version = 'v2'
 where appointment_id = '60000000-0000-4000-8000-000000000002'
   and consent_text_version is distinct from 'v2';

commit;

-- ---------------------------------------------------------------------
-- Summary
-- ---------------------------------------------------------------------
select 'consent_text_versions' as table_name, count(*) as rows from public.consent_text_versions
union all select 'decision_questions',        count(*) from public.decision_questions
union all select 'clinical_fields',           count(*) from public.clinical_fields
union all select 'model_registry (enabled)',  count(*) from public.model_registry where enabled
union all select 'patient_gp_preferences',    count(*) from public.patient_gp_preferences
union all select 'clinician_preferences',     count(*) from public.clinician_preferences
union all select 'fee_schedules',             count(*) from public.fee_schedules
union all select 'insurance_plan_versions',   count(*) from public.insurance_plan_versions
union all select 'clinician_match_scores',    count(*) from public.clinician_match_scores
union all select 'facility_review_summaries', count(*) from public.facility_review_summaries
union all select 'transcript_segments',       count(*) from public.transcript_segments;

select * from public.get_processing_eligibility('60000000-0000-4000-8000-000000000002');
