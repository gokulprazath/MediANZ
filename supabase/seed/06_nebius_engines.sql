-- =====================================================================
-- DEVELOPMENT ONLY: use Nebius Token Factory as the SLM extraction engine.
-- Run in the SQL Editor after 20261028000000_consult_key_points.sql and
-- seed 04 (which turns the mock engines on).
--
-- The Python side reads the endpoint, key and model from SLM_BASE_URL,
-- SLM_API_KEY and SLM_MODEL; the `model` column here is informational.
--
-- allow_health_data = true lets transcript text reach Nebius. Do this only in
-- the development project, with sample data, until the hosting region,
-- zero-data-retention terms and data-processing agreement are confirmed
-- (docs/DECISIONS.md, 2026-10-28). Fill in `region` and
-- `zero_data_retention` once confirmed.
--
-- The decision engine stays mock_decision until the Jev client is built
-- (it needs the Jev API docs at JEV_DOCS_PATH). Switching later:
--   update public.model_registry set enabled = false where engine = 'mock_decision';
--   update public.model_registry set enabled = true, allow_health_data = true where engine = 'jev';
--
-- Safe to re-run. Runs as one transaction.
-- =====================================================================
begin;

-- One enabled engine per capability: turn the mock off first.
update public.model_registry set enabled = false where engine = 'mock_extraction';

update public.model_registry
   set provider = 'Nebius Token Factory',
       model = 'env:SLM_MODEL',
       model_version = '2026-10',
       region = null,                -- TODO: confirm the Nebius region before production
       zero_data_retention = false,  -- TODO: confirm the retention terms before production
       allow_health_data = true,     -- development project only
       enabled = true
 where engine = 'slm';

select engine, capability, provider, enabled, allow_health_data
  from public.model_registry
 where capability in ('extraction', 'decision')
 order by capability, engine;

commit;
