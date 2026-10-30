"""Run the matching server: uv run python -m healthmcp.servers.matching"""

from healthmcp.servers.common import main
from healthmcp.servers.matching.tools import NAME, register

if __name__ == "__main__":
    main(NAME, register)
