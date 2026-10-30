"""Run the decision server: uv run python -m healthmcp.servers.decision"""

from healthmcp.servers.common import main
from healthmcp.servers.decision.tools import NAME, register

if __name__ == "__main__":
    main(NAME, register)
