"""The whole Python backend as one ASGI app, for the Vercel service "backend".

On Vercel (vercel.json, services mode) the web app reaches this internal
service over a binding (BACKEND_URL); it has no public route. It mounts the two
HTTP APIs the web app calls:

    /agent/...      the agent service (agent.py: /chat, /chat/confirm, /healthz)
    /discovery/...  the discovery API (discovery/app.py: /v1/..., /healthz)

The gateway and the seven MCP servers run in the same process and have no
address at all: the agent reaches the gateway, and the gateway each server,
through in-process ASGI transports, with the same tokens, headers, allowlist,
mode checks and rate limits as over the network. One database pool is shared.

Locally the services still run as separate processes (Makefile); this module is
only used by vercel_backend.py. Nothing is built at import: the backend is
created on lifespan startup, or on the first request when the platform sends no
lifespan events, so a build step never needs the runtime secrets.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AsyncExitStack, asynccontextmanager

import httpx
import httpx2
from fastapi import FastAPI
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from healthmcp.agent import AgentService, GatewayToolFactory
from healthmcp.agent import create_app as create_agent_app
from healthmcp.discovery.app import create_app as create_discovery_app
from healthmcp.gateway.app import MCP_PATH, GatewayConfig
from healthmcp.gateway.app import create_app as create_gateway_app
from healthmcp.gateway.proxy import GatewayProxy
from healthmcp.servers.booking import tools as booking
from healthmcp.servers.common import Register, build
from healthmcp.servers.decision import tools as decision
from healthmcp.servers.extraction import tools as extraction
from healthmcp.servers.matching import tools as matching
from healthmcp.servers.patient_record import tools as patient_record
from healthmcp.servers.transcript import tools as transcript
from healthmcp.servers.web_research import tools as web_research
from healthmcp.shared.config import Settings, load_settings
from healthmcp.shared.db import Database
from healthmcp.shared.server import HealthServer, build_deps

# The seven servers, by name (tool_catalog.SERVERS); each module's tools.register.
REGISTRARS: Mapping[str, Register] = {
    module.NAME: module.register
    for module in (
        transcript,
        decision,
        extraction,
        patient_record,
        matching,
        booking,
        web_research,
    )
}

# In-process hosts: the MCP servers only accept Host 127.0.0.1:* (DNS rebinding
# protection), and the ports keep each upstream URL distinct as on a dev machine.
GATEWAY_URL = f"http://127.0.0.1:3100{MCP_PATH}"


def create_backend(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    servers: Mapping[str, HealthServer] | None = None,
    discovery_app: FastAPI | None = None,
) -> Starlette:
    """Wire every Python service into one app (tests pass fakes for the parts they need)."""
    settings = settings or load_settings()
    db = database
    if db is None and settings.data_backend == "pg":
        if settings.database_url is None:
            raise RuntimeError("DATABASE_URL is required (or set DATA_BACKEND=fake)")
        db = Database.create(
            settings.database_url.get_secret_value(),
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
        )
    if servers is None:
        servers = {
            name: build(name, register, deps=build_deps(settings, db=db))
            for name, register in REGISTRARS.items()
        }

    clients = {
        name: httpx.AsyncClient(
            transport=httpx.ASGITransport(app=server.app),
            base_url=f"http://127.0.0.1:{server.port}",
            timeout=settings.agent_gateway_timeout_seconds,
        )
        for name, server in servers.items()
    }
    upstreams = {name: f"http://127.0.0.1:{s.port}{MCP_PATH}" for name, s in servers.items()}
    gateway = create_gateway_app(
        GatewayConfig(
            host="127.0.0.1",
            port=3100,
            upstreams=upstreams,
            timeout=settings.agent_gateway_timeout_seconds,
            max_request_bytes=settings.max_request_bytes,
        ),
        proxy=GatewayProxy(
            upstreams, timeout=settings.agent_gateway_timeout_seconds, clients=clients
        ),
    )
    agent_service = AgentService(
        settings,
        tool_factory=GatewayToolFactory(
            GATEWAY_URL,
            settings.agent_gateway_timeout_seconds,
            transport=httpx2.ASGITransport(app=gateway),
        ),
    )
    agent = create_agent_app(agent_service)
    discovery = discovery_app or create_discovery_app(settings=settings, database=db)

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            if db is not None:
                await db.open()
                stack.push_async_callback(db.close)
            for server in servers.values():
                # The servers' own lifespans would each open the shared pool;
                # only their MCP session managers need to run here.
                await stack.enter_async_context(server.mcp.session_manager.run())
            for client in clients.values():
                stack.push_async_callback(client.aclose)
            await stack.enter_async_context(gateway.router.lifespan_context(gateway))
            await stack.enter_async_context(discovery.router.lifespan_context(discovery))
            yield

    async def healthz(request: Request) -> Response:
        return JSONResponse({"status": "ok", "server": "backend", "mcp_servers": sorted(servers)})

    app = Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Mount("/agent", app=agent),
            Mount("/discovery", app=discovery),
        ],
        lifespan=lifespan,
    )
    app.state.agent_service = agent_service
    return app


class LazyBackend:
    """Builds and starts the backend once: on lifespan startup or the first request."""

    def __init__(self, factory: Callable[[], Starlette] = create_backend) -> None:
        self._factory = factory
        self._app: Starlette | None = None
        self._stack: AsyncExitStack | None = None
        self._lock = asyncio.Lock()

    @property
    def started(self) -> bool:
        return self._app is not None

    async def start(self) -> Starlette:
        async with self._lock:
            if self._app is None:
                app = self._factory()
                stack = AsyncExitStack()
                await stack.enter_async_context(app.router.lifespan_context(app))
                self._app, self._stack = app, stack
            return self._app

    async def stop(self) -> None:
        async with self._lock:
            if self._stack is not None:
                await self._stack.aclose()
            self._app, self._stack = None, None

    @asynccontextmanager
    async def lifespan(self, app: object) -> AsyncIterator[None]:
        await self.start()
        try:
            yield
        finally:
            await self.stop()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        inner: ASGIApp = await self.start()
        await inner(scope, receive, send)


def create_vercel_app(factory: Callable[[], Starlette] = create_backend) -> FastAPI:
    """The FastAPI instance Vercel loads (vercel_backend:app); everything is built lazily."""
    backend = LazyBackend(factory)
    app = FastAPI(
        title="MediANZ backend",
        lifespan=backend.lifespan,
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
    )
    app.mount("/", backend)
    app.state.backend = backend
    return app
