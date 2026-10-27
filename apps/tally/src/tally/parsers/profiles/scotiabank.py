"""Scotiabank chequing, headerless: date, signed amount, a literal `-`, type, description."""

from tally.model import AccountKind
from tally.parsers.profiles.base import (
    Profile,
    Roles,
    anything,
    by_shape,
    is_amount,
    is_date,
    literal,
    nonempty,
)

DATE_FORMAT = "%m/%d/%y"

ROLES = Roles(date=0, amount=1, type=3, descriptor=(4,))
PROBES = (is_date(DATE_FORMAT), is_amount, literal("-"), nonempty, anything)

PROFILE = Profile(
    id="scotiabank-chequing-headerless",
    institution="Scotiabank",
    has_header=False,
    fingerprint=by_shape(PROBES, ROLES),
    date_format=DATE_FORMAT,
    account_kind=AccountKind.chequing,
)
