"""Run the booking server: uv run python -m healthmcp.servers.booking"""

from healthmcp.servers.booking.tools import NAME, register
from healthmcp.servers.common import main

if __name__ == "__main__":
    main(NAME, register)
