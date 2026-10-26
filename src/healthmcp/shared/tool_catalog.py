"""The only tools that may exist (spec section 6), per server, plus `log_note`.

`config/agents.json` and every server's registered tools are checked against
this catalogue by the tests, so a tool outside the spec cannot slip in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Mode = Literal["user", "job"]

LOG_NOTE = "log_note"


@dataclass(frozen=True)
class ServerSpec:
    name: str
    port: int
    modes: frozenset[Mode]
    tools: frozenset[str]


def _spec(name: str, port: int, modes: set[Mode], tools: set[str]) -> ServerSpec:
    return ServerSpec(name, port, frozenset(modes), frozenset(tools | {LOG_NOTE}))


SERVERS: dict[str, ServerSpec] = {
    s.name: s
    for s in (
        _spec(
            "transcript",
            3101,
            {"job"},
            {
                "get_processing_eligibility",
                "get_transcript_windows",
                "search_transcript",
                "check_grounding",
            },
        ),
        _spec(
            "decision",
            3102,
            {"job"},
            {"decide_batch", "decide_yes_no", "decide_choice", "decide_score"},
        ),
        _spec(
            "extraction",
            3103,
            {"job"},
            {
                "extract_value",
                "save_draft_fact",
                "raise_open_item",
                "create_gp_query",
                "list_open_items",
                "get_clinician_preferences",
            },
        ),
        _spec(
            "patient_record",
            3104,
            {"user", "job"},
            {"get_approved_facts", "get_observations", "get_eligibility", "get_appointments"},
        ),
        _spec(
            "matching",
            3105,
            {"user"},
            {
                "get_patient_gp_preferences",
                "find_gp_candidates",
                "get_score_breakdown",
                "get_fees",
                "get_plan_coverage",
                "get_facility_review_summary",
            },
        ),
        _spec(
            "booking",
            3106,
            {"user"},
            {
                "get_available_slots",
                "hold_slot",
                "propose_booking",
                "propose_cancellation",
                "propose_reschedule",
                "get_proposal_status",
            },
        ),
        _spec(
            "web_research",
            3107,
            {"job"},
            {
                "import_phio_dataset",
                "refresh_plan_coverage",
                "refresh_facility_reviews",
                "web_search",
                "web_extract",
            },
        ),
    )
}
