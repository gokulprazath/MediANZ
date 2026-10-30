"""decision server (spec 6.2): job mode, the clinical agent; engine Jev (+ SLM review).

The agent passes segment ids and question ids only; the server loads the text
and the question definitions itself, so nothing the agent writes reaches an
engine.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from healthmcp.servers.clinical import (
    ClinicalRepository,
    FakeClinicalRepository,
    PgClinicalRepository,
    eligible_context,
    load_segments,
    state_text,
)
from healthmcp.servers.decision.service import Answer, DecisionService
from healthmcp.shared.errors import InvalidRequest
from healthmcp.shared.server import HealthServer

NAME = "decision"

SegmentIds = Annotated[list[UUID], Field(min_length=1, max_length=200)]
QuestionId = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{1,62}$")]


class Answers(BaseModel):
    model_config = ConfigDict(frozen=True)

    answers: list[Answer]


def register(server: HealthServer, repo: ClinicalRepository | None = None) -> None:
    clinical: ClinicalRepository = repo or (
        PgClinicalRepository(server.deps.db)
        if server.deps.db is not None
        else FakeClinicalRepository()
    )
    deps = server.deps
    service = DecisionService(
        deps.engines,
        deps.repos.audit,
        server=NAME,
        review_below=deps.settings.decision_review_below,
    )

    async def run(
        segment_ids: list[UUID], question_ids: list[str], tool: str, kind: str | None = None
    ) -> list[Answer]:
        ctx = await eligible_context(clinical)
        segments = await load_segments(clinical, ctx, segment_ids)
        active = await clinical.active_questions(ctx)
        questions = service.pick(active, question_ids)
        if kind is not None and any(q.kind != kind for q in questions):
            raise InvalidRequest(f"That question is not a {kind} question.")
        return await service.decide(
            ctx, questions, active, segments, state_text(segments), tool=tool
        )

    @server.tool()
    async def decide_batch(
        segment_ids: SegmentIds,
        question_ids: Annotated[list[QuestionId], Field(min_length=1, max_length=25)],
    ) -> Answers:
        """Answer several decision questions about these transcript segments in one engine call.

        Each answer has a probability, meets_threshold (the question's stored
        threshold), attributes (negated, experiencer, temporality, hypothetical)
        and the supporting segment ids. explain questions are answered by the
        SLM in a short sentence, returned as untrusted text.

        Answers below 0.6 also get the SLM opinion and are marked needs_gp_review;
        every answer is a draft for the treating clinician. It never saves anything.
        Segment text is never returned except explain answers, as untrusted data.
        """
        return Answers(answers=await run(segment_ids, question_ids, "decide_batch"))

    @server.tool()
    async def decide_yes_no(segment_ids: SegmentIds, question_id: QuestionId) -> Answer:
        """Answer one yes/no question: yes, no or not_stated, with attributes and evidence.

        Answers below 0.6 also get the SLM opinion and are marked needs_gp_review;
        every answer is a draft for the treating clinician. It never saves anything.
        Segment text is never returned except explain answers, as untrusted data.
        """
        return (await run(segment_ids, [question_id], "decide_yes_no", "yes_no"))[0]

    @server.tool()
    async def decide_choice(segment_ids: SegmentIds, question_id: QuestionId) -> Answer:
        """Answer one choice question with one of its options (always including unclear).

        Answers below 0.6 also get the SLM opinion and are marked needs_gp_review;
        every answer is a draft for the treating clinician. It never saves anything.
        Segment text is never returned except explain answers, as untrusted data.
        """
        return (await run(segment_ids, [question_id], "decide_choice", "choice"))[0]

    @server.tool()
    async def decide_score(segment_ids: SegmentIds, question_id: QuestionId) -> Answer:
        """Answer one score question with one of its ordinal levels.

        Answers below 0.6 also get the SLM opinion and are marked needs_gp_review;
        every answer is a draft for the treating clinician. It never saves anything.
        Segment text is never returned except explain answers, as untrusted data.
        """
        return (await run(segment_ids, [question_id], "decide_score", "score"))[0]
