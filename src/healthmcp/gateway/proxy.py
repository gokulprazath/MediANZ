from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from typing import Any

import httpx

from healthmcp.shared.tool_catalog import SERVERS

logger = logging.getLogger("healthmcp.gateway")

SEPARATOR = "__"
JSONRPC_VERSION = "2.0"
FORWARDED_HEADERS = ("authorization", "x-agent-id")
SAFE_ERROR_MESSAGES = {
    -32700: "Parse error",
    -32600: "Invalid request",
    -32601: "Tool not available",
    -32602: "Invalid params",
    -32603: "Tool call failed",
}


class GatewayError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def split_tool_name(name: str) -> tuple[str, str] | None:
    server, separator, tool = name.partition(SEPARATOR)
    if not separator or not server or not tool or SEPARATOR in tool:
        return None
    return server, tool


def _forward_headers(headers: Mapping[str, str]) -> dict[str, str]:
    forwarded = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
    }
    for name in FORWARDED_HEADERS:
        value = headers.get(name)
        if value:
            forwarded[name] = value
    return forwarded


class GatewayProxy:
    def __init__(
        self,
        urls: Mapping[str, str],
        *,
        timeout: float = 30.0,
        clients: Mapping[str, httpx.AsyncClient] | None = None,
    ) -> None:
        self._urls = dict(urls)
        self._clients = dict(clients) if clients is not None else None
        self._owned = None if clients is not None else httpx.AsyncClient(timeout=timeout)

    def _client(self, server: str) -> httpx.AsyncClient:
        if self._clients is not None:
            client = self._clients.get(server)
            if client is None:
                raise GatewayError(-32603, "Upstream unavailable")
            return client
        if self._owned is None:
            raise GatewayError(-32603, "Upstream unavailable")
        return self._owned

    async def aclose(self) -> None:
        if self._owned is not None:
            await self._owned.aclose()

    @staticmethod
    def _rename(server: str, tool: dict[str, Any]) -> dict[str, Any] | None:
        name = tool.get("name")
        if not isinstance(name, str) or not name:
            return None
        renamed = dict(tool)
        renamed["name"] = f"{server}{SEPARATOR}{name}"
        description = renamed.get("description")
        if isinstance(description, str) and description:
            renamed["description"] = f"[{server}] {description}"
        else:
            renamed["description"] = f"[{server}]"
        return renamed

    async def _list_one(
        self, server: str, url: str, headers: Mapping[str, str]
    ) -> list[dict[str, Any]]:
        body = {"jsonrpc": JSONRPC_VERSION, "id": 1, "method": "tools/list", "params": {}}
        try:
            response = await self._client(server).post(
                url, json=body, headers=_forward_headers(headers)
            )
        except Exception as exc:
            logger.warning(
                "upstream tools/list failed",
                extra={"server": server, "error": type(exc).__name__},
            )
            return []
        if response.status_code in (401, 403):
            logger.info("upstream tools/list not allowed", extra={"server": server})
            return []
        if response.status_code != 200:
            logger.warning(
                "upstream tools/list status",
                extra={"server": server, "status": response.status_code},
            )
            return []
        try:
            data = response.json()
        except ValueError:
            logger.warning("upstream tools/list invalid json", extra={"server": server})
            return []
        if not isinstance(data, dict):
            return []
        result = data.get("result")
        if not isinstance(result, dict):
            return []
        tools = result.get("tools")
        if not isinstance(tools, list):
            return []
        renamed = [
            item
            for tool in tools
            if isinstance(tool, dict)
            for item in [self._rename(server, tool)]
            if item is not None
        ]
        return renamed

    async def list_tools(self, headers: Mapping[str, str]) -> list[dict[str, Any]]:
        batches = await asyncio.gather(
            *(self._list_one(server, url, headers) for server, url in self._urls.items())
        )
        tools = [tool for batch in batches for tool in batch]
        return sorted(tools, key=lambda tool: str(tool.get("name", "")))

    async def call_tool(
        self, headers: Mapping[str, str], name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        parsed = split_tool_name(name)
        if parsed is None:
            raise GatewayError(-32602, "Invalid tool name")
        server, tool = parsed
        url = self._urls.get(server)
        spec = SERVERS.get(server)
        if url is None or spec is None or tool not in spec.tools:
            raise GatewayError(-32601, "Tool not available")
        body = {
            "jsonrpc": JSONRPC_VERSION,
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        try:
            response = await self._client(server).post(
                url, json=body, headers=_forward_headers(headers)
            )
        except Exception as exc:
            logger.warning(
                "upstream tools/call failed",
                extra={"server": server, "tool": tool, "error": type(exc).__name__},
            )
            raise GatewayError(-32603, "Upstream unavailable") from exc
        if response.status_code in (401, 403):
            raise GatewayError(-32601, "Tool not available")
        if response.status_code == 404:
            raise GatewayError(-32601, "Tool not available")
        if response.status_code != 200:
            logger.warning(
                "upstream tools/call status",
                extra={"server": server, "tool": tool, "status": response.status_code},
            )
            raise GatewayError(-32603, "Upstream unavailable")
        try:
            data = response.json()
        except ValueError as exc:
            raise GatewayError(-32603, "Upstream unavailable") from exc
        if not isinstance(data, dict):
            raise GatewayError(-32603, "Upstream unavailable")
        error = data.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            raise GatewayError(
                code if isinstance(code, int) and code in SAFE_ERROR_MESSAGES else -32603,
                SAFE_ERROR_MESSAGES.get(code, "Tool call failed")
                if isinstance(code, int)
                else "Tool call failed",
            )
        result = data.get("result")
        if not isinstance(result, dict):
            raise GatewayError(-32603, "Upstream unavailable")
        return result
