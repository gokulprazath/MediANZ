"""Logging for every server (spec 3.3).

* `with_tool_logging`: wraps each tool. Checks the agent allowlist, records
  one agent_access_log row per call, and turns every failure into a short,
  safe MCP tool error. Full detail goes to the server log, which never
  contains patient text.
* `log_decision`: one decision_log row per engine call (ids and hashes only).
* `register_log_note`: the `log_note` tool every server exposes.
* `RedactingFilter` / `configure_logging`: stdlib logging that drops known
  text fields and never prints exception messages (they can contain values).
"""

from __future__ import annotations

import functools
import hashlib
import json
import logging
import time
import traceback
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from typing import Any, ParamSpec, TypeVar

import psycopg
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, Field

from healthmcp.shared.context import AgentAllowlist, Context, current_context
from healthmcp.shared.errors import HealthMcpError, InvalidRequest, TextNotAllowedInLog
from healthmcp.shared.repositories.audit import (
    AccessLogEntry,
    AuditRepository,
    DecisionLogEntry,
    NoteEntry,
)

logger = logging.getLogger("healthmcp")

P = ParamSpec("P")
R = TypeVar("R")

# Fields that may hold patient-derived or web text. Never logged.
REDACTED_FIELDS = frozenset(
    {
        "text",
        "transcript_text",
        "segments",
        "summary_text",
        "quote",
        "quotes",
        "review",
        "reviews",
        "review_text",
        "note",
        "query",
        "description",
        "question",
        "answer",
        "content",
        "value",
        "state",
        "prompt",
        "resolution",
        "reason",
        "comment",
    }
)
# Keys that would carry free text (transcript, quotes, web or review text) in decision_log.
# Enum answers and structured values are allowed there; quotes are stored as hashes.
DECISION_LOG_FORBIDDEN = frozenset(
    {
        "text",
        "transcript_text",
        "segments",
        "summary_text",
        "quote",
        "quotes",
        "review",
        "reviews",
        "review_text",
        "note",
        "content",
        "prompt",
        "state",
        "comment",
    }
)
_REDACTED = "[redacted]"
_STD_RECORD_ATTRS = frozenset(vars(logging.makeLogRecord({})))
MAX_NOTE_CHARS = 1000


def _redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: (_REDACTED if k in REDACTED_FIELDS else _redact(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return type(value)(_redact(v) for v in value)
    return value


class RedactingFilter(logging.Filter):
    """Drops known text fields from `extra=` attributes and mapping args."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key in list(vars(record)):
            if key in _STD_RECORD_ATTRS:
                continue
            if key in REDACTED_FIELDS:
                setattr(record, key, _REDACTED)
            else:
                setattr(record, key, _redact(getattr(record, key)))
        if isinstance(record.args, Mapping):
            record.args = _redact(record.args)
        # Exception text can carry values (validation errors, SQL details):
        # keep the type and traceback frames, drop the message.
        if record.exc_info and record.exc_info[1] is not None:
            exc = record.exc_info[1]
            record.exc_text = safe_traceback(exc)
            record.exc_info = None
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key, value in vars(record).items():
            if key not in _STD_RECORD_ATTRS and key not in {"message", "asctime"}:
                out[key] = value
        if record.exc_text:
            out["exc"] = record.exc_text
        return json.dumps(out, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    handler.addFilter(RedactingFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "mcp"):
        lg = logging.getLogger(name)
        lg.handlers[:] = []
        lg.propagate = True


def safe_exception_summary(exc: BaseException) -> dict[str, Any]:
    """Type plus, for database errors, the SQLSTATE and constraint. Never the message."""
    summary: dict[str, Any] = {"error_type": type(exc).__name__}
    if isinstance(exc, psycopg.Error) and exc.diag is not None:
        summary["sqlstate"] = exc.diag.sqlstate
        if exc.diag.constraint_name:
            summary["constraint"] = exc.diag.constraint_name
    if isinstance(exc, HealthMcpError):
        summary["error_code"] = exc.code
    return summary


def safe_traceback(exc: BaseException) -> str:
    frames = "".join(traceback.format_tb(exc.__traceback__))
    return f"{frames}{type(exc).__name__} (message withheld)"


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _error_code(exc: BaseException) -> str:
    if isinstance(exc, HealthMcpError):
        return exc.code
    if isinstance(exc, ToolError):
        return "tool_error"
    return "internal_error"


def with_tool_logging(
    server: str,
    audit: AuditRepository,
    allowlist: AgentAllowlist,
    *,
    tool_name: str | None = None,
) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    """Decorate an async tool function. The signature is preserved for schema generation."""

    def decorate(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        name = tool_name or fn.__name__

        @functools.wraps(fn)
        async def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            ctx = current_context()
            started = time.monotonic()
            error: BaseException | None = None
            try:
                allowlist.check_tool(ctx.agent_id, server, name)
                return await fn(*args, **kwargs)
            except HealthMcpError as exc:
                error = exc
                logger.info(
                    "tool refused",
                    extra={
                        "server": server,
                        "tool": name,
                        "request_id": ctx.request_id,
                        **safe_exception_summary(exc),
                    },
                )
                raise ToolError(exc.public_message) from None
            except ToolError as exc:
                error = exc
                raise
            except Exception as exc:
                error = exc
                logger.error(
                    "tool failed",
                    extra={
                        "server": server,
                        "tool": name,
                        "request_id": ctx.request_id,
                        **safe_exception_summary(exc),
                        "trace": safe_traceback(exc),
                    },
                )
                raise ToolError("Internal error.") from None
            finally:
                await _record_access(audit, ctx, server, name, started, error)

        return wrapper

    return decorate


async def _record_access(
    audit: AuditRepository,
    ctx: Context,
    server: str,
    tool: str,
    started: float,
    error: BaseException | None,
) -> None:
    entry = AccessLogEntry(
        agent_id=ctx.agent_id,
        mode=ctx.mode,
        user_id=ctx.user_id,
        job_id=ctx.job_id,
        patient_id=ctx.patient_id,
        appointment_id=ctx.appointment_id,
        server=server,
        tool=tool,
        ok=error is None,
        error_code=None if error is None else _error_code(error),
        latency_ms=int((time.monotonic() - started) * 1000),
    )
    try:
        await audit.record_access(entry)
    except Exception as exc:  # the call already happened; never mask its result
        logger.error(
            "access log write failed",
            extra={"server": server, "tool": tool, **safe_exception_summary(exc)},
        )


def _find_text_keys(value: Any, path: str = "") -> list[str]:
    found: list[str] = []
    if isinstance(value, Mapping):
        for k, v in value.items():
            here = f"{path}.{k}" if path else str(k)
            if k in DECISION_LOG_FORBIDDEN:
                found.append(here)
            found.extend(_find_text_keys(v, here))
    elif isinstance(value, list | tuple):
        for i, v in enumerate(value):
            found.extend(_find_text_keys(v, f"{path}[{i}]"))
    return found


async def log_decision(
    audit: AuditRepository,
    ctx: Context,
    *,
    server: str,
    tool: str,
    engine: str,
    model: str | None,
    model_version: str | None,
    question_version: str | None,
    input_refs: Mapping[str, Any],
    input_text: str,
    output: Mapping[str, Any],
    probability: float | None,
    latency_ms: int,
) -> None:
    """Record one engine call. `input_text` is hashed, never stored; `input_refs` and
    `output` must not contain text fields (quotes are stored as hashes by the caller)."""
    bad = _find_text_keys(input_refs) + _find_text_keys(output)
    if bad:
        raise TextNotAllowedInLog()
    await audit.record_decision(
        DecisionLogEntry(
            agent_id=ctx.agent_id,
            job_id=ctx.job_id,
            appointment_id=ctx.appointment_id,
            server=server,
            tool=tool,
            engine=engine,
            model=model,
            model_version=model_version,
            prompt_or_question_version=question_version,
            input_refs=json.loads(json.dumps(dict(input_refs), default=str)),
            input_hash=sha256_hex(input_text),
            output=json.loads(json.dumps(dict(output), default=str)),
            probability=probability,
            latency_ms=latency_ms,
        )
    )


class LogNoteResult(BaseModel):
    note_id: int = Field(description="Id of the stored note.")


NoteChecker = Callable[[str], Awaitable[None]]


def register_log_note(
    mcp: MCPServer[Any],
    server: str,
    audit: AuditRepository,
    allowlist: AgentAllowlist,
    check_note: NoteChecker | None = None,
) -> None:
    """Add the `log_note` tool. `check_note` (the personal-information guard) may refuse a note."""

    async def log_note(note: str) -> LogNoteResult:
        """Save a short working note (max 1000 characters) to the audit trail.

        Use it for decisions about how you are doing the task, not for patient
        details: do not copy transcript text, quotes, names or numbers into a
        note. Notes are append-only and cannot be read back through this server.
        """
        text = note.strip()
        if not text or len(text) > MAX_NOTE_CHARS:
            raise InvalidRequest(f"A note must be 1 to {MAX_NOTE_CHARS} characters.")
        if check_note is not None:
            await check_note(text)
        ctx = current_context()
        note_id = await audit.record_note(
            NoteEntry(
                agent_id=ctx.agent_id,
                mode=ctx.mode,
                user_id=ctx.user_id,
                job_id=ctx.job_id,
                appointment_id=ctx.appointment_id,
                server=server,
                note=text,
            )
        )
        return LogNoteResult(note_id=note_id)

    wrapped = with_tool_logging(server, audit, allowlist, tool_name="log_note")(log_note)
    mcp.add_tool(wrapped, name="log_note")
