-- =====================================================================
-- Consult key points: SLM second opinions and explain questions.
--
-- Run after:
--   20261028000000_consult_key_points.sql
--
-- Runs as one transaction: if anything fails, nothing is saved.
-- =====================================================================

BEGIN;

-- =====================================================================
-- 1. DECISION QUESTIONS: add the explain kind (no options)
-- =====================================================================

CREATE OR REPLACE FUNCTION public.decision_question_options_ok(
    p_kind text,
    p_options jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN jsonb_typeof(p_options) IS DISTINCT FROM 'array'
            THEN false

        WHEN p_kind = 'explain'
            THEN jsonb_array_length(p_options) = 0

        WHEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(p_options) o
            WHERE jsonb_typeof(o) <> 'object'
               OR COALESCE(BTRIM(o ->> 'value'), '') = ''
        )
            THEN false

        WHEN (
            SELECT COUNT(DISTINCT o ->> 'value')
            FROM jsonb_array_elements(p_options) o
        ) <> jsonb_array_length(p_options)
            THEN false

        WHEN p_kind = 'yes_no'
            THEN (
                SELECT array_agg(o ->> 'value' ORDER BY o ->> 'value')
                FROM jsonb_array_elements(p_options) o
            ) = ARRAY['no', 'not_stated', 'yes']

        WHEN p_kind = 'choice'
            THEN jsonb_array_length(p_options) >= 2
             AND EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(p_options) o
                 WHERE o ->> 'value' = 'unclear'
             )

        WHEN p_kind = 'score'
            THEN jsonb_array_length(p_options) >= 2
             AND NOT EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(p_options) o
                 WHERE jsonb_typeof(o -> 'level') IS DISTINCT FROM 'number'
                    OR COALESCE(BTRIM(o ->> 'description'), '') = ''
             )
             AND (
                 SELECT COUNT(DISTINCT o -> 'level')
                 FROM jsonb_array_elements(p_options) o
             ) = jsonb_array_length(p_options)

        ELSE false
    END;
$$;

ALTER TABLE public.decision_questions
    DROP CONSTRAINT decision_questions_kind_check;

ALTER TABLE public.decision_questions
    ADD CONSTRAINT decision_questions_kind_check
    CHECK (kind IN ('yes_no', 'choice', 'score', 'explain'));


-- =====================================================================
-- 2. KEY POINTS: explanation text, answer source and other opinion
-- =====================================================================

ALTER TABLE public.consult_key_points
    DROP CONSTRAINT consult_key_points_kind_check;

ALTER TABLE public.consult_key_points
    ADD CONSTRAINT consult_key_points_kind_check
    CHECK (kind IN ('yes_no', 'choice', 'score', 'explain'));


ALTER TABLE public.consult_key_points
    ADD COLUMN answer_text text
        CONSTRAINT consult_key_points_answer_text_length_check
        CHECK (
            char_length(answer_text) BETWEEN 1 AND 1000
            AND BTRIM(answer_text) <> ''
        ),

    ADD COLUMN answer_source text NOT NULL DEFAULT 'decision_engine'
        CHECK (answer_source IN ('decision_engine', 'slm')),

    ADD COLUMN other_opinion_answer text
        CHECK (other_opinion_answer ~ '^[A-Za-z0-9_.-]{1,64}$'),

    ADD COLUMN other_opinion_probability numeric(4,3)
        CHECK (other_opinion_probability BETWEEN 0 AND 1),

    ADD COLUMN other_opinion_engine text
        CHECK (char_length(other_opinion_engine) BETWEEN 1 AND 64),

    -- Separate name prevents collision with the answer_text length check.
    ADD CONSTRAINT consult_key_points_explain_answer_text_check
        CHECK (
            CASE
                WHEN kind = 'explain'
                    THEN answer IN ('answered', 'not_stated')
                     AND (
                         (answer = 'answered')
                         = (answer_text IS NOT NULL)
                     )
                ELSE answer_text IS NULL
            END
        ),

    ADD CONSTRAINT consult_key_points_other_opinion_check
        CHECK (
            (other_opinion_answer IS NULL)
                = (other_opinion_probability IS NULL)
            AND
            (other_opinion_answer IS NULL)
                = (other_opinion_engine IS NULL)
        );


COMMENT ON COLUMN public.consult_key_points.answer_source IS
    'Which engine gave the suggested answer: the decision engine (Jev) or the SLM (second opinion or explain question).';

COMMENT ON COLUMN public.consult_key_points.other_opinion_answer IS
    'The answer of the engine that was not chosen, when both were asked (Jev below 0.6).';


-- =====================================================================
-- 3. HUMAN-ONLY REVIEW: edit an explanation while approving it
-- =====================================================================

CREATE OR REPLACE FUNCTION public.edit_and_approve_key_point_text(
    p_key_point_id uuid,
    p_text text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_k public.consult_key_points :=
        public._lock_key_point_for_review(p_key_point_id);

    v_text text := BTRIM(COALESCE(p_text, ''));
BEGIN
    IF v_k.kind <> 'explain' THEN
        RAISE EXCEPTION 'Only explain key points take text';
    END IF;

    IF char_length(v_text) NOT BETWEEN 1 AND 1000 THEN
        RAISE EXCEPTION 'Explanation must be 1 to 1000 characters';
    END IF;

    UPDATE public.consult_key_points
    SET answer = 'answered',
        answer_text = v_text,
        answer_edited = (v_text IS DISTINCT FROM v_k.answer_text),
        status = 'approved',
        reviewed_by = auth.uid(),
        reviewed_at = now()
    WHERE id = v_k.id;
END;
$$;


REVOKE ALL ON FUNCTION
    public.edit_and_approve_key_point_text(uuid, text)
FROM public, anon, authenticated, service_role;

-- Checks for the treating clinician or staff.
-- Never granted to service_role.
GRANT EXECUTE ON FUNCTION
    public.edit_and_approve_key_point_text(uuid, text)
TO authenticated;


COMMIT;