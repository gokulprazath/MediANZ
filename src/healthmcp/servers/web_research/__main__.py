"""Run the web_research server: uv run python -m healthmcp.servers.web_research"""

from healthmcp.servers.common import main
from healthmcp.servers.web_research.tools import NAME, register

if __name__ == "__main__":
    main(NAME, register)
