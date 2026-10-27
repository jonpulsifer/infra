"""The YNAB (classic) register export: 11 headed columns, one row per transaction.

The owner categorised these rows by hand, so the category columns are trusted
and travel as `ynab:<group>/<category>` tags.
"""

from tally.parsers.profiles.base import Profile, Roles, by_header

HEADER = (
    "Account",
    "Flag",
    "Date",
    "Payee",
    "Category Group/Category",
    "Category Group",
    "Category",
    "Memo",
    "Outflow",
    "Inflow",
    "Cleared",
)

ROLES = Roles(
    date=2,
    descriptor=(3,),
    outflow=8,
    inflow=9,
    memo=(7,),
    account=0,
    category=(5, 6),
    pending=10,
)

PROFILE = Profile(
    id="ynab-register",
    institution="YNAB",
    has_header=True,
    fingerprint=by_header(HEADER, ROLES),
    date_format="%Y-%m-%d",
    trust_categories=True,
    tag_prefix="ynab",
    transfer_prefix="Transfer : ",
    pending_values=frozenset({"uncleared"}),
)
