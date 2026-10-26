from __future__ import annotations

import uuid
from typing import Any

import pytest
from pydantic import TypeAdapter, ValidationError

from healthmcp.shared.config import Settings
from healthmcp.shared.engines.base import validated_call
from healthmcp.shared.engines.decision import JevEngine, LlmAdapterEngine
from healthmcp.shared.engines.extraction import OpenAICompatibleEngine
from healthmcp.shared.engines.models import (
    ClinicalField,
    QuestionOption,
    Segment,
    TypedAnswer,
    TypedQuestion,
)
from healthmcp.shared.engines.places import GooglePlacesClient, MockPlacesClient
from healthmcp.shared.engines.registry import EngineRegistry
from healthmcp.shared.engines.search import MockSearchEngine, TavilyEngine
from healthmcp.shared.errors import (
    EngineFailure,
    EngineNotConfigured,
    HealthDataNotAllowed,
    NotFound,
)
from healthmcp.shared.repositories.model_registry import FakeModelRegistryRepository
from tests.conftest import make_settings

# Olivia's approved transcript (seed/01, appointment ...0002)
SEGMENTS = [
    Segment(
        id=uuid.UUID(int=1),
        seq=1,
        speaker="clinician",
        text="Hi Olivia, I have your blood test results here. Most things look normal, "
        "but your iron levels are a bit low.",
    ),
    Segment(
        id=uuid.UUID(int=2),
        seq=2,
        speaker="patient",
        text="That would explain why I have been so tired lately.",
    ),
    Segment(
        id=uuid.UUID(int=3),
        seq=3,
        speaker="clinician",
        text="It could. I would like you to start an iron supplement once a day, ideally "
        "with some vitamin C, and we will repeat the blood test in three months.",
    ),
    Segment(id=uuid.UUID(int=4), seq=4, speaker="patient", text="Are there any side effects?"),
    Segment(
        id=uuid.UUID(int=5),
        seq=5,
        speaker="clinician",
        text="Some people get an upset stomach or constipation. If that happens, take it "
        "with food and let me know.",
    ),
]
STATE = "\n".join(s.text for s in SEGMENTS)
YES_NO = (
    QuestionOption(value="yes"),
    QuestionOption(value="no"),
    QuestionOption(value="not_stated"),
)


def q_yes_no(qid: str) -> TypedQuestion:
    return TypedQuestion(id=qid, version=1, kind="yes_no", text=qid, options=YES_NO, threshold=0.8)


SMOKER = TypedQuestion(
    id="smoker_status",
    version=1,
    kind="choice",
    text="Smoking?",
    threshold=0.7,
    options=tuple(QuestionOption(value=v) for v in ("current", "former", "never", "unclear")),
)
URGENCY = TypedQuestion(
    id="urgency_level",
    version=1,
    kind="score",
    text="Urgency?",
    threshold=0.8,
    options=tuple(
        QuestionOption(value=v, level=i, description=d)
        for i, (v, d) in enumerate(
            [("routine", "Routine"), ("soon", "Days"), ("urgent", "Today"), ("emergency", "Now")]
        )
    ),
)


def field(fid: str, schema: dict[str, Any], unit: str | None = None) -> ClinicalField:
    return ClinicalField(id=fid, version=1, label=fid, value_schema=schema, unit=unit, topic="t")


MEDICATION = field(
    "current_medication",
    {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "frequency": {"type": "string"},
            "dose": {"type": "string"},
        },
        "required": ["name"],
        "additionalProperties": False,
    },
)
BP = field(
    "bp_reading",
    {
        "type": "object",
        "properties": {"systolic": {"type": "integer"}, "diastolic": {"type": "integer"}},
        "required": ["systolic", "diastolic"],
        "additionalProperties": False,
    },
    unit="mm[Hg]",
)
FOLLOW_UP = field(
    "follow_up",
    {
        "type": "object",
        "properties": {"action": {"type": "string"}, "interval": {"type": "string"}},
        "required": ["action"],
        "additionalProperties": False,
    },
)


@pytest.fixture
def registry_repo() -> FakeModelRegistryRepository:
    return FakeModelRegistryRepository()


@pytest.fixture
def engines(settings: Settings, registry_repo: FakeModelRegistryRepository) -> EngineRegistry:
    return EngineRegistry(settings, registry_repo)


# ---------------------------------------------------------------------------
# Question model rules
# ---------------------------------------------------------------------------
def test_question_shapes_enforced() -> None:
    with pytest.raises(ValidationError):
        TypedQuestion(
            id="x",
            version=1,
            kind="yes_no",
            text="x",
            threshold=0.5,
            options=(QuestionOption(value="yes"), QuestionOption(value="no")),
        )
    with pytest.raises(ValidationError):
        TypedQuestion(
            id="x",
            version=1,
            kind="choice",
            text="x",
            threshold=0.5,
            options=(QuestionOption(value="a"), QuestionOption(value="b")),
        )
    with pytest.raises(ValidationError):
        TypedQuestion(
            id="x",
            version=1,
            kind="score",
            text="x",
            threshold=0.5,
            options=(
                QuestionOption(value="a", level=0),
                QuestionOption(value="b", level=1, description="B"),
            ),
        )


# ---------------------------------------------------------------------------
# Mock decision engine
# ---------------------------------------------------------------------------
async def test_mock_decisions_on_sample_transcript(engines: EngineRegistry) -> None:
    selected = await engines.decision(health_data=True)
    assert selected.entry.engine == "mock_decision"
    questions = [
        q_yes_no("fatigue_reported"),
        q_yes_no("chest_pain_reported"),
        q_yes_no("medication_started"),
        q_yes_no("follow_up_arranged"),
        SMOKER,
        URGENCY,
    ]
    answers = {a.question_id: a for a in await selected.engine.decide(questions, STATE)}
    assert answers["fatigue_reported"].answer == "yes"
    assert answers["chest_pain_reported"].answer == "not_stated"
    assert answers["medication_started"].answer == "yes"
    assert answers["follow_up_arranged"].answer == "yes"
    assert answers["smoker_status"].answer == "unclear"
    assert answers["urgency_level"].answer == "routine"
    assert all(0 <= a.probability <= 1 for a in answers.values())
    # Deterministic.
    again = await selected.engine.decide(questions, STATE)
    assert [a.model_dump() for a in again] == [answers[q.id].model_dump() for q in questions]


async def test_mock_negation_and_choice(engines: EngineRegistry) -> None:
    engine = (await engines.decision(health_data=True)).engine
    answers = await engine.decide(
        [q_yes_no("chest_pain_reported"), SMOKER, URGENCY],
        "I have no chest pain at all. I quit smoking last year. It is getting worse today.",
    )
    by_id = {a.question_id: a.answer for a in answers}
    assert by_id == {
        "chest_pain_reported": "no",
        "smoker_status": "former",
        "urgency_level": "urgent",
    }


# ---------------------------------------------------------------------------
# Mock extraction engine
# ---------------------------------------------------------------------------
async def test_mock_extraction_medication_and_follow_up(engines: EngineRegistry) -> None:
    engine = (await engines.extraction(health_data=True)).engine
    med = await engine.extract(MEDICATION, SEGMENTS)
    assert med.value == {"name": "iron supplement", "frequency": "once a day"}
    assert med.segment_id == SEGMENTS[2].id
    assert med.char_start is not None and med.char_end is not None
    assert SEGMENTS[2].text[med.char_start : med.char_end] == med.quote

    plan = await engine.extract(FOLLOW_UP, SEGMENTS)
    assert plan.value == {"action": "repeat the blood test", "interval": "in three months"}

    bp = await engine.extract(BP, SEGMENTS)
    assert not bp.found and bp.quote is None


async def test_mock_extraction_bp_in_words(engines: EngineRegistry) -> None:
    engine = (await engines.extraction(health_data=True)).engine
    seg = Segment(id=uuid.uuid4(), seq=1, text="Your blood pressure today is 140 over 90.")
    result = await engine.extract(BP, [seg])
    assert result.value == {"systolic": 140, "diastolic": 90}
    assert result.quote == "140 over 90"


# ---------------------------------------------------------------------------
# Validation: retry once, then fail; no fallback
# ---------------------------------------------------------------------------
async def test_validated_call_retries_once_then_raises() -> None:
    calls = 0

    async def bad() -> object:
        nonlocal calls
        calls += 1
        return [{"question_id": "x"}]

    with pytest.raises(EngineFailure):
        await validated_call(bad, TypeAdapter(list[TypedAnswer]), engine="t")
    assert calls == 2

    results = iter(
        [
            [{"question_id": "x"}],
            [{"question_id": "x", "question_version": 1, "answer": "yes", "probability": 0.9}],
        ]
    )

    async def flaky() -> object:
        return next(results)

    ok = await validated_call(flaky, TypeAdapter(list[TypedAnswer]), engine="t")
    assert ok[0].answer == "yes"


async def test_engine_errors_are_not_retried() -> None:
    calls = 0

    async def down() -> object:
        nonlocal calls
        calls += 1
        raise ConnectionError("down")

    with pytest.raises(EngineFailure):
        await validated_call(down, TypeAdapter(list[TypedAnswer]), engine="t")
    assert calls == 1


async def test_answer_outside_allowed_values_is_rejected() -> None:
    from healthmcp.shared.engines.base import check_answers

    q = q_yes_no("chest_pain_reported")

    async def wrong() -> object:
        return [{"question_id": q.id, "question_version": 1, "answer": "maybe", "probability": 1}]

    with pytest.raises(EngineFailure):
        await validated_call(
            wrong, TypeAdapter(list[TypedAnswer]), check=check_answers([q]), engine="t"
        )


# ---------------------------------------------------------------------------
# Registry: selection, health-data guard, no fallback
# ---------------------------------------------------------------------------
async def test_health_data_guard_blocks_before_engine_use(
    engines: EngineRegistry, registry_repo: FakeModelRegistryRepository
) -> None:
    registry_repo.set("mock_extraction", allow_health_data=False)
    with pytest.raises(HealthDataNotAllowed):
        await engines.extraction(health_data=True)
    # Non-health uses of the same engine are still possible.
    assert (await engines.extraction(health_data=False)).entry.engine == "mock_extraction"


async def test_real_engine_without_keys_fails_without_fallback(
    engines: EngineRegistry, registry_repo: FakeModelRegistryRepository
) -> None:
    registry_repo.set("mock_extraction", enabled=False)
    registry_repo.set("slm", enabled=True, allow_health_data=True)
    with pytest.raises(EngineNotConfigured):
        await engines.extraction(health_data=True)

    registry_repo.set("mock_decision", enabled=False)
    registry_repo.set("jev", enabled=True, allow_health_data=True)
    with pytest.raises(EngineNotConfigured):
        await engines.decision(health_data=True)


async def test_jev_starts_without_health_data(
    engines: EngineRegistry, registry_repo: FakeModelRegistryRepository
) -> None:
    registry_repo.set("mock_decision", enabled=False)
    registry_repo.set("jev", enabled=True)
    with pytest.raises(HealthDataNotAllowed):
        await engines.decision(health_data=True)


async def test_none_or_two_enabled_is_not_configured(
    engines: EngineRegistry, registry_repo: FakeModelRegistryRepository
) -> None:
    registry_repo.set("mock_search", enabled=False)
    with pytest.raises(EngineNotConfigured):
        await engines.search()
    registry_repo.set("mock_search", enabled=True)
    registry_repo.set("tavily", enabled=True)
    with pytest.raises(EngineNotConfigured):
        await engines.search()


def test_jev_never_guesses_its_api(settings: Settings) -> None:
    entry = _entry("jev")
    with pytest.raises(EngineNotConfigured):
        JevEngine(entry, settings)
    with pytest.raises(EngineNotConfigured):
        JevEngine(entry, make_settings(jev_docs_path="/docs/jev"))
    with pytest.raises(EngineNotConfigured):
        LlmAdapterEngine(_entry("llm_adapter"), settings)


def test_real_engines_need_keys(settings: Settings) -> None:
    with pytest.raises(EngineNotConfigured):
        OpenAICompatibleEngine(_entry("slm"), settings)
    with pytest.raises(EngineNotConfigured):
        TavilyEngine(_entry("tavily"), settings)
    with pytest.raises(EngineNotConfigured):
        GooglePlacesClient(_entry("google_places"), settings)


# ---------------------------------------------------------------------------
# Mock search and places
# ---------------------------------------------------------------------------
async def test_mock_search_respects_domains(settings: Settings) -> None:
    engine = MockSearchEngine(_entry("mock_search"), settings)
    results = await engine.search("gold hospital cover", ["sunstate.example.com"])
    assert results and all(r.url.startswith("https://sunstate.example.com/") for r in results)
    everything = await engine.search(
        "gold hospital cover", ["sunstate.example.com", "privatehealth.gov.au"]
    )
    assert not any("evil.example.net" in r.url for r in everything)
    pages = await engine.extract(["https://campuscover.example.com/oshc/essentials"])
    assert "100% of the MBS fee" in pages[0].content


async def test_mock_places(settings: Settings) -> None:
    client = MockPlacesClient(_entry("mock_places"), settings)
    place = await client.get_place_summary("sample-place-southbank")
    assert place.rating == 4.6 and place.review_count == 212 and place.reviews
    with pytest.raises(NotFound):
        await client.get_place_summary("missing-place")
    with pytest.raises(NotFound):
        await client.get_place_summary("../../etc/passwd")


def _entry(engine: str) -> Any:
    from dataclasses import asdict

    from healthmcp.shared.repositories.fake_data import MODEL_REGISTRY
    from healthmcp.shared.repositories.model_registry import EngineEntry

    return EngineEntry.model_validate(asdict(next(r for r in MODEL_REGISTRY if r.engine == engine)))
