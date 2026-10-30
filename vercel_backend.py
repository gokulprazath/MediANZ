"""Vercel entrypoint for the "backend" service (vercel.json): `vercel_backend:app`.

The whole Python backend as one ASGI app (src/healthmcp/backend.py). Nothing is
built at import; it starts on the first lifespan event or request.
"""

import sys
from pathlib import Path

# The package lives in src/; add it in case the build installs the dependencies
# without the project itself (for example from requirements.txt).
sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from healthmcp.backend import create_vercel_app  # noqa: E402
from healthmcp.shared.config import load_settings  # noqa: E402
from healthmcp.shared.logging import configure_logging  # noqa: E402

configure_logging(load_settings().log_level, name="backend")

app = create_vercel_app()
