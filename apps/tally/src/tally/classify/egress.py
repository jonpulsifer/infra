"""The one form a descriptor takes on its way to a model provider.

Payee and memo text carries masked card numbers, account numbers and
e-transfer references. `scrub` replaces each with `PLACEHOLDER` before a
descriptor is asked about, audited or cached, so no number of that shape
leaves the process. `pattern` turns a scrubbed descriptor back into a rule
body that matches the raw descriptors it came from.
"""

from __future__ import annotations

import re

PLACEHOLDER = "[ref]"
_SENSITIVE = re.compile(
    r"\d{4}[x*•]{4,}\d{4}"
    r"|[x*•]{2,}[\s-]?\d{2,4}"
    r"|\d{4}(?:[\s-]\d{4}){2,}"
    r"|\d{6,}",
    re.IGNORECASE,
)
_PLACEHOLDER_RUN = re.compile(rf"{re.escape(PLACEHOLDER)}(?:\s*{re.escape(PLACEHOLDER)})*")


def scrub(descriptor: str) -> str:
    """Collapse whitespace and replace every number-shaped identifier."""
    return " ".join(
        _PLACEHOLDER_RUN.sub(PLACEHOLDER, _SENSITIVE.sub(PLACEHOLDER, descriptor)).split()
    )


def pattern(scrubbed: str) -> str:
    """A casefolded regex body: the literal text, with each placeholder matching any identifier."""
    parts = " ".join(scrubbed.casefold().split()).split(PLACEHOLDER)
    return r"\S.*?".join(re.escape(p) for p in parts)
