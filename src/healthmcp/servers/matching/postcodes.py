"""Approximate centres for the sample postcodes (spec 6.5; see docs/DECISIONS.md).

A small local table so a postcode never leaves the server. Unknown postcodes
are refused; the agent can ask the patient for a suburb's postcode or use
latitude and longitude instead.
"""

from __future__ import annotations

POSTCODES: dict[str, tuple[float, float]] = {
    "4000": (-27.4698, 153.0251),  # Brisbane City
    "4006": (-27.4560, 153.0330),  # Fortitude Valley
    "4031": (-27.4071, 153.0297),  # Kedron
    "4032": (-27.3856, 153.0312),  # Chermside
    "4064": (-27.4597, 153.0008),  # Paddington
    "4066": (-27.4858, 152.9894),  # Toowong
    "4101": (-27.4800, 153.0170),  # South Brisbane / West End
    "4152": (-27.5053, 153.1015),  # Carindale
    "2000": (-33.8688, 151.2093),  # Sydney
    "2150": (-33.8150, 151.0035),  # Parramatta
}
