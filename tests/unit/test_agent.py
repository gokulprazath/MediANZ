"""Agent role contracts and the code-only GP-query approval bridge."""

from __future__ import annotations

import json
import time
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx2
import jwt
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from mcp.types import Tool
from pydantic import Field, ValidationError

from healthmcp.agent import (
    AGENT_SPECS,
    CREATE_GP_QUERY,
    GET_APPOINTMENTS,
    GET_APPROVED_FACTS,
    AgentService,
    ChatRequest,
    ChatTurn,
    ConfirmRequest,
    ExtractRequest,
    create_app,
    route_question,
)
from healthmcp.shared.auth import (
    JOB_TOKEN_AUDIENCE,
    JOB_TOKEN_ISSUER,
    AuthError,
    TokenVerifier,
)
from healthmcp.shared.context import AgentAllowlist
from healthmcp.shared.tool_catalog import SERVERS
from tests.conftest import TEST_JOB_SECRET, make_settings
from tests.helpers import job_token, user_token

ROOT = Path(__file__).resolve().parents[2]
OLIVIA = UUID("11111111-1111-1111-1111-111111111111")
OTHER = UUID("22222222-2222-2222-2222-222222222222")
APPOINTMENT = UUID("33333333-3333-3333-3333-333333333333")
FACT = UUID("44444444-4444-4444-4444-444444444444")


def _all_tools() -> list[Tool]:
    return [
        Tool(
            name=f"{server}__{tool}",
            description=f"{server} {tool}",
            inputSchema={"type": "object", "properties": {}},
        )
        for server, spec in SERVERS.items()
        for tool in sorted(spec.tools)
    ]


class FakeConnection:
    def __init__(self, responses: dict[str, Any], calls: list[tuple[str, dict[str, Any]]]) -> None:
        self._responses = responses
        self._calls = calls

    async def list_tools(self) -> Sequence[Tool]:
        return _all_tools()

    async def call_tool(self, name: str, arguments: Mapping[str, Any]) -> Any:
        self._calls.append((name, dict(arguments)))
        default = {"status": "ok", "tool": name, "arguments": dict(arguments)}
        return self._responses.get(name, default)


class FakeFactory:
    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.responses = responses or {}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.opens: list[tuple[str, str]] = []

    @asynccontextmanager
    async def open(self, token: str, agent_id: str) -> AsyncIterator[FakeConnection]:
        self.opens.append((token, agent_id))
        yield FakeConnection(self.responses, self.calls)


class ScriptedChatModel(BaseChatModel):
    responses: list[AIMessage]
    seen_tools: list[str] = Field(default_factory=list)
    index: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted-test-model"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ScriptedChatModel:
        self.seen_tools = sorted(getattr(tool, "name", str(tool)) for tool in tools)
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        response = self.responses[min(self.index, len(self.responses) - 1)]
        self.index += 1
        return ChatResult(generations=[ChatGeneration(message=response)])


def _service(
    model: ScriptedChatModel,
    factory: FakeFactory,
    *,
    clock: Any = time.time,
) -> AgentService:
    settings = make_settings()
    return AgentService(
        settings,
        model=model,
        tool_factory=factory,
        allowlist=AgentAllowlist.load(ROOT / "config" / "agents.json"),
        verifier=TokenVerifier(settings),
        clock=clock,
    )


def _tool_call(name: str, arguments: dict[str, Any] | None = None) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {"name": name, "args": arguments or {}, "id": str(uuid.uuid4()), "type": "tool_call"}
        ],
    )


def _approved_facts_response() -> dict[str, Any]:
    return {
        "get_approved_facts": {
            "facts": [{"id": "44444444-4444-4444-4444-444444444444", "topic": "cholesterol"}]
        }
    }


@pytest.fixture
def factory() -> FakeFactory:
    return FakeFactory(_approved_facts_response())


def _expected(role: str) -> set[str]:
    spec = AGENT_SPECS[role]  # type: ignore[index]
    names = {f"{server}__{tool}" for server, tools in spec.tools.items() for tool in tools}
    if role == "insights":
        names.add("request_gp_query_approval")
    return names


async def test_each_role_binds_only_its_tools(factory: FakeFactory) -> None:
    messages = {
        "explainer": "why was this GP recommended and what are the fees",
        "insights": "what do my results say about my cholesterol",
        "insurance": "what is my insurance coverage for this fee",
        "booking": "book me a GP appointment this week",
    }
    for role, message in messages.items():
        model = ScriptedChatModel(responses=[AIMessage(content="ok")])
        service = _service(model, factory)
        response = await service.chat(user_token(OLIVIA), ChatRequest(message=message))
        assert response.agent == role
        assert set(model.seen_tools) == _expected(role)
        assert "create_gp_query" not in " ".join(model.seen_tools)
        assert not any(name.endswith("__log_note") for name in model.seen_tools)

    model = ScriptedChatModel(responses=[AIMessage(content="ok")])
    service = _service(model, factory)
    await service.extract(job_token("extractor"), ExtractRequest(message="extract this"))
    assert set(model.seen_tools) == _expected("extractor")


def test_router_keeps_roles_separate() -> None:
    assert route_question("what is my insurance coverage") == "insurance"
    assert route_question("why was this GP recommended?") == "explainer"
    assert route_question("how much does the fee cost") == "explainer"
    assert route_question("what do my results say about my cholesterol") == "insights"
    assert route_question("hello") == "insights"
    assert route_question("Can you book me in with a GP tomorrow?") == "booking"
    assert route_question("I need an appointment for a skin check") == "booking"
    assert route_question("is a booking covered by my insurance") == "insurance"
    assert route_question("when is my next appointment") == "insights"
    assert route_question("what does my facebook say") == "insights"


async def test_insights_prepares_a_signed_action_without_writing(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {"appointments": [{"appointment_id": str(APPOINTMENT)}]}
    model = ScriptedChatModel(
        responses=[
            _tool_call(
                "request_gp_query_approval",
                {
                    "question": "Should I repeat my cholesterol test?",
                    "context_fact_ids": ["44444444-4444-4444-4444-444444444444"],
                },
            ),
            AIMessage(content="I have prepared a question for your GP."),
        ]
    )
    service = _service(model, factory)

    response = await service.chat(
        user_token(OLIVIA), ChatRequest(message="what do my results say about my cholesterol")
    )

    assert response.agent == "insights"
    assert response.pending_action is not None
    assert response.appointment_id == str(APPOINTMENT)
    assert [name for name, _ in factory.calls] == [GET_APPOINTMENTS, GET_APPROVED_FACTS]
    assert not any(name == CREATE_GP_QUERY for name, _ in factory.calls)
    assert "create_gp_query" not in model.seen_tools


async def test_confirm_is_the_only_create_gp_query_caller(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {"appointments": [{"appointment_id": str(APPOINTMENT)}]}
    factory.responses[CREATE_GP_QUERY] = {"gp_query_id": "query-1"}
    model = ScriptedChatModel(
        responses=[
            _tool_call(
                "request_gp_query_approval",
                {"question": "Should I repeat my cholesterol test?"},
            ),
            AIMessage(content="Prepared."),
        ]
    )
    service = _service(model, factory)
    chat = await service.chat(
        user_token(OLIVIA), ChatRequest(message="what do my results say about my cholesterol")
    )
    assert chat.pending_action is not None

    confirmed = await service.confirm(
        user_token(OLIVIA), ConfirmRequest(action=chat.pending_action)
    )

    assert confirmed.result == {"gp_query_id": "query-1"}
    create_calls = [args for name, args in factory.calls if name == CREATE_GP_QUERY]
    assert create_calls == [
        {
            "question": "Should I repeat my cholesterol test?",
            "context_fact_ids": [],
            "idempotency_key": create_calls[0]["idempotency_key"],
        }
    ]
    assert "patient_id" not in create_calls[0]

    token, agent_id = factory.opens[-1]
    assert agent_id == "insights-writer"
    claims = jwt.decode(
        token,
        TEST_JOB_SECRET,
        algorithms=["HS256"],
        audience=JOB_TOKEN_AUDIENCE,
        issuer=JOB_TOKEN_ISSUER,
    )
    assert claims["agent_id"] == "insights-writer"
    assert claims["appointment_id"] == str(APPOINTMENT)
    assert "patient_id" not in claims


async def test_context_fact_ids_must_belong_to_the_patient(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {"appointments": [{"appointment_id": str(APPOINTMENT)}]}
    factory.responses[GET_APPROVED_FACTS] = {"facts": [{"id": str(FACT)}]}
    factory.responses[CREATE_GP_QUERY] = {"gp_query_id": "query-1"}
    unknown = str(uuid.uuid4())
    model = ScriptedChatModel(
        responses=[
            _tool_call(
                "request_gp_query_approval",
                {"question": "A question", "context_fact_ids": [str(FACT), unknown]},
            ),
            AIMessage(content="Prepared."),
        ]
    )
    service = _service(model, factory)
    chat = await service.chat(
        user_token(OLIVIA), ChatRequest(message="what do my results say about my cholesterol")
    )
    assert chat.pending_action is not None
    await service.confirm(user_token(OLIVIA), ConfirmRequest(action=chat.pending_action))
    create_calls = [args for name, args in factory.calls if name == CREATE_GP_QUERY]
    assert create_calls[0]["context_fact_ids"] == [str(FACT)]


async def test_action_is_bound_to_the_user_and_signature(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {"appointments": [{"appointment_id": str(APPOINTMENT)}]}
    model = ScriptedChatModel(
        responses=[
            _tool_call("request_gp_query_approval", {"question": "A question"}),
            AIMessage(content="Prepared."),
        ]
    )
    service = _service(model, factory)
    chat = await service.chat(
        user_token(OLIVIA), ChatRequest(message="what do my results say about my cholesterol")
    )
    assert chat.pending_action is not None

    with pytest.raises(AuthError):
        await service.confirm(user_token(OTHER), ConfirmRequest(action=chat.pending_action))

    body, _signature = chat.pending_action.split(".", 1)
    with pytest.raises(AuthError):
        await service.confirm(user_token(OLIVIA), ConfirmRequest(action=f"{body}.AAAA"))


async def test_expired_action_is_rejected(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {"appointments": [{"appointment_id": str(APPOINTMENT)}]}
    now = [1000.0]
    model = ScriptedChatModel(
        responses=[
            _tool_call("request_gp_query_approval", {"question": "A question"}),
            AIMessage(content="Prepared."),
        ]
    )
    service = _service(model, factory, clock=lambda: now[0])
    chat = await service.chat(
        user_token(OLIVIA), ChatRequest(message="what do my results say about my cholesterol")
    )
    assert chat.pending_action is not None

    now[0] += 1000
    with pytest.raises(AuthError):
        await service.confirm(user_token(OLIVIA), ConfirmRequest(action=chat.pending_action))


def _appointment(appointment: UUID, status: str, start: str) -> dict[str, Any]:
    return {
        "appointment_id": str(appointment),
        "status": status,
        "scheduled_start": start,
        "clinician_name": "Dr Asha Rao",
    }


async def _gp_query(factory: FakeFactory, arguments: dict[str, Any]) -> Any:
    model = ScriptedChatModel(
        responses=[
            _tool_call("request_gp_query_approval", {"question": "A question", **arguments}),
            AIMessage(content="Prepared."),
        ]
    )
    service = _service(model, factory)
    chat = await service.chat(
        user_token(OLIVIA), ChatRequest(message="what do my results say about my cholesterol")
    )
    return service, chat


async def test_gp_query_defaults_to_the_latest_completed_appointment(factory: FakeFactory) -> None:
    older, no_show = uuid.uuid4(), uuid.uuid4()
    factory.responses[GET_APPOINTMENTS] = {
        "appointments": [
            _appointment(older, "completed", "2026-06-20T00:00:00Z"),
            _appointment(APPOINTMENT, "completed", "2026-10-13T00:00:00Z"),
            _appointment(no_show, "no_show", "2026-10-28T00:00:00Z"),
        ]
    }
    service, chat = await _gp_query(factory, {})
    assert chat.appointment_id == str(APPOINTMENT)
    await service.confirm(user_token(OLIVIA), ConfirmRequest(action=chat.pending_action))
    assert [name for name, _ in factory.calls].count(CREATE_GP_QUERY) == 1


async def test_gp_query_uses_a_chosen_appointment_of_the_patients(factory: FakeFactory) -> None:
    chosen = uuid.uuid4()
    factory.responses[GET_APPOINTMENTS] = {
        "appointments": [
            _appointment(APPOINTMENT, "completed", "2026-10-13T00:00:00Z"),
            _appointment(chosen, "booked", "2026-11-13T00:00:00Z"),
        ]
    }
    _, chat = await _gp_query(factory, {"appointment_id": str(chosen)})
    assert chat.appointment_id == str(chosen)


@pytest.mark.parametrize("requested", [str(uuid.uuid4()), "not-a-uuid", None])
async def test_gp_query_without_a_usable_appointment_asks(
    factory: FakeFactory, requested: str | None
) -> None:
    # Someone else's appointment id, garbage, or no completed visit to default to.
    factory.responses[GET_APPOINTMENTS] = {
        "appointments": [
            _appointment(APPOINTMENT, "booked", "2026-11-13T00:00:00Z"),
            _appointment(uuid.uuid4(), "booked", "2026-11-20T00:00:00Z"),
        ]
    }
    _, chat = await _gp_query(factory, {"appointment_id": requested} if requested else {})
    assert chat.pending_action is None
    assert all(name != CREATE_GP_QUERY for name, _ in factory.calls)


async def test_confirm_refuses_an_appointment_no_longer_on_the_account(
    factory: FakeFactory,
) -> None:
    factory.responses[GET_APPOINTMENTS] = {
        "appointments": [_appointment(APPOINTMENT, "completed", "2026-10-13T00:00:00Z")]
    }
    service, chat = await _gp_query(factory, {})
    assert chat.pending_action is not None
    factory.responses[GET_APPOINTMENTS] = {"appointments": []}
    with pytest.raises(AuthError):
        await service.confirm(user_token(OLIVIA), ConfirmRequest(action=chat.pending_action))
    assert all(name != CREATE_GP_QUERY for name, _ in factory.calls)


async def test_endpoint_modes_are_not_interchangeable(factory: FakeFactory) -> None:
    model = ScriptedChatModel(responses=[AIMessage(content="ok")])
    service = _service(model, factory)

    with pytest.raises(AuthError):
        await service.chat(job_token("extractor"), ChatRequest(message="hello"))
    with pytest.raises(AuthError):
        await service.extract(user_token(OLIVIA), ExtractRequest(message="hello"))
    with pytest.raises(AuthError):
        await service.extract(job_token("clinical-doc-agent"), ExtractRequest(message="hello"))


def test_request_models_reject_patient_id() -> None:
    with pytest.raises(ValidationError):
        ChatRequest.model_validate({"message": "hi", "patient_id": str(OLIVIA)})
    with pytest.raises(ValidationError):
        ConfirmRequest.model_validate({"action": "x" * 20, "patient_id": str(OLIVIA)})
    with pytest.raises(ValidationError):
        ExtractRequest.model_validate({"message": "hi", "patient_id": str(OLIVIA)})


def test_every_role_has_a_contract() -> None:
    allowlist = AgentAllowlist.load(ROOT / "config" / "agents.json")
    assert set(AGENT_SPECS) <= allowlist.agent_ids
    for role in AGENT_SPECS.values():
        configured = allowlist.servers_for(role.name)
        assert {server: set(tools) for server, tools in role.tools.items()} == {
            server: set(tools) for server, tools in configured.items()
        }


async def test_http_endpoints_validate_and_route(factory: FakeFactory) -> None:
    model = ScriptedChatModel(responses=[AIMessage(content="ok")])
    service = _service(model, factory)
    app = create_app(service)
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://agent") as client:
        assert (await client.get("/healthz")).status_code == 200
        assert (await client.post("/chat", json={"message": "hi"})).status_code == 401

        user = user_token(OLIVIA)
        response = await client.post(
            "/chat",
            json={"message": "hi", "patient_id": str(OLIVIA)},
            headers={"Authorization": f"Bearer {user}"},
        )
        assert response.status_code == 422

        response = await client.post(
            "/chat",
            json={"message": "why was this GP recommended?"},
            headers={"Authorization": f"Bearer {user}"},
        )
        assert response.status_code == 200
        assert response.json()["agent"] == "explainer"

        response = await client.post(
            "/extract",
            json={"message": "extract"},
            headers={"Authorization": f"Bearer {user}"},
        )
        assert response.status_code == 401

        response = await client.post(
            "/extract",
            json={"message": "extract"},
            headers={"Authorization": f"Bearer {job_token('extractor')}"},
        )
        assert response.status_code == 200
        assert response.json() == {"answer": "ok"}


def test_action_payload_is_json_serialisable(factory: FakeFactory) -> None:
    model = ScriptedChatModel(responses=[AIMessage(content="ok")])
    service = _service(model, factory)
    action = service._sign_action(
        OLIVIA,
        APPOINTMENT,
        "A question",
        ["44444444-4444-4444-4444-444444444444"],
    )
    body = action.token.split(".", 1)[0]
    padded = body + "=" * (-len(body) % 4)
    import base64

    payload = json.loads(base64.urlsafe_b64decode(padded))
    assert payload["sub"] == str(OLIVIA)
    assert payload["appointment_id"] == str(APPOINTMENT)


PROPOSAL = UUID("55555555-5555-5555-5555-555555555555")
PROPOSE_BOOKING = "booking__propose_booking"


def _proposal() -> dict[str, Any]:
    return {
        "proposal_id": str(PROPOSAL),
        "kind": "book",
        "summary": "Book Dr Asha Rao at Southbank Family Medical, Mon 2 Nov 9:00 am.",
        "status": "pending",
        "expires_at": "2026-11-01T22:10:00Z",
    }


async def test_booking_returns_the_proposal_card_and_never_books(factory: FakeFactory) -> None:
    factory.responses[PROPOSE_BOOKING] = _proposal()
    slot = str(uuid.uuid4())
    model = ScriptedChatModel(
        responses=[
            _tool_call("booking__propose_booking", {"slot_id": slot, "reason": "check-up"}),
            _tool_call("booking__propose_booking", {"slot_id": str(uuid.uuid4())}),
            AIMessage(content="Tap Confirm to book Dr Rao on Monday at 9 am."),
        ]
    )
    service = _service(model, factory)
    response = await service.chat(user_token(OLIVIA), ChatRequest(message="book me a GP"))
    assert response.agent == "booking"
    assert response.booking_proposal is not None
    assert response.booking_proposal.proposal_id == PROPOSAL
    assert response.booking_proposal.summary.startswith("Book Dr Asha Rao")
    # Only one proposal per message reaches the booking server.
    assert [args for name, args in factory.calls if name == PROPOSE_BOOKING] == [
        {"slot_id": slot, "reason": "check-up"}
    ]
    assert response.pending_action is None


async def test_booking_prompt_carries_today(factory: FakeFactory) -> None:
    model = ScriptedChatModel(responses=[AIMessage(content="No free times.")])
    service = _service(model, factory, clock=lambda: 1_793_000_000.0)
    response = await service.chat(user_token(OLIVIA), ChatRequest(message="book a GP"))
    assert response.booking_proposal is None
    payload = AgentService._prompt_payload("x", [], [], today=date(2026, 10, 30))
    assert json.loads(payload)["today"] == "2026-10-30"


def test_router_matches_whole_words_and_clinical_worries() -> None:
    # "fee" must not catch "coffee", "feel" or "feeling".
    assert route_question("Can I drink coffee with my iron tablets?") == "insights"
    assert route_question("Why have I been feeling so tired?") == "insights"
    assert route_question("Should I double my dose because I feel worse?") == "insights"
    assert route_question("Why are fees different between clinics?") == "explainer"
    assert route_question("Is a long consult covered by my health fund?") == "insurance"


def test_follow_ups_route_like_the_earlier_message() -> None:
    assert route_question("yes please", ["Book me a GP on Friday"]) == "booking"
    assert route_question("ok", ["what costs more", "hello"]) == "explainer"
    assert route_question("thanks") == "insights"
    # The current message wins when it has its own markers.
    assert route_question("what does my insurance cover?", ["book a GP"]) == "insurance"


async def test_user_roles_get_today_time_zone_and_the_conversation(factory: FakeFactory) -> None:
    class Recording(ScriptedChatModel):
        prompts: list[str] = Field(default_factory=list)

        def _generate(self, messages: list[BaseMessage], *args: Any, **kwargs: Any) -> ChatResult:
            self.prompts.append(str(messages[-1].content))
            return super()._generate(messages, *args, **kwargs)

    model = Recording(responses=[AIMessage(content="ok")])
    service = _service(model, factory, clock=lambda: 1_793_404_800.0)  # 2026-10-30 23:00 UTC
    history = [
        ChatTurn(role="patient", text="What was my blood pressure?"),
        ChatTurn(role="assistant", text="116/74 at your last visit."),
    ]
    response = await service.chat(
        user_token(OLIVIA), ChatRequest(message="and before that?", history=history)
    )
    assert response.agent == "insights"  # routed by the earlier patient message
    payload = json.loads(model.prompts[0])
    assert payload["today"] == "2026-10-31"  # Brisbane is already on the 31st
    assert payload["time_zone"] == "Australia/Brisbane"
    assert payload["earlier_conversation"] == [
        {"from": "patient", "text": "What was my blood pressure?"},
        {"from": "assistant", "text": "116/74 at your last visit."},
    ]


async def test_unanswered_records_question_goes_to_the_last_clinician(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {
        "appointments": [
            {
                **_appointment(APPOINTMENT, "completed", "2026-10-15T23:30:00Z"),
                "local_start": "2026-10-16T09:30:00",
            },
            _appointment(uuid.uuid4(), "checked_in", "2026-10-30T12:20:00Z"),
        ]
    }
    # The model says the record doesn't answer it, but prepares nothing itself.
    model = ScriptedChatModel(
        responses=[AIMessage(content="I don't see any documented follow-up in your record.")]
    )
    service = _service(model, factory)
    chat = await service.chat(
        user_token(OLIVIA), ChatRequest(message="What follow-up did my doctor arrange?")
    )
    assert chat.agent == "insights"
    assert chat.appointment_id == str(APPOINTMENT)
    assert "I've prepared your question for Dr Asha Rao from your visit on 16 October 2026" in (
        chat.answer
    )
    await service.confirm(user_token(OLIVIA), ConfirmRequest(action=chat.pending_action))
    [created] = [args for name, args in factory.calls if name == CREATE_GP_QUERY]
    assert created["question"] == "What follow-up did my doctor arrange?"


async def test_answered_records_question_prepares_nothing(factory: FakeFactory) -> None:
    factory.responses[GET_APPOINTMENTS] = {
        "appointments": [_appointment(APPOINTMENT, "completed", "2026-10-15T23:30:00Z")]
    }
    model = ScriptedChatModel(responses=[AIMessage(content="Your blood pressure was 116/74.")])
    chat = await _service(model, factory).chat(
        user_token(OLIVIA), ChatRequest(message="What was my blood pressure?")
    )
    assert chat.pending_action is None


async def test_leaked_reasoning_never_reaches_the_patient(factory: FakeFactory) -> None:
    leaked = "Second entry is 108/68. Provide answer.\n</think>\nOn 25 September it was 108/68."
    for text in (leaked, "<think>check the list</think>On 25 September it was 108/68."):
        model = ScriptedChatModel(responses=[AIMessage(content=text)])
        chat = await _service(model, factory).chat(
            user_token(OLIVIA), ChatRequest(message="What was my blood pressure?")
        )
        assert chat.answer == "On 25 September it was 108/68."
