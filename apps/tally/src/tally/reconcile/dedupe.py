"""Dedupe incoming rows against the ledger and against each other.

Tier 1 pairs rows of one account that carry the same FITID. Tier 2 is a
multiset match: same account, exact cents, dates within the window, each
matched row used at most once per file, preferring the closest date, then the
closest normalised descriptor, then the same pending state, then an
identical id. N identical incoming
rows therefore match at most N rows, so two same-day coffees stay two.

Files in one import are deduped in order: each file is matched against the
ledger plus the new rows of the files before it, with consumption reset per
file, so overlapping exports collapse without one file's rows eating another's.

A row may carry a closed `Period`: a statement period whose rows are known to
add up to the balances the institution asserted at both ends of it. Two rows
in disjoint closed periods are never fuzzy duplicates, because each period
already counts its own; this keeps a repeated purchase on either side of a
statement date. A row with no period is matched as usual.

A pending incoming row that matches a posted one is a duplicate. A posted
incoming row that matches a pending one is a replacement: the finding's reason
starts with "replaces pending", the incoming row stays in `DedupeResult.new`,
and the engine retires the matched row (`DedupeResult.replaces`).

The same row read from two files of one import derives the same id, so two
findings can name one `transaction_id`; `DedupeResult.new` holds indices into
`incoming` and is the unambiguous answer to "what gets inserted".
"""

from __future__ import annotations

import hashlib
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from difflib import SequenceMatcher
from typing import Literal

from tally.model import DuplicateFinding, ParsedRow, Transaction, cents
from tally.reconcile.identity import dedupe_key, normalise_descriptor, transaction_id

Tier = Literal["fitid", "fuzzy"]

type Period = tuple[date, date]
"""A closed statement period, after its first date and through its second."""


@dataclass(frozen=True)
class DedupeResult:
    """`ids[i]` is incoming row i's id; `new` lists the incoming indices to insert."""

    findings: tuple[DuplicateFinding, ...]
    ids: tuple[str, ...]
    new: tuple[int, ...]
    replaces: dict[int, str] = field(default_factory=dict)


@dataclass(frozen=True)
class _Row:
    id: str
    account_id: str
    date: date
    cents: int
    norm: str
    fitid: str | None
    pending: bool
    index: int | None = None
    period: Period | None = None


@dataclass(frozen=True)
class _Match:
    incoming: _Row
    matched: _Row
    tier: Tier
    reason: str


def find_duplicates(
    existing: Sequence[Transaction],
    incoming: Sequence[ParsedRow | Transaction],
    *,
    window_days: int = 3,
    sources: Sequence[str] | None = None,
    account_id: str | None = None,
    periods: Sequence[Period | None] | None = None,
    existing_periods: Mapping[str, Period] | None = None,
) -> list[DuplicateFinding]:
    """See `dedupe`; this returns the findings only."""
    result = dedupe(
        existing,
        incoming,
        window_days=window_days,
        sources=sources,
        account_id=account_id,
        periods=periods,
        existing_periods=existing_periods,
    )
    return list(result.findings)


def dedupe(
    existing: Sequence[Transaction],
    incoming: Sequence[ParsedRow | Transaction],
    *,
    window_days: int = 3,
    sources: Sequence[str] | None = None,
    account_id: str | None = None,
    periods: Sequence[Period | None] | None = None,
    existing_periods: Mapping[str, Period] | None = None,
) -> DedupeResult:
    """Match incoming rows to the ledger.

    `sources` names the file of each incoming row; without it the rows are one
    file and no within-batch pass runs. `account_id` is the account of any
    ParsedRow without an `account_hint` (a CSV import names its account).
    `periods` gives each incoming row its closed period or None, and
    `existing_periods` gives ledger rows theirs by id.
    """
    if window_days < 0:
        raise ValueError("window_days must be non-negative")
    if sources is not None and len(sources) != len(incoming):
        raise ValueError("sources must name one file per incoming row")
    if periods is not None and len(periods) != len(incoming):
        raise ValueError("periods must give one entry per incoming row")
    rows = _incoming_rows(incoming, sources, account_id, periods)
    held = existing_periods or {}
    pool = [_from_transaction(t, period=held.get(t.id)) for t in existing]
    findings: list[DuplicateFinding] = []
    new: list[int] = []
    replaces: dict[int, str] = {}
    for batch in _by_file(rows, sources):
        matches = _match(pool, batch, window_days)
        matched = {m.incoming.index for m in matches}
        for m in matches:
            findings.append(_finding(m))
            if not _is_replacement(m):
                continue
            new.append(_index(m.incoming))
            if m.matched.index is None:
                replaces[_index(m.incoming)] = m.matched.id
            else:
                new.remove(m.matched.index)
                pool.remove(m.matched)
                if m.matched.index in replaces:
                    replaces[_index(m.incoming)] = replaces.pop(m.matched.index)
            pool.append(m.incoming)
        for row in batch:
            if row.index not in matched:
                new.append(_index(row))
                pool.append(row)
    return DedupeResult(
        findings=tuple(findings),
        ids=tuple(r.id for r in rows),
        new=tuple(sorted(new)),
        replaces=replaces,
    )


def _index(row: _Row) -> int:
    assert row.index is not None
    return row.index


def _from_transaction(
    t: Transaction, index: int | None = None, period: Period | None = None
) -> _Row:
    return _Row(
        id=t.id,
        account_id=t.account_id,
        date=t.date,
        cents=cents(t.amount),
        norm=normalise_descriptor(t.descriptor),
        fitid=t.fitid,
        pending=t.pending,
        index=index,
        period=period,
    )


def _incoming_rows(
    incoming: Sequence[ParsedRow | Transaction],
    sources: Sequence[str] | None,
    account_id: str | None,
    periods: Sequence[Period | None] | None,
) -> list[_Row]:
    seen: Counter[tuple[str, str]] = Counter()
    rows: list[_Row] = []
    for i, item in enumerate(incoming):
        period = periods[i] if periods else None
        if isinstance(item, Transaction):
            rows.append(_from_transaction(item, i, period))
            continue
        account = item.account_hint or account_id
        if account is None:
            raise ValueError(f"incoming row {i} has no account; pass account_id")
        amount, norm = cents(item.amount), normalise_descriptor(item.descriptor)
        slot = (sources[i] if sources else "", dedupe_key(account, item.date, amount, norm))
        rid = transaction_id(account, item.date, amount, item.descriptor, occurrence=seen[slot])
        seen[slot] += 1
        rows.append(
            _Row(rid, account, item.date, amount, norm, item.fitid, item.pending, i, period)
        )
    return rows


def _by_file(rows: list[_Row], sources: Sequence[str] | None) -> list[list[_Row]]:
    if sources is None:
        return [rows]
    files: dict[str, list[_Row]] = {}
    for row in rows:
        files.setdefault(sources[_index(row)], []).append(row)
    return list(files.values())


def _match(pool: list[_Row], batch: list[_Row], window_days: int) -> list[_Match]:
    used: set[int] = set()
    matches = _match_fitid(pool, batch, used)
    done = {m.incoming.index for m in matches}
    matches += _match_fuzzy(pool, [r for r in batch if r.index not in done], used, window_days)
    return sorted(matches, key=lambda m: _index(m.incoming))


def _match_fitid(pool: list[_Row], batch: list[_Row], used: set[int]) -> list[_Match]:
    by_fitid: dict[tuple[str, str], list[int]] = defaultdict(list)
    for p, row in enumerate(pool):
        if row.fitid:
            by_fitid[(row.account_id, row.fitid)].append(p)
    matches: list[_Match] = []
    for row in batch:
        if not row.fitid:
            continue
        free = [p for p in by_fitid.get((row.account_id, row.fitid), []) if p not in used]
        if free:
            best = min(free, key=lambda p: (_preference(row, pool[p]), p))
            used.add(best)
            matches.append(_Match(row, pool[best], "fitid", _fitid_reason(row, pool[best])))
    return matches


def _match_fuzzy(
    pool: list[_Row], batch: list[_Row], used: set[int], window_days: int
) -> list[_Match]:
    by_amount: dict[tuple[str, int], list[int]] = defaultdict(list)
    for p, row in enumerate(pool):
        if p not in used:
            by_amount[(row.account_id, row.cents)].append(p)
    pairs: list[tuple[tuple[int, float, tuple[bool, bool], int, int], int, _Row]] = []
    for row in batch:
        for p in by_amount.get((row.account_id, row.cents), []):
            other = pool[p]
            days = abs((row.date - other.date).days)
            if days > window_days or _fitids_conflict(row, other) or _closed_apart(row, other):
                continue
            distance = 1.0 - SequenceMatcher(None, row.norm, other.norm).ratio()
            pairs.append(((days, distance, _preference(row, other), _index(row), p), p, row))
    taken: set[int | None] = set()
    matches: list[_Match] = []
    for _, p, row in sorted(pairs, key=lambda pair: pair[0]):
        if p in used or row.index in taken:
            continue
        used.add(p)
        taken.add(row.index)
        matches.append(_Match(row, pool[p], "fuzzy", _fuzzy_reason(row, pool[p])))
    return matches


def _preference(row: _Row, other: _Row) -> tuple[bool, bool]:
    return (row.pending != other.pending, row.id != other.id)


def _fitids_conflict(a: _Row, b: _Row) -> bool:
    return bool(a.fitid and b.fitid and a.fitid != b.fitid and a.norm != b.norm)


def _closed_apart(a: _Row, b: _Row) -> bool:
    if a.period is None or b.period is None:
        return False
    return a.period[1] <= b.period[0] or b.period[1] <= a.period[0]


def _is_replacement(m: _Match) -> bool:
    return m.matched.pending and not m.incoming.pending


def _pending_note(m: _Row, other: _Row) -> str:
    if other.pending and not m.pending:
        return "replaces pending row: "
    if m.pending and not other.pending:
        return "pending row already posted: "
    return ""


def _fitid_reason(row: _Row, other: _Row) -> str:
    changed = [
        name
        for name, differs in (
            ("date", row.date != other.date),
            ("amount", row.cents != other.cents),
            ("descriptor", row.norm != other.norm),
        )
        if differs
    ]
    tail = f"; {', '.join(changed)} changed" if changed else ""
    return f"{_pending_note(row, other)}same FITID{tail}"


def _fuzzy_reason(row: _Row, other: _Row) -> str:
    days = abs((row.date - other.date).days)
    when = "same day" if days == 0 else f"{days} day{'s' if days > 1 else ''} apart"
    desc = "same descriptor" if row.norm == other.norm else "descriptor differs"
    flag = "; FITIDs differ" if row.fitid and other.fitid and row.fitid != other.fitid else ""
    return f"{_pending_note(row, other)}same amount, {when}, {desc}{flag}"


def _finding(m: _Match) -> DuplicateFinding:
    key = f"{m.incoming.id}\x1f{m.matched.id}\x1f{m.incoming.index}"
    digest = hashlib.sha256(key.encode()).hexdigest()
    return DuplicateFinding(
        id=f"dup_{digest[:16]}",
        transaction_id=m.incoming.id,
        matches_id=m.matched.id,
        reason=m.reason,
        tier=m.tier,
    )
