-- =====================================================================
-- Security Advisor fixes for 20261026000000_health_booking_schema.sql
-- Safe to run more than once.
-- =====================================================================

-- 1. "Extension in Public": move btree_gist to the extensions schema.
--    Existing exclusion constraints keep working (they reference the
--    operator classes internally, not by schema name).
create schema if not exists extensions;
alter extension btree_gist set schema extensions;

-- 2. Trigger functions must not be callable as API endpoints.
--    Triggers still fire without EXECUTE permission.
revoke execute on function
  public.set_updated_at(),
  public.appointments_before_update(),
  public.appointments_after_write(),
  public.insurance_claims_before_write(),
  public.schedule_exceptions_after_change(),
  public.consult_transcripts_before_update(),
  public.clinician_ratings_before_write()
from public, anon, authenticated;

-- 3. recording_allowed() is only used inside other database functions,
--    so app users don't need to call it directly.
revoke execute on function public.recording_allowed(uuid) from public, anon, authenticated;
