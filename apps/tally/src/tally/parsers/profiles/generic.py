"""Any headed CSV whose header names a date, an amount (or debit and credit) and a description.

The column names cover the headed exports the formats research lists for RBC,
TD, Tangerine, Simplii, Wealthsimple and Amex Canada. The layout is a guess,
so the profile asks the owner to confirm it before anything is applied.
"""

from collections.abc import Sequence

from tally.parsers.profiles.base import Profile, Roles, Row, Sign, Table, header_shaped, norm

DATE = (
    "transaction date",
    "date",
    "trans. date",
    "trans date",
    "transaction_date",
    "posted date",
    "posting date",
    "date posted",
)
AMOUNT = (
    "amount",
    "cad$",
    "cad",
    "amount (cad)",
    "amount cad",
    "transaction amount",
    "net_cash_amount",
    "net amount",
)
OUTFLOW = (
    "debit",
    "debits",
    "withdrawal",
    "withdrawals",
    "withdrawals ($)",
    "money out",
    "outflow",
    "debit amount",
    "withdrawal amount",
)
INFLOW = (
    "credit",
    "credits",
    "deposit",
    "deposits",
    "deposits ($)",
    "money in",
    "inflow",
    "credit amount",
    "deposit amount",
)
DESCRIPTOR = (
    "description",
    "description 1",
    "transaction description",
    "name",
    "payee",
    "merchant",
    "merchant name",
    "details",
    "transaction details",
)
EXTRA_DESCRIPTOR = ("description 2",)
MEMO = ("memo", "notes")
TYPE = ("transaction", "type", "transaction type", "activity_sub_type")
BALANCE = ("balance", "running balance", "balance ($)")
ACCOUNT = ("account number", "account #", "account")
CATEGORY = ("category",)
CARD_OUT_POSITIVE = ("cardmember", "card member")
WORDS = frozenset(
    (
        *DATE,
        *AMOUNT,
        *OUTFLOW,
        *INFLOW,
        *DESCRIPTOR,
        *EXTRA_DESCRIPTOR,
        *MEMO,
        *TYPE,
        *BALANCE,
        *ACCOUNT,
        *CATEGORY,
        *CARD_OUT_POSITIVE,
    )
)


def _find(header: Row, names: Sequence[str]) -> int | None:
    cells = [norm(c) for c in header]
    return next((cells.index(n) for n in names if n in cells), None)


def _all(header: Row, names: Sequence[str]) -> tuple[int, ...]:
    return tuple(i for n in names if (i := _find(header, (n,))) is not None)


def fingerprint(table: Table) -> Roles | None:
    if not table or not header_shaped(table[0]):
        return None
    header = table[0]
    date, desc = _find(header, DATE), _find(header, DESCRIPTOR)
    amount = _find(header, AMOUNT)
    outflow, inflow = _find(header, OUTFLOW), _find(header, INFLOW)
    split = amount is None and outflow is not None and inflow is not None
    if date is None or desc is None or (amount is None and not split):
        return None
    card = any(_find(header, (n,)) is not None for n in CARD_OUT_POSITIVE)
    return Roles(
        date=date,
        descriptor=(desc, *_all(header, EXTRA_DESCRIPTOR)),
        amount=amount,
        outflow=outflow if split else None,
        inflow=inflow if split else None,
        memo=_all(header, MEMO),
        type=_find(header, TYPE),
        balance=_find(header, BALANCE),
        account=_find(header, ACCOUNT),
        category=_all(header, CATEGORY),
        sign=Sign.out_positive if card and not split else None,
    )


PROFILE = Profile(
    id="generic",
    institution=None,
    has_header=True,
    fingerprint=fingerprint,
    date_format=None,
    delimiter=None,
    confirm=True,
    skip_blank_amounts=True,
)
