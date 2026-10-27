"""The CSV profile registry, in sniff order: specific shapes before the generic guess."""

from collections.abc import Iterable

from tally.parsers.profiles import generic, scotiabank, ynab
from tally.parsers.profiles.base import Profile, Roles, Row, Sign, Table, header_shaped, norm

PROFILES: tuple[Profile, ...] = (ynab.PROFILE, scotiabank.PROFILE, generic.PROFILE)

_KNOWN = frozenset(norm(w) for w in (*generic.WORDS, *ynab.HEADER))


def describe_header(row: Row, known: Iterable[str] = ()) -> str:
    """How an error names a first row it could not match.

    A headerless file's first row is data, and a header-shaped row may be too,
    so the cells are echoed only when every one is a known column name.
    """
    cells = [c.strip() for c in row if c.strip()]
    if not cells or not header_shaped(row):
        return "no header row"
    allowed = _KNOWN | {norm(w) for w in known}
    if all(norm(c) in allowed for c in cells):
        return f"header {cells}"
    return "an unrecognised header row"


__all__ = ["PROFILES", "Profile", "Roles", "Sign", "Table", "describe_header"]
