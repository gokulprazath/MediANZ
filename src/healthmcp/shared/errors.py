"""Errors with short, non-revealing public messages.

Tools raise these; the logging wrapper turns them into MCP tool errors that
carry only `public_message`. Detail (never patient text) goes to server logs.
"""

from __future__ import annotations


class HealthMcpError(Exception):
    code = "error"
    public_message = "The request could not be completed."

    def __init__(self, public_message: str | None = None) -> None:
        if public_message is not None:
            self.public_message = public_message
        super().__init__(self.public_message)


class NotAuthenticated(HealthMcpError):
    code = "not_authenticated"
    public_message = "Not authenticated."


class AgentNotAllowed(HealthMcpError):
    code = "agent_not_allowed"
    public_message = "This agent is not allowed to use this server or tool."


class ScopeViolation(HealthMcpError):
    code = "scope_violation"
    public_message = "The requested record is outside this request's scope."


class NotFound(HealthMcpError):
    code = "not_found"
    public_message = "Not found."


class InvalidRequest(HealthMcpError):
    code = "invalid_request"
    public_message = "The request is not valid."


class RateLimited(HealthMcpError):
    code = "rate_limited"
    public_message = "Too many requests. Try again shortly."


class HealthDataNotAllowed(HealthMcpError):
    code = "health_data_not_allowed"
    public_message = "This engine is not approved for health data."


class EngineNotConfigured(HealthMcpError):
    code = "engine_not_configured"
    public_message = "The engine for this tool is not configured."


class EngineFailure(HealthMcpError):
    code = "engine_failure"
    public_message = "The engine failed. Try again later."


class PersonalInformationDetected(HealthMcpError):
    code = "personal_information"
    public_message = "The text contains personal information and was blocked."


class DomainNotAllowed(HealthMcpError):
    code = "domain_not_allowed"
    public_message = "That domain is not on the research allowlist."


class TextNotAllowedInLog(HealthMcpError):
    code = "text_in_log"
    public_message = "Internal error."
