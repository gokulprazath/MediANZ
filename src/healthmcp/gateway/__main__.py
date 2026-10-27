from __future__ import annotations

import os

import uvicorn

from healthmcp.gateway.app import GatewayConfig, create_app
from healthmcp.shared.logging import configure_logging


def main() -> None:
    config = GatewayConfig.from_env()
    configure_logging(os.getenv("LOG_LEVEL", "INFO"))
    uvicorn.run(create_app(config), host=config.host, port=config.port, log_config=None)


if __name__ == "__main__":
    main()
