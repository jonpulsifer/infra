"""Check running totals against the balances institutions asserted.

An assertion's balance is the account's balance at the end of its date: every
posted row dated on or before it counts, pending rows do not. Balances use the
ledger's sign, the plain sum of signed amounts, so a parser states a card's
balance owing as a negative number. Amounts compare in exact cents.

Opening balance. When the caller passes one for an account, every assertion
is checked against it. When it does not, the earliest assertion is the anchor:
the opening balance is inferred as that assertion's balance less the rows
dated on or before it, so the anchor holds by construction and is marked
`anchor` in the ladder rather than checked. When the earliest assertion
predates all rows, as a statement's opening balance does, the inferred opening
is simply its balance.

A failure re-anchors: the running total takes the asserted balance from that
date on, so one gap yields one finding instead of one at every later
assertion. A failing rung's span runs from the last assertion that held, or
anchored, or the account's first row or assertion, to the failing date.
`difference` is expected less actual: positive means the ledger is missing
money coming in, negative means it is missing money going out (or holds a
duplicate).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from types import MappingProxyType

from tally.model import CENT, BalanceAssertion, MissingPeriodFinding, Transaction, cents

_NO_OPENING: Mapping[str, Decimal] = MappingProxyType({})


@dataclass(frozen=True)
class Rung:
    """One assertion on the ladder: what the institution said against what the ledger sums to."""

    assertion: BalanceAssertion
    since: date
    expected: Decimal
    actual: Decimal
    difference: Decimal
    anchor: bool = False

    @property
    def held(self) -> bool:
        return self.difference == 0


def check(
    transactions: Sequence[Transaction],
    assertions: Sequence[BalanceAssertion],
    *,
    opening: Mapping[str, Decimal] = _NO_OPENING,
) -> list[MissingPeriodFinding]:
    accounts = dict.fromkeys(a.account_id for a in assertions)
    return [
        _finding(rung)
        for account in accounts
        for rung in ladder(account, transactions, assertions, opening=opening.get(account))
        if not rung.held
    ]


def ladder(
    account_id: str,
    transactions: Sequence[Transaction],
    assertions: Sequence[BalanceAssertion],
    *,
    opening: Decimal | None = None,
) -> list[Rung]:
    rows = sorted(
        (t for t in transactions if t.account_id == account_id and not t.pending),
        key=lambda t: t.date,
    )
    asserted = sorted((a for a in assertions if a.account_id == account_id), key=lambda a: a.date)
    if not asserted:
        return []
    since = min([asserted[0].date, *(t.date for t in rows[:1])])
    inferred = opening is None
    if opening is None:
        first = asserted[0]
        opening = first.balance - sum((t.amount for t in rows if t.date <= first.date), Decimal())
    running, taken = opening, 0
    rungs: list[Rung] = []
    for i, assertion in enumerate(asserted):
        while taken < len(rows) and rows[taken].date <= assertion.date:
            running += rows[taken].amount
            taken += 1
        rungs.append(_rung(assertion, since, running, anchor=inferred and i == 0))
        running = assertion.balance
        since = assertion.date
    return rungs


def _rung(assertion: BalanceAssertion, since: date, actual: Decimal, *, anchor: bool) -> Rung:
    expected = assertion.balance.quantize(CENT)
    actual = actual.quantize(CENT)
    difference = Decimal(cents(expected) - cents(actual)) / 100
    return Rung(assertion, since, expected, actual, difference.quantize(CENT), anchor)


def _finding(rung: Rung) -> MissingPeriodFinding:
    a = rung.assertion
    key = f"{a.account_id}\x1f{rung.since.isoformat()}\x1f{a.date.isoformat()}\x1f{a.origin}"
    return MissingPeriodFinding(
        id=f"gap_{hashlib.sha256(key.encode()).hexdigest()[:16]}",
        account_id=a.account_id,
        date_from=rung.since,
        date_to=a.date,
        expected_balance=rung.expected,
        actual_balance=rung.actual,
    )
