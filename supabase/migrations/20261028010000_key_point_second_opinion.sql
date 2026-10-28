-- =====================================================================
-- Consult key points: SLM second opinions and explain questions.
--
--   * When the decision engine (Jev) answers below 0.6, the worker also asks
--     the SLM. The more confident answer is the suggested one (answer_source
--     says which engine gave it); the other engine's answer is kept in
--     other_opinion_*; the GP is asked to confirm through an open item.
--   * New question kind 'explain': questions that need a short explanation,
--     not an option. They skip Jev and go to the SLM; the explanation is
--     stored in consult_key_points.answer_text for the GP to review.
--     answer is 'answered' (with text) or 'not_stated'.
--
-- Run after:
--   20261028000000_consult_key_points.sql
--
-- Runs as one transaction: if anything fails, nothing is saved.
-- =====================================================================
begin;

-- =====================================================================
-- 1. DECISION QUESTIONS: the explain kind (no options)
-- =====================================================================
-- Same as 20261027000000 plus the explain branch.
create or replace function public.decision_question_options_ok(p_kind text, p_options jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case
    when jsonb_typeof(p_options) is distinct from 'array' then false
    when p_kind = 'explain' then jsonb_array_length(p_options) = 0
    when exists (select 1 from jsonb_array_elements(p_options) o
                  where jsonb_typeof(o) <> 'object'
                     or coalesce(btrim(o ->> 'value'), '') = '') then false
    when (select count(distinct o ->> 'value') from jsonb_array_elements(p_options) o)
         <> jsonb_array_length(p_options) then false
    when p_kind = 'yes_no' then
      (select array_agg(o ->> 'value' order by o ->> 'value') from jsonb_array_elements(p_options) o)
        = array['no', 'not_stated', 'yes']
    when p_kind = 'choice' then
      jsonb_array_length(p_options) >= 2
      and exists (select 1 from jsonb_array_elements(p_options) o where o ->> 'value' = 'unclear')
    when p_kind = 'score' then
      jsonb_array_length(p_options) >= 2
      and not exists (select 1 from jsonb_array_elements(p_options) o
                       where jsonb_typeof(o -> 'level') is distinct from 'number'
                          or coalesce(btrim(o ->> 'description'), '') = '')
      and (select count(distinct o -> 'level') from jsonb_array_elements(p_options) o)
          = jsonb_array_length(p_options)
    else false
  end
$$;

alter table public.decision_questions drop constraint decision_questions_kind_check;
alter table public.decision_questions add constraint decision_questions_kind_check
  check (kind in ('yes_no', 'choice', 'score', 'explain'));

-- =====================================================================
-- 2. KEY POINTS: explanation text, answer source, the other opinion
-- =====================================================================
alter table public.consult_key_points drop constraint consult_key_points_kind_check;
alter table public.consult_key_points add constraint consult_key_points_kind_check
  check (kind in ('yes_no', 'choice', 'score', 'explain'));

alter table public.consult_key_points
  add column answer_text text
    check (char_length(answer_text) between 1 and 1000 and btrim(answer_text) <> ''),
  add column answer_source text not null default 'decision_engine'
    check (answer_source in ('decision_engine', 'slm')),
  add column other_opinion_answer text
    check (other_opinion_answer ~ '^[A-Za-z0-9_.-]{1,64}$'),
  add column other_opinion_probability numeric(4,3)
    check (other_opinion_probability between 0 and 1),
  add column other_opinion_engine text
    check (char_length(other_opinion_engine) between 1 and 64),
  -- Explain answers carry text exactly when answered; other kinds never have text.
  add constraint consult_key_points_answer_text_check check (
    case when kind = 'explain'
         then answer in ('answered', 'not_stated')
              and (answer = 'answered') = (answer_text is not null)
         else answer_text is null
    end),
  add constraint consult_key_points_other_opinion_check check (
    (other_opinion_answer is null) = (other_opinion_probability is null)
    and (other_opinion_answer is null) = (other_opinion_engine is null));

comment on column public.consult_key_points.answer_source is
  'Which engine gave the suggested answer: the decision engine (Jev) or the SLM (second opinion or explain question).';
comment on column public.consult_key_points.other_opinion_answer is
  'The answer of the engine that was not chosen, when both were asked (Jev below 0.6).';

-- =====================================================================
-- 3. HUMAN-ONLY REVIEW: edit an explanation while approving it
-- =====================================================================
-- The existing edit_and_approve_key_point already refuses explain key points
-- (they have no option values).
create or replace function public.edit_and_approve_key_point_text(p_key_point_id uuid, p_text text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_k    public.consult_key_points := public._lock_key_point_for_review(p_key_point_id);
  v_text text := btrim(coalesce(p_text, ''));
begin
  if v_k.kind <> 'explain' then
    raise exception 'Only explain key points take text';
  end if;
  if char_length(v_text) not between 1 and 1000 then
    raise exception 'Explanation must be 1 to 1000 characters';
  end if;
  update public.consult_key_points
     set answer = 'answered',
         answer_text = v_text,
         answer_edited = (v_text is distinct from v_k.answer_text),
         status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
   where id = v_k.id;
end $$;

revoke all on function public.edit_and_approve_key_point_text(uuid, text)
  from public, anon, authenticated, service_role;
-- Checks for the treating clinician or staff. Never granted to service_role.
grant execute on function public.edit_and_approve_key_point_text(uuid, text) to authenticated;

commit;
