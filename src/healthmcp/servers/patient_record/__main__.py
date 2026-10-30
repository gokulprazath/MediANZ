"""Run the patient_record server: uv run python -m healthmcp.servers.patient_record"""

from healthmcp.servers.common import main
from healthmcp.servers.patient_record.tools import NAME, register

if __name__ == "__main__":
    main(NAME, register)
