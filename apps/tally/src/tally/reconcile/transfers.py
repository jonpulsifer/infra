"""Pair the two legs of a transfer between the ledger's own accounts.

A pair is an outflow and an inflow of exactly equal cents in different
accounts, dated within the window. Rows that already carry a transfer_id, and
pending rows, are never paired. A pair is `auto` only when each leg has exactly
one candidate (the moneymatter rule). Ambiguous rows still get one proposal
each, chosen one-to-one by the closest date, then by transfer words in the
descriptors (a card's "payment thank you", a brokerage "contribution"), so
accepting every proposal never stamps one row twice.
"""

from __future__ import annotations

import hashlib
from collections import Counter, defaultdict
from collections.abc import Collection, Iterable, Sequence

from tally.model import Transaction, TransferFinding, cents
from tally.reconcile.identity import normalise_descriptor

_HINTS = frozenset(
    {"tfr", "transfer", "xfer", "payment", "pymt", "pmt", "contribution", "contrib", "thank"}
)


def propose(
    transactions: Sequence[Transaction],
    *,
    window_days: int = 4,
    rejected: Collection[tuple[str, str]] = (),
) -> list[TransferFinding]:
    """Transfer proposals. `rejected` holds (out_id, in_id) pairs the owner turned down."""
    if window_days < 0:
        raise ValueError("window_days must be non-negative")
    pairs = _candidates(transactions, window_days, frozenset(rejected))
    per_out = Counter(o.id for o, _ in pairs)
    per_in = Counter(i.id for _, i in pairs)
    used: set[str] = set()
    findings: list[TransferFinding] = []
    for out, inn in sorted(pairs, key=_rank):
        if out.id in used or inn.id in used:
            continue
        used |= {out.id, inn.id}
        findings.append(_finding(out, inn, auto=per_out[out.id] == 1 and per_in[inn.id] == 1))
    return sorted(findings, key=lambda f: (f.out_id, f.in_id))


def apply(
    transactions: Iterable[Transaction],
    accepted: Iterable[TransferFinding],
    *,
    category_id: str,
) -> tuple[Transaction, ...]:
    """Stamp each accepted pair's id on both legs and give them the transfer category."""
    rows = list(transactions)
    by_id = {t.id: t for t in rows}
    stamps: dict[str, str] = {}
    for finding in accepted:
        for leg in (finding.out_id, finding.in_id):
            if leg not in by_id:
                raise ValueError(f"{finding.id}: no transaction {leg}")
            if by_id[leg].transfer_id is not None or leg in stamps:
                raise ValueError(f"{finding.id}: {leg} is already in a transfer")
        if not _legs_fit(by_id[finding.out_id], by_id[finding.in_id]):
            raise ValueError(f"{finding.id}: legs are not an equal and opposite pair")
        stamps[finding.out_id] = stamps[finding.in_id] = finding.id
    return tuple(
        t.model_copy(update={"transfer_id": stamps[t.id], "category_id": category_id})
        if t.id in stamps
        else t
        for t in rows
    )


def _eligible(t: Transaction) -> bool:
    return t.transfer_id is None and not t.pending and cents(t.amount) != 0


def _legs_fit(out: Transaction, inn: Transaction) -> bool:
    return (
        out.account_id != inn.account_id
        and cents(out.amount) < 0
        and cents(out.amount) == -cents(inn.amount)
    )


def _candidates(
    transactions: Sequence[Transaction], window_days: int, rejected: frozenset[tuple[str, str]]
) -> list[tuple[Transaction, Transaction]]:
    inflows: dict[int, list[Transaction]] = defaultdict(list)
    for t in transactions:
        if _eligible(t) and cents(t.amount) > 0:
            inflows[cents(t.amount)].append(t)
    return [
        (out, inn)
        for out in transactions
        if _eligible(out) and cents(out.amount) < 0
        for inn in inflows.get(-cents(out.amount), [])
        if _legs_fit(out, inn)
        and abs((inn.date - out.date).days) <= window_days
        and (out.id, inn.id) not in rejected
    ]


def _hints(t: Transaction) -> int:
    return int(bool(_HINTS & set(normalise_descriptor(t.descriptor).split())))


def _rank(pair: tuple[Transaction, Transaction]) -> tuple[int, int, str, str]:
    out, inn = pair
    return (abs((inn.date - out.date).days), -(_hints(out) + _hints(inn)), out.id, inn.id)


def _finding(out: Transaction, inn: Transaction, *, auto: bool) -> TransferFinding:
    digest = hashlib.sha256(f"{out.id}\x1f{inn.id}".encode()).hexdigest()
    return TransferFinding(
        id=f"xfer_{digest[:16]}",
        out_id=out.id,
        in_id=inn.id,
        days_apart=abs((inn.date - out.date).days),
        auto=auto,
    )
