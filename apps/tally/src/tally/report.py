"""The dashboard aggregates: a port of web/src/fixtures/derive.ts.

Pure functions over a Ledger. Transfers count as neither spend nor income, and
a category resolves to its top-level ancestor. Money stays Decimal; `to_json`
turns any result into the camelCase, float-valued shape the web's types read.
Month filters compare `YYYY-MM` strings and date filters compare dates, as the
TypeScript does.
"""

from __future__ import annotations

import calendar
import datetime as dt
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields, is_dataclass
from datetime import date, datetime
from decimal import ROUND_FLOOR, Decimal
from enum import Enum
from typing import Literal, Protocol

from pydantic import BaseModel

from tally import fx
from tally.model import (
    AccountKind,
    Category,
    Flow,
    HoldingSnapshot,
    Ledger,
    Transaction,
)

UNCATEGORIZED = "uncategorized"
ZERO = Decimal(0)

type JSON = bool | int | float | str | list[JSON] | dict[str, JSON] | None


def js_round(x: Decimal) -> Decimal:
    """Math.round: nearest integer, ties toward positive infinity."""
    return (x + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR)


def month_key(on: date) -> str:
    return on.isoformat()[:7]


def _month_end(month: str) -> date:
    y, m = int(month[:4]), int(month[5:7])
    return date(y, m, calendar.monthrange(y, m)[1])


class Taxonomy:
    """Category lookups for one ledger, with the top-level ancestor cached."""

    def __init__(self, categories: Iterable[Category]) -> None:
        self.by_id = {c.id: c for c in categories}
        self._top: dict[str, Category] = {}

    def get(self, category_id: str) -> Category:
        found = self.by_id.get(category_id) or self.by_id.get(UNCATEGORIZED)
        if found is None:
            return Category(
                id=UNCATEGORIZED, name="Uncategorized", parent_id=None, flow=Flow.expense
            )
        return found

    def top(self, category_id: str) -> Category:
        if category_id not in self._top:
            c = self.get(category_id)
            seen = {c.id}
            while c.parent_id and c.parent_id in self.by_id and c.parent_id not in seen:
                c = self.by_id[c.parent_id]
                seen.add(c.id)
            self._top[category_id] = c
        return self._top[category_id]

    def is_spend(self, t: Transaction) -> bool:
        return (
            t.transfer_id is None and self.top(t.category_id).flow is Flow.expense and t.amount < 0
        )

    def is_income(self, t: Transaction) -> bool:
        return (
            t.transfer_id is None and self.top(t.category_id).flow is Flow.income and t.amount > 0
        )


def taxonomy(ledger: Ledger) -> Taxonomy:
    return Taxonomy(ledger.categories)


def months(ledger: Ledger) -> list[str]:
    """Every month the ledger says something about: a row, a snapshot, a valuation, a balance."""
    dated = (
        *(t.date for t in ledger.transactions),
        *(h.date for h in ledger.holdings),
        *(v.date for v in ledger.valuations),
        *(a.date for a in ledger.assertions),
    )
    return sorted({month_key(d) for d in dated})


def _in_months(m: str, start: str | None, end: str | None) -> bool:
    return not (start and m < start) and not (end and m > end)


def _in_dates(d: date, start: date | None, end: date | None) -> bool:
    return not (start and d < start) and not (end and d > end)


@dataclass(frozen=True)
class SpendRow:
    month: str
    totals: dict[str, Decimal]

    def __json__(self) -> JSON:
        return {"month": self.month, **{k: float(v) for k, v in self.totals.items()}}


@dataclass(frozen=True)
class SpendByCategory:
    keys: list[str]
    names: dict[str, str]
    rows: list[SpendRow]


def monthly_spend_by_category(
    ledger: Ledger,
    *,
    start: str | None = None,
    end: str | None = None,
    level: Literal["top", "leaf"] = "top",
) -> SpendByCategory:
    tax = taxonomy(ledger)
    rows: dict[str, dict[str, Decimal]] = {}
    for t in ledger.transactions:
        m = month_key(t.date)
        if not tax.is_spend(t) or not _in_months(m, start, end):
            continue
        key = tax.top(t.category_id).id if level == "top" else t.category_id
        row = rows.setdefault(m, {})
        row[key] = row.get(key, ZERO) - t.amount
    keys = list(dict.fromkeys(k for r in rows.values() for k in r))
    names = {k: tax.by_id[k].name if k in tax.by_id else k for k in keys}
    return SpendByCategory(
        keys=keys, names=names, rows=[SpendRow(m, rows[m]) for m in sorted(rows)]
    )


@dataclass(frozen=True)
class MerchantTotal:
    merchant: str
    total: Decimal
    count: int
    category_id: str


def top_merchants(
    ledger: Ledger, *, start: date | None = None, end: date | None = None, limit: int = 10
) -> list[MerchantTotal]:
    tax = taxonomy(ledger)
    agg: dict[str, MerchantTotal] = {}
    for t in ledger.transactions:
        if not tax.is_spend(t) or not _in_dates(t.date, start, end):
            continue
        prev = agg.get(t.merchant) or MerchantTotal(t.merchant, ZERO, 0, t.category_id)
        agg[t.merchant] = MerchantTotal(
            prev.merchant, prev.total - t.amount, prev.count + 1, prev.category_id
        )
    return sorted(agg.values(), key=lambda a: -a.total)[:limit]


@dataclass(frozen=True)
class CashFlowRow:
    month: str
    income: Decimal
    spend: Decimal
    net: Decimal


def cash_flow(
    ledger: Ledger, *, start: str | None = None, end: str | None = None
) -> list[CashFlowRow]:
    tax = taxonomy(ledger)
    income: dict[str, Decimal] = {}
    spend: dict[str, Decimal] = {}
    for t in ledger.transactions:
        m = month_key(t.date)
        if not _in_months(m, start, end):
            continue
        income.setdefault(m, ZERO)
        spend.setdefault(m, ZERO)
        if tax.is_income(t):
            income[m] += t.amount
        elif tax.is_spend(t):
            spend[m] -= t.amount
    return [CashFlowRow(m, income[m], spend[m], income[m] - spend[m]) for m in sorted(income)]


def balances_by_month(ledger: Ledger) -> dict[str, dict[str, Decimal]]:
    """Running balance per account at each month end, from transactions alone."""
    ms = months(ledger)
    flows: dict[str, dict[str, Decimal]] = {a.id: {} for a in ledger.accounts}
    for t in ledger.transactions:
        if t.account_id in flows:
            per = flows[t.account_id]
            m = month_key(t.date)
            per[m] = per.get(m, ZERO) + t.amount
    out: dict[str, dict[str, Decimal]] = {}
    for account_id, per in flows.items():
        bal = ZERO
        series: dict[str, Decimal] = {}
        for m in ms:
            bal += per.get(m, ZERO)
            series[m] = bal
        out[account_id] = series
    return out


@dataclass(frozen=True)
class NetWorthPoint:
    """`estimated` is true when a component is carried forward from an older snapshot."""

    month: str
    cash: Decimal
    investments: Decimal
    house: Decimal
    mortgage: Decimal
    total: Decimal
    estimated: bool


_CASH_KINDS = frozenset({AccountKind.chequing, AccountKind.savings, AccountKind.credit})


class _Dated(Protocol):
    @property
    def date(self) -> dt.date: ...


def _latest[T: _Dated](items: Iterable[T], on: dt.date | None = None) -> T | None:
    """The newest item on or before `on`; of equal dates the last one, as `.slice(-1)` picks."""
    best: T | None = None
    for item in items:
        if (on is None or item.date <= on) and (best is None or item.date >= best.date):
            best = item
    return best


def net_worth_series(ledger: Ledger) -> list[NetWorthPoint]:
    """Investments, assets and the mortgage use the latest record on or before each month end."""
    bal = balances_by_month(ledger)
    cash_ids = [a.id for a in ledger.accounts if a.kind in _CASH_KINDS]
    by_kind = {k: [a.id for a in ledger.accounts if a.kind is k] for k in AccountKind}
    currency = {a.id: a.currency for a in ledger.accounts}
    points: list[NetWorthPoint] = []
    for m in months(ledger):
        end = _month_end(m)
        cash = sum((bal[i].get(m, ZERO) for i in cash_ids), ZERO)
        estimated = False
        investments = house = mortgage = ZERO
        for i in by_kind[AccountKind.investment]:
            snap = _latest((h for h in ledger.holdings if h.account_id == i), end)
            if snap is not None:
                investments += fx.to_cad(snap.total, currency[i], snap.date)
                estimated |= month_key(snap.date) != m
        for i in by_kind[AccountKind.asset]:
            val = _latest((v for v in ledger.valuations if v.account_id == i), end)
            if val is not None:
                house += val.value
                estimated |= month_key(val.date) != m
        for i in by_kind[AccountKind.mortgage]:
            owed = _latest((a for a in ledger.assertions if a.account_id == i), end)
            if owed is not None:
                mortgage += owed.balance
        points.append(
            NetWorthPoint(
                month=m,
                cash=js_round(cash),
                investments=js_round(investments),
                house=js_round(house),
                mortgage=js_round(mortgage),
                total=js_round(cash + investments + house + mortgage),
                estimated=estimated,
            )
        )
    return points


@dataclass(frozen=True)
class SankeyNode:
    id: str
    name: str
    kind: Literal["source", "group", "leaf"]


@dataclass(frozen=True)
class SankeyLink:
    source: str
    target: str
    value: Decimal


@dataclass(frozen=True)
class Sankey:
    nodes: list[SankeyNode]
    links: list[SankeyLink]


def sankey(ledger: Ledger, *, start: date, end: date) -> Sankey:
    """Income sources to the 'all' pool to top-level groups to leaf categories."""
    tax = taxonomy(ledger)
    nodes: dict[str, SankeyNode] = {}
    links: dict[tuple[str, str], Decimal] = {}

    def add(s: str, t: str, v: Decimal) -> None:
        links[(s, t)] = links.get((s, t), ZERO) + v

    income = ZERO
    for t in ledger.transactions:
        if not _in_dates(t.date, start, end):
            continue
        if tax.is_income(t):
            src = f"src:{t.merchant}"
            nodes[src] = SankeyNode(src, t.merchant, "source")
            add(src, "all", t.amount)
            income += t.amount
        elif tax.is_spend(t):
            top, leaf = tax.top(t.category_id), tax.get(t.category_id)
            nodes[f"grp:{top.id}"] = SankeyNode(f"grp:{top.id}", top.name, "group")
            nodes[f"leaf:{leaf.id}"] = SankeyNode(f"leaf:{leaf.id}", leaf.name, "leaf")
            add("all", f"grp:{top.id}", -t.amount)
            if leaf.id != top.id:
                add(f"grp:{top.id}", f"leaf:{leaf.id}", -t.amount)
    nodes["all"] = SankeyNode("all", "Income", "group")
    spent = sum((v for (s, _), v in links.items() if s == "all"), ZERO)
    if income > spent:
        nodes["leaf:saved"] = SankeyNode("leaf:saved", "Saved", "leaf")
        add("all", "leaf:saved", income - spent)
    return Sankey(
        nodes=list(nodes.values()),
        links=[SankeyLink(s, t, js_round(v)) for (s, t), v in links.items()],
    )


def latest_holdings(ledger: Ledger, account_id: str) -> HoldingSnapshot | None:
    return _latest(h for h in ledger.holdings if h.account_id == account_id)


def account_balance(ledger: Ledger, account_id: str) -> Decimal:
    acct = next((a for a in ledger.accounts if a.id == account_id), None)
    if acct is None:
        return ZERO
    if acct.kind is AccountKind.investment:
        snap = latest_holdings(ledger, account_id)
        return snap.total if snap else ZERO
    if acct.kind is AccountKind.asset:
        val = _latest(v for v in ledger.valuations if v.account_id == account_id)
        return val.value if val else ZERO
    if acct.kind is AccountKind.mortgage:
        owed = _latest(a for a in ledger.assertions if a.account_id == account_id)
        return owed.balance if owed else ZERO
    return sum((t.amount for t in ledger.transactions if t.account_id == account_id), ZERO)


def search_transactions(
    ledger: Ledger,
    *,
    text: str | None = None,
    account_id: str | None = None,
    category_id: str | None = None,
    start: date | None = None,
    end: date | None = None,
    limit: int | None = None,
) -> list[Transaction]:
    """Newest first. A category matches itself or, for a top-level id, any descendant."""
    tax = taxonomy(ledger)
    needle = text.strip().lower() if text else ""
    out: list[Transaction] = []
    for t in reversed(ledger.transactions):
        if account_id and t.account_id != account_id:
            continue
        if category_id and category_id not in (t.category_id, tax.top(t.category_id).id):
            continue
        if not _in_dates(t.date, start, end):
            continue
        if needle and needle not in t.descriptor.lower() and needle not in t.merchant.lower():
            continue
        out.append(t)
        if limit and len(out) >= limit:
            break
    return out


_SNAKE = re.compile(r"_([a-z])")
_RENAMES = {"date_from": "from", "date_to": "to"}


def camel(name: str) -> str:
    return _RENAMES.get(name) or _SNAKE.sub(lambda m: m.group(1).upper(), name)


def to_json(value: object) -> JSON:
    """The web's shape: camelCase keys, money as numbers, dates as ISO strings."""
    if value is None or isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Enum):
        return to_json(value.value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    custom = getattr(value, "__json__", None)
    if callable(custom):
        result: JSON = custom()
        return result
    if isinstance(value, BaseModel):
        return {camel(k): to_json(getattr(value, k)) for k in type(value).model_fields}
    if is_dataclass(value) and not isinstance(value, type):
        return {camel(f.name): to_json(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, Mapping):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [to_json(v) for v in value]
    raise TypeError(f"not JSON-serialisable: {type(value).__name__}")
