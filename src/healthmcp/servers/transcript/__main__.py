"""Run the transcript server: uv run python -m healthmcp.servers.transcript"""

from healthmcp.servers.common import main
from healthmcp.servers.transcript.tools import NAME, register

if __name__ == "__main__":
    main(NAME, register)
