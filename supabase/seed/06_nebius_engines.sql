-- =====================================================================
-- DEVELOPMENT ONLY: real engines for consult notes.
--   * SLM (extraction, explain questions, second opinions): Nebius Token Factory
--   * Decision engine (key points): Jev, TypeSafe AI System One
-- Run in the SQL Editor after seed 04 (which turns the mock engines on) and
-- both consult-notes migrations:
--   20261028000000_consult_key_points.sql
--   20261028010000_key_point_second_opinion.sql (adds the explain kind)
--
-- The Python side reads endpoints, keys and models from the environment:
-- SLM_BASE_URL / SLM_API_KEY / SLM_MODEL and JEV_API_KEY / JEV_MODEL. The
-- `model` column here is informational.
--
-- allow_health_data = true lets transcript text reach Nebius and TypeSafe. Do
-- this only in the development project, with sample data, until each
-- provider's hosting region, zero-data-retention terms and data-processing
-- agreement are confirmed (docs/DECISIONS.md, 2026-10-28). Fill in `region`
-- and `zero_data_retention` once confirmed.
--
-- Back to the mocks (no API keys needed):
--   update public.model_registry set enabled = false where engine in ('jev', 'slm');
--   update public.model_registry set enabled = true
--    where engine in ('mock_decision', 'mock_extraction');
--
-- Safe to re-run. Runs as one transaction.
-- =====================================================================
begin;

-- One enabled engine per capability: turn the others off first.
update public.model_registry set enabled = false
 where capability in ('extraction', 'decision')
   and engine not in ('slm', 'jev');

update public.model_registry
   set provider = 'Nebius Token Factory',
       model = 'env:SLM_MODEL',
       model_version = '2026-10',
       region = null,                -- TODO: confirm the Nebius region before production
       zero_data_retention = false,  -- TODO: confirm the retention terms before production
       allow_health_data = true,     -- development project only
       enabled = true
 where engine = 'slm';

update public.model_registry
   set provider = 'TypeSafe AI',
       model = 'jev-latest',
       model_version = '2026-10',
       region = null,                -- TODO: confirm the TypeSafe region before production
       zero_data_retention = false,  -- TODO: confirm the retention terms before production
       allow_health_data = true,     -- development project only
       enabled = true
 where engine = 'jev';

-- Sample explain questions: answered by the SLM in a sentence, reviewed by the GP.
insert into public.decision_questions (id, version, kind, text, options, threshold, threshold_model_version) values
 ('presenting_complaint_summary', 1, 'explain',
  'In one or two sentences, why did the patient come in today?', '[]', 0.700, '1'),
 ('management_plan_summary', 1, 'explain',
  'In one or two sentences, what plan did the GP and patient agree (medicines, tests, follow-up)?',
  '[]', 0.700, '1')
on conflict (id, version) do nothing;

select engine, capability, provider, enabled, allow_health_data
  from public.model_registry
 where capability in ('extraction', 'decision')
 order by capability, engine;

commit;
