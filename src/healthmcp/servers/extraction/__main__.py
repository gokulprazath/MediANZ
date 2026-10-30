"""Run the extraction server: uv run python -m healthmcp.servers.extraction"""

from healthmcp.servers.common import main
from healthmcp.servers.extraction.tools import NAME, register

if __name__ == "__main__":
    main(NAME, register)
