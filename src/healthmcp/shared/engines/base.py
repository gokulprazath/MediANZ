"""Validate every engine result with Pydantic; on a mismatch retry once, then raise."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Any, TypeVar

from pydantic import BaseModel, TypeAdapter, ValidationError

from healthmcp.shared.engines.models import TypedAnswer, TypedQuestion
from healthmcp.shared.errors import EngineFailure, HealthMcpError

logger = logging.getLogger("healthmcp.engines")

T = TypeVar("T")
M = TypeVar("M", bound=BaseModel)


async def validated_call(
    call: Callable[[], Awaitable[Any]],
    adapter: TypeAdapter[T],
    *,
    check: Callable[[T], None] | None = None,
    engine: str,
) -> T:
    """Run `call`, validate its raw result (and `check` it); retry once on a mismatch.

    Engine errors (network, auth, rate limits) are not retried here and never
    fall back to another engine: they propagate as EngineFailure.
    """
    for attempt in (1, 2):
        try:
            raw = await call()
        except HealthMcpError:
            raise
        except Exception as exc:
            logger.warning(
                "engine call failed", extra={"engine": engine, "error_type": type(exc).__name__}
            )
            raise EngineFailure() from exc
        try:
            result = adapter.validate_python(raw)
            if check is not None:
                check(result)
            return result
        except (ValidationError, ValueError) as exc:
            logger.warning(
                "engine result invalid",
                extra={"engine": engine, "attempt": attempt, "error_type": type(exc).__name__},
            )
    raise EngineFailure("The engine returned an invalid result.")


def check_answers(questions: Sequence[TypedQuestion]) -> Callable[[list[TypedAnswer]], None]:
    """One answer per question, using only that question's allowed values.

    Explain answers carry text exactly when answered; no other answer has text.
    """

    def check(answers: list[TypedAnswer]) -> None:
        by_id = {(q.id, q.version): q for q in questions}
        seen: set[tuple[str, int]] = set()
        for a in answers:
            key = (a.question_id, a.question_version)
            q = by_id.get(key)
            if q is None or key in seen or a.answer not in q.allowed_values:
                raise ValueError("answer does not match its question")
            has_text = bool(a.text and a.text.strip())
            if has_text != (q.kind == "explain" and a.answer == "answered"):
                raise ValueError("answer text does not match its question")
            seen.add(key)
        if seen != set(by_id):
            raise ValueError("missing answers")

    return check
