"""matching and web_research tools, and the tool set of every server."""

from __future__ import annotations

import uuid
from dataclasses import replace
from importlib import import_module
from typing import Any

import pytest

from healthmcp.discovery.models import ResearchRunSummary
from healthmcp.servers.matching.repository import SOUTHBANK, FakeMatchingRepository
from healthmcp.servers.matching.tools import register as register_matching
from healthmcp.servers.web_research.repository import FakeReviewsRepository
from healthmcp.servers.web_research.tools import looks_clinical, summarise
from healthmcp.servers.web_research.tools import register as register_research
from healthmcp.shared.repositories import fake_repositories
from healthmcp.shared.repositories.fake_data import DR_RAO, JACK_AUTH_USER, OLIVIA_AUTH_USER
from healthmcp.shared.repositories.model_registry import FakeModelRegistryRepository
from healthmcp.shared.tool_catalog import SERVERS
from tests.conftest import make_settings
from tests.helpers import mcp_session, running
from tests.unit.servers_helpers import audit, call, job_headers, make_server, session, user_headers

KEDRON = uuid.UUID("30000000-0000-4000-8000-000000000003")
SILVER_PLUS = uuid.UUID("21000000-0000-4000-8000-000000000002")


@pytest.mark.parametrize("name", sorted(SERVERS))
def test_every_server_registers_exactly_its_spec_tools(name: str) -> None:
    module = import_module(f"healthmcp.servers.{name}.tools")
    server = make_server(name, module.register)
    registered = {t.name for t in server.mcp._tool_manager.list_tools()}
    assert registered == set(SERVERS[name].tools)
    for tool in server.mcp._tool_manager.list_tools():
        assert tool.description and len(tool.description) > 40, tool.name


# ---------------------------------------------------------------------------
# matching
# ---------------------------------------------------------------------------
async def test_candidates_merge_preferences_with_overrides() -> None:
    repo = FakeMatchingRepository()
    server = make_server("matching", lambda s: register_matching(s, repo))
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        stored = await call(
            s,
            "find_gp_candidates",
            date_from="2026-11-02",
            date_to="2026-11-06",
            near={"postcode": "4101"},
        )
        overridden = await call(
            s,
            "find_gp_candidates",
            date_from="2026-11-02",
            date_to="2026-11-06",
            overrides={"languages": ["HI"], "clinician_sex": "female"},
        )
        too_long = await call(s, "find_gp_candidates", date_from="2026-11-01", date_to="2026-12-15")
        unknown = await call(
            s,
            "find_gp_candidates",
            date_from="2026-11-02",
            date_to="2026-11-03",
            near={"postcode": "9999"},
        )
    assert stored["applied"]["languages"] == ["en"] and stored["applied"]["max_km"] == 15.0
    assert stored["candidates"][0]["clinician_id"] == str(DR_RAO)
    assert overridden["applied"]["languages"] == ["hi"] and overridden["applied"]["sex"] == "female"
    assert overridden["applied"]["max_km"] is None  # no location, no distance limit
    assert "31 days" in too_long["error"] and "postcode is not known" in unknown["error"]


async def test_scores_hide_rating_factors_below_five_ratings() -> None:
    repo = FakeMatchingRepository()
    server = make_server("matching", lambda s: register_matching(s, repo))
    async with session(server, user_headers(OLIVIA_AUTH_USER)) as s:
        few = await call(s, "get_score_breakdown", clinician_id=str(DR_RAO))
        repo.data.rating_counts[DR_RAO] = 5
        enough = await call(s, "get_score_breakdown", clinician_id=str(DR_RAO))
    assert {f["factor"] for f in few["factors"]} == {"availability", "continuity"}
    assert few["rating_factors_shown"] is False and few["scoring_version"] == "v1"
    assert len(enough["factors"]) == 4


async def test_fees_coverage_and_reviews() -> None:
    server = make_server("matching", register_matching)
    async with running(server) as transport:
        async with mcp_session(transport, server, user_headers(OLIVIA_AUTH_USER)) as s:
            fee = await call(
                s,
                "get_fees",
                clinician_id=str(DR_RAO),
                facility_id=str(SOUTHBANK),
                visit_type="standard",
                on_date="2026-11-03",
            )
            none = await call(
                s,
                "get_fees",
                clinician_id=str(DR_RAO),
                facility_id=str(SOUTHBANK),
                visit_type="long",
                on_date="2026-11-03",
            )
            cover = await call(s, "get_plan_coverage")
            review = await call(s, "get_facility_review_summary", facility_id=str(SOUTHBANK))
        async with mcp_session(transport, server, user_headers(JACK_AUTH_USER)) as s:
            jack = await call(s, "get_plan_coverage")
    assert fee["is_estimate"] is True and "Estimate only" in fee["label"]
    assert "No fee schedule" in none["error"]
    assert cover["available"] is True and cover["source"] == "phio_dataset"
    assert jack == {**jack, "available": False}
    assert review["non_clinical_summary"]["untrusted_content"] is True


# ---------------------------------------------------------------------------
# web_research
# ---------------------------------------------------------------------------
async def _refresher(ctx: Any, plan_id: uuid.UUID) -> ResearchRunSummary:
    return ResearchRunSummary(
        source="mock_search", status="ok", targets=1, pages_fetched=1, drafts_created=1, errors=0
    )


def _research(**kw: Any) -> tuple[Any, FakeReviewsRepository]:
    reviews = FakeReviewsRepository()
    server = make_server(
        "web_research", lambda s: register_research(s, reviews, coverage_refresher=_refresher), **kw
    )
    return server, reviews


async def test_search_blocks_personal_information_and_other_domains() -> None:
    server, _ = _research()
    async with session(
        server, job_headers(agent="research-job", appointment_id=None, patient_id=None)
    ) as s:
        ok = await call(
            s,
            "web_search",
            query="Silver Plus Combined extras dental",
            purpose="insurance_coverage",
        )
        name = await call(s, "web_search", query="Olivia Brown dental cover", purpose="general")
        medicare = await call(s, "web_search", query="cover for 2953 17654 1", purpose="general")
        domain = await call(
            s, "web_search", query="dental cover", purpose="general", domains=["evil.example.org"]
        )
        page = await call(s, "web_extract", urls=["https://evil.example.org/x"])
    assert ok["results"] and ok["results"][0]["content"]["untrusted_content"] is True
    assert "personal information" in name["error"] and "personal information" in medicare["error"]
    assert "allowlist" in domain["error"] and "allowlist" in page["error"]  # spec 7.10
    logged = audit(server).web_research
    assert [e.blocked_reason for e in logged] == [
        None,
        "personal_information",
        "personal_information",
        "domain_not_allowed",
        "domain_not_allowed",
    ]
    assert all("Olivia" not in str(e) for e in logged)


async def test_review_refresh_leaves_out_clinical_reviews_and_stores_no_text() -> None:
    server, reviews = _research()
    async with session(
        server, job_headers(agent="research-job", appointment_id=None, patient_id=None)
    ) as s:
        result = await call(s, "refresh_facility_reviews", facility_id=str(KEDRON))
        coverage = await call(s, "refresh_plan_coverage", plan_id=str(uuid.uuid4()))
        phio = await call(s, "import_phio_dataset", file_path="phio.csv")
    saved = reviews.saved[KEDRON]
    assert result["reviews_excluded_as_clinical"] == 1 and result["review_count"] == 507
    assert "surgery" not in saved.non_clinical_summary.lower()
    assert "Long wait at admissions." not in saved.non_clinical_summary
    assert coverage["drafts_created"] == 1
    assert "not available yet" in phio["error"]


RESEARCH_JOB = {"agent": "research-job", "appointment_id": None, "patient_id": None}


async def test_plan_coverage_refresh_works_with_the_mock_engines() -> None:
    # The real refresher, no API keys: mock_search fixtures + mock_extraction.
    server = make_server("web_research", lambda s: register_research(s, FakeReviewsRepository()))
    async with session(server, job_headers(**RESEARCH_JOB)) as s:
        silver = await call(s, "refresh_plan_coverage", plan_id=str(SILVER_PLUS))
        unknown = await call(s, "refresh_plan_coverage", plan_id=str(uuid.uuid4()))
    assert silver["source"] == "mock_search" and silver["status"] == "ok"
    assert silver["targets"] == 3 and silver["drafts_created"] == 3 and silver["errors"] == 0
    assert unknown["targets"] == 0 and unknown["drafts_created"] == 0


async def test_plan_coverage_refresh_never_falls_back_to_the_mock() -> None:
    registry = FakeModelRegistryRepository()
    registry.set("mock_extraction", enabled=False)
    registry.set("slm", enabled=True)  # enabled, but no SLM / agent model keys
    repos = replace(fake_repositories(), model_registry=registry)
    settings = make_settings(slm_base_url="", slm_model="", agent_llm_model="")
    server = make_server(
        "web_research",
        lambda s: register_research(s, FakeReviewsRepository()),
        repos=repos,
        settings=settings,
    )
    async with session(server, job_headers(**RESEARCH_JOB)) as s:
        result = await call(s, "refresh_plan_coverage", plan_id=str(SILVER_PLUS))
    assert "not configured" in result["error"]


async def test_patients_cannot_run_background_research() -> None:
    server, _ = _research()
    async with session(server, user_headers(OLIVIA_AUTH_USER, agent="insurance")) as s:
        names = {t.name for t in (await s.list_tools()).tools}
        search = await call(
            s, "web_search", query="Silver Plus extras", purpose="insurance_coverage"
        )
    assert names == {"web_search", "web_extract"}
    assert "results" in search


def test_summary_helpers() -> None:
    assert looks_clinical("They treated my infection quickly")
    assert not looks_clinical("Friendly staff and easy parking")
    text = summarise(["Friendly staff", "Easy parking, friendly"], 10)
    assert text.startswith("Based on 2 recent non-clinical reviews (of 10 in total)")
    assert "friendly or helpful staff" in text and "parking" in text
