"""The deterministic synthetic ledger: a port of web/src/fixtures/generate.ts.

Same seed, same PRNG (mulberry32), same draw order and the same float
arithmetic, so the API and the web fixture show the same numbers. Money is
generated as floats exactly as the TypeScript does and becomes Decimal only at
the edge. Nothing here is real.
"""

from __future__ import annotations

import calendar
import hashlib
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    Category,
    DuplicateFinding,
    Finding,
    Flow,
    HoldingSnapshot,
    ImportBatch,
    ImportPreview,
    Ledger,
    LowConfidenceFinding,
    Member,
    MissingPeriodFinding,
    ParsedFile,
    ParsedRow,
    Position,
    PreviewFile,
    Rule,
    Source,
    Transaction,
    TransferFinding,
    Valuation,
)

_MASK = 0xFFFFFFFF
START = date(2021, 1, 1)
END = date(2026, 10, 24)
PREVIEW_FROM = date(2026, 10, 1)
OWNER = "jon@lolwtf.ca"
VIEWER = "partner@lolwtf.ca"


def _imul(a: int, b: int) -> int:
    return (a * b) & _MASK


def mulberry32(seed: int) -> Callable[[], float]:
    state = seed & _MASK

    def rnd() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _MASK
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _MASK
        return ((t ^ (t >> 14)) & _MASK) / 4294967296

    return rnd


def js_round(x: float) -> float:
    """Math.round: nearest integer, ties toward positive infinity."""
    f = math.floor(x)
    return float(f + 1 if x - f >= 0.5 else f)


def round2(n: float) -> float:
    return js_round(n * 100) / 100


def money(n: float) -> Decimal:
    return Decimal(repr(round2(n))).quantize(Decimal("0.01"))


def _months(a: date, b: date) -> list[date]:
    out: list[date] = []
    d = date(a.year, a.month, 1)
    while d <= b:
        out.append(d)
        d = date(d.year + d.month // 12, d.month % 12 + 1, 1)
    return out


def _month_end(d: date) -> date:
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def _same_month(a: date, b: date) -> bool:
    return (a.year, a.month) == (b.year, b.month)


def _add_months(d: date, n: int) -> date:
    k = d.year * 12 + d.month - 1 + n
    return date(k // 12, k % 12 + 1, 1)


def _acct(id_: str, name: str, inst: str, kind: AccountKind, since: str) -> Account:
    return Account(id=id_, name=name, institution=inst, kind=kind, since=date.fromisoformat(since))


_K = AccountKind
ACCOUNTS: tuple[Account, ...] = (
    _acct("rbc-chq", "Chequing", "RBC", _K.chequing, "2021-01-01"),
    _acct("rbc-sav", "High Interest Savings", "RBC", _K.savings, "2021-01-01"),
    _acct("amex", "Cobalt", "Amex", _K.credit, "2021-01-01"),
    _acct("td-visa", "Cash Back Visa", "TD", _K.credit, "2021-01-01"),
    _acct("mortgage", "Mortgage", "RBC", _K.mortgage, "2022-06-15"),
    _acct("house", "House", "Manual", _K.asset, "2022-06-15"),
    _acct("ws-tfsa", "TFSA", "Wealthsimple", _K.investment, "2021-01-01"),
    _acct("qt-rrsp", "RRSP", "Questrade", _K.investment, "2021-01-01"),
    _acct("scotia-old", "Old Chequing", "Scotiabank", _K.chequing, "2021-01-01"),
)


def _cat(id_: str, name: str, parent: str | None, flow: Flow) -> Category:
    return Category(id=id_, name=name, parent_id=parent, flow=flow)


_I, _E, _T = Flow.income, Flow.expense, Flow.transfer
CATEGORIES: tuple[Category, ...] = (
    _cat("income", "Income", None, _I),
    _cat("salary", "Salary", "income", _I),
    _cat("interest", "Interest & dividends", "income", _I),
    _cat("refunds", "Refunds", "income", _I),
    _cat("housing", "Housing", None, _E),
    _cat("mortgage-pay", "Mortgage", "housing", _E),
    _cat("rent", "Rent", "housing", _E),
    _cat("utilities", "Utilities", "housing", _E),
    _cat("home", "Home & repairs", "housing", _E),
    _cat("property-tax", "Property tax", "housing", _E),
    _cat("food", "Food", None, _E),
    _cat("groceries", "Groceries", "food", _E),
    _cat("restaurants", "Restaurants", "food", _E),
    _cat("coffee", "Coffee", "food", _E),
    _cat("transport", "Transport", None, _E),
    _cat("fuel", "Fuel", "transport", _E),
    _cat("car", "Car & insurance", "transport", _E),
    _cat("transit", "Transit & taxis", "transport", _E),
    _cat("living", "Living", None, _E),
    _cat("shopping", "Shopping", "living", _E),
    _cat("subscriptions", "Subscriptions", "living", _E),
    _cat("health", "Health", "living", _E),
    _cat("kids", "Kids", "living", _E),
    _cat("pets", "Pets", "living", _E),
    _cat("fun", "Fun", None, _E),
    _cat("travel", "Travel", "fun", _E),
    _cat("entertainment", "Entertainment", "fun", _E),
    _cat("hobbies", "Hobbies & homelab", "fun", _E),
    _cat("gifts", "Gifts & giving", "fun", _E),
    _cat("transfer", "Transfer", None, _T),
    _cat("cc-payment", "Credit card payment", "transfer", _T),
    _cat("savings-xfer", "To savings", "transfer", _T),
    _cat("invest-xfer", "To investments", "transfer", _T),
    _cat("uncategorized", "Uncategorized", None, _E),
)


@dataclass(frozen=True)
class MerchantSpec:
    descriptor: str
    merchant: str
    category_id: str
    account: str
    mean: float
    sd: float
    per_month: float
    start: str | None = None
    end: str | None = None


_M = MerchantSpec
MERCHANTS: tuple[MerchantSpec, ...] = (
    _M("SOBEYS #0742 HALIFAX NS", "Sobeys", "groceries", "amex", 112, 40, 5),
    _M("COSTCO WHOLESALE W1284", "Costco", "groceries", "amex", 248, 70, 1.5),
    _M("ATLANTIC SUPERSTORE 304", "Superstore", "groceries", "td-visa", 86, 30, 2),
    _M("SQ *WEIRD HARBOUR ESPRESSO", "Weird Harbour", "coffee", "amex", 6.4, 1.5, 9),
    _M("TIM HORTONS #3341", "Tim Hortons", "coffee", "td-visa", 4.1, 1, 6),
    _M("UBER EATS   HELP.UBER.COM", "Uber Eats", "restaurants", "amex", 47, 15, 3),
    _M("THE BICYCLE THIEF HALIFAX", "Bicycle Thief", "restaurants", "amex", 142, 40, 0.4),
    _M("SKIP*THE DISHES WINNIPEG", "SkipTheDishes", "restaurants", "td-visa", 39, 12, 2),
    _M("IRVING 24 BEDFORD HWY", "Irving", "fuel", "td-visa", 78, 18, 3),
    _M("NS POWER PREAUTH", "Nova Scotia Power", "utilities", "rbc-chq", 186, 60, 1),
    _M("BELL ALIANT FIBREOP", "Bell Aliant", "utilities", "rbc-chq", 119, 2, 1),
    _M("STARLINK INTERNET", "Starlink", "utilities", "amex", 140, 0, 1, start="2023-04-01"),
    _M("HALIFAX WATER", "Halifax Water", "utilities", "rbc-chq", 94, 20, 0.34, "2022-07-01"),
    _M("HRM PROPERTY TAX", "HRM", "property-tax", "rbc-chq", 2210, 60, 0.167, "2022-07-01"),
    _M("KENT BUILDING SUPPLIES", "Kent", "home", "amex", 96, 80, 1.2, start="2022-06-15"),
    _M("AMZN Mktp CA*2K9", "Amazon", "shopping", "amex", 54, 45, 4),
    _M("NETFLIX.COM", "Netflix", "subscriptions", "amex", 20.99, 0, 1),
    _M("SPOTIFY P2A1B3", "Spotify", "subscriptions", "amex", 16.99, 0, 1),
    _M("APPLE.COM/BILL", "Apple", "subscriptions", "amex", 12.99, 6, 1.3),
    _M("GOOGLE *CLOUD 7F2", "Google Cloud", "hobbies", "amex", 61, 25, 1),
    _M("HETZNER ONLINE GMBH", "Hetzner", "hobbies", "amex", 38, 4, 1),
    _M("NEWEGG CANADA", "Newegg", "hobbies", "amex", 230, 180, 0.4),
    _M("SHOPPERS DRUG MART 0239", "Shoppers", "health", "td-visa", 32, 20, 2),
    _M("PETSMART 2191", "PetSmart", "pets", "td-visa", 68, 25, 1),
    _M("CINEPLEX 7129 DARTMOUTH", "Cineplex", "entertainment", "amex", 41, 12, 0.5),
    _M("AIR CANADA 0142", "Air Canada", "travel", "amex", 540, 220, 0.17),
    _M("AIRBNB * HMK2R", "Airbnb", "travel", "amex", 620, 250, 0.12),
    _M("INTACT INSURANCE", "Intact", "car", "rbc-chq", 164, 0, 1),
    _M("HALIFAX TRANSIT", "Halifax Transit", "transit", "td-visa", 2.75, 0, 4),
    _M("LITTLE SPROUTS DAYCARE", "Little Sprouts", "kids", "rbc-chq", 1180, 10, 1, "2024-01-01"),
    _M("E-TRANSFER SENT", "e-Transfer", "gifts", "rbc-chq", 90, 60, 0.8),
    _M("LANDLORD RENT PAD", "Rent", "rent", "rbc-chq", 1850, 0, 1, end="2022-06-01"),
    _M("RBC MORTGAGE PYMT", "Mortgage", "mortgage-pay", "rbc-chq", 2640, 0, 2, "2022-07-01"),
)

UNKNOWN_DESCRIPTORS: tuple[str, ...] = (
    "SQ *BLUE NOSE GOODS",
    "PAYPAL *STEAMGAMES",
    "TST* CHAIN YARD CIDER",
    "LAWTONS DRUGS 0117",
    "HFX SEAPORT MARKET VEND",
    "PROPELLER BREWING CO",
    "POS PURCHASE 4411",
    "CANADIAN TIRE #0118",
    "WSIB*PARKING HFX",
    "ZEHRS? NO: SOBEYS LIQUOR",
)

_UNKNOWN_PREFIX = re.compile(r"^(SQ \*|TST\* |PAYPAL \*)")
_TRAILING_NUMBER = re.compile(r"\s+\d+$")


@dataclass
class _Row:
    """A transaction while it is generated: float money and mutable confidence, as in the TS."""

    id: str
    account_id: str
    date: date
    amount: float
    descriptor: str
    merchant: str
    category_id: str
    tags: tuple[str, ...] = ()
    transfer_id: str | None = None
    source: Source = Source.rule
    confidence: float | None = None

    def freeze(self) -> Transaction:
        return Transaction(
            id=self.id,
            account_id=self.account_id,
            date=self.date,
            amount=money(self.amount),
            descriptor=self.descriptor,
            merchant=self.merchant,
            category_id=self.category_id,
            tags=self.tags,
            transfer_id=self.transfer_id,
            source=self.source,
            confidence=self.confidence,
            batch_id=f"b-{self.date.year}",
        )


@dataclass
class _Gen:
    rnd: Callable[[], float]
    rows: list[_Row] = field(default_factory=list)
    seq: int = 0

    def gauss(self) -> float:
        u = 1 - self.rnd()
        v = self.rnd()
        return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)

    def amount(self, mean: float, sd: float) -> float:
        return round2(max(1.0, mean + self.gauss() * sd))

    def day(self) -> int:
        return math.floor(self.rnd() * 28)

    def push(
        self,
        account_id: str,
        on: date,
        amount: float,
        descriptor: str,
        merchant: str,
        category_id: str,
        **extra: object,
    ) -> None:
        self.seq += 1
        row = _Row(_tid(self.seq), account_id, on, amount, descriptor, merchant, category_id)
        for k, v in extra.items():
            setattr(row, k, v)
        self.rows.append(row)


def _tid(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return "t" + out.rjust(5, "0")


def _income(g: _Gen, months: list[date]) -> None:
    for m in months:
        net = 3900 + (m.year - 2021) * 190
        for day in (15, 28):
            d = m.replace(day=day)
            if d <= END:
                g.push("rbc-chq", d, net, "PAYROLL DEPOSIT ACME SYSTEMS", "Acme Systems", "salary")
        if m.year >= 2023:
            d = m.replace(day=25)
            if d <= END:
                g.push("rbc-chq", d, 2850, "NSHA PAYROLL", "NSHA", "salary")
        di = _month_end(m)
        if di <= END:
            amt = round2(18 + g.rnd() * 40 + (m.year - 2021) * 12)
            g.push("rbc-sav", di, amt, "INTEREST CREDIT", "RBC", "interest")


def _spend(g: _Gen, months: list[date]) -> None:
    for spec in MERCHANTS:
        for m in months:
            ms = m.isoformat()
            if spec.start and ms < spec.start[:7] + "-01":
                continue
            if spec.end and ms > spec.end:
                continue
            if spec.per_month >= 1:
                n = int(js_round(spec.per_month + (g.rnd() - 0.5)))
            else:
                n = 1 if g.rnd() < spec.per_month else 0
            for _ in range(n):
                d = m + timedelta(days=g.day())
                if d > END:
                    continue
                amt = -g.amount(spec.mean, spec.sd)
                source = Source.model if g.rnd() < 0.15 else Source.rule
                g.push(
                    spec.account,
                    d,
                    amt,
                    spec.descriptor,
                    spec.merchant,
                    spec.category_id,
                    source=source,
                )
    for row in g.rows:
        if row.source is Source.model:
            row.confidence = round2(0.72 + g.rnd() * 0.27)


def _oddities(g: _Gen, months: list[date]) -> None:
    for m in months:
        if g.rnd() >= 0.25:
            continue
        d = m + timedelta(days=g.day())
        if d > END:
            continue
        desc = UNKNOWN_DESCRIPTORS[math.floor(g.rnd() * len(UNKNOWN_DESCRIPTORS))]
        account = "amex" if g.rnd() < 0.5 else "td-visa"
        amt = -g.amount(45, 30)
        merchant = _TRAILING_NUMBER.sub("", _UNKNOWN_PREFIX.sub("", desc, count=1), count=1)
        confidence = round2(0.35 + g.rnd() * 0.3)
        g.push(
            account,
            d,
            amt,
            desc,
            merchant,
            "uncategorized",
            source=Source.model,
            confidence=confidence,
        )


def _card_payments(g: _Gen, months: list[date]) -> None:
    for card in ("amex", "td-visa"):
        name = "Amex" if card == "amex" else "TD"
        for m in months[1:]:
            prev = _add_months(m, -1)
            owed = 0.0
            for t in g.rows:
                if t.account_id == card and _same_month(t.date, prev) and t.amount < 0:
                    owed -= t.amount
            if owed < 1:
                continue
            d = m + timedelta(days=4)
            if d > END:
                continue
            xid = f"x-{card}-{prev.isoformat()[:7]}"
            desc = "AMEX PAYMENT" if card == "amex" else "TD VISA PAYMENT"
            g.push("rbc-chq", d, -round2(owed), desc, name, "cc-payment", transfer_id=xid)
            g.push(
                card,
                d + timedelta(days=1),
                round2(owed),
                "PAYMENT - THANK YOU",
                name,
                "cc-payment",
                transfer_id=xid,
            )


def _contributions(g: _Gen, months: list[date]) -> None:
    for m in months:
        d = m + timedelta(days=1)
        if d > END:
            continue
        ym = m.isoformat()[:7]
        sav, tfsa = f"x-sav-{ym}", f"x-tfsa-{ym}"
        g.push("rbc-chq", d, -500, "TFR TO SAVINGS", "RBC", "savings-xfer", transfer_id=sav)
        g.push("rbc-sav", d, 500, "TFR FROM CHEQUING", "RBC", "savings-xfer", transfer_id=sav)
        g.push(
            "rbc-chq",
            d,
            -400,
            "WEALTHSIMPLE INVESTMENTS",
            "Wealthsimple",
            "invest-xfer",
            transfer_id=tfsa,
        )
        g.push(
            "ws-tfsa",
            d + timedelta(days=2),
            400,
            "CONTRIBUTION",
            "Wealthsimple",
            "invest-xfer",
            transfer_id=tfsa,
        )
        if m.month == 2:
            rr = f"x-rrsp-{ym}"
            g.push(
                "rbc-sav", d, -6000, "QUESTRADE RRSP", "Questrade", "invest-xfer", transfer_id=rr
            )
            g.push(
                "qt-rrsp",
                d + timedelta(days=3),
                6000,
                "RRSP CONTRIBUTION",
                "Questrade",
                "invest-xfer",
                transfer_id=rr,
            )


def _one_offs(g: _Gen, months: list[date]) -> None:
    g.push(
        "rbc-sav",
        date(2022, 6, 15),
        -95000,
        "BR TO BR - LAWYER TRUST",
        "Down payment",
        "home",
        tags=("house",),
    )
    for m in months:
        if m.isoformat() >= "2022-04":
            continue
        g.push(
            "scotia-old",
            m + timedelta(days=10),
            -g.amount(60, 25),
            "POS PURCHASE",
            "Unknown POS",
            "uncategorized",
            source=Source.model,
            confidence=0.41,
        )
    g.push(
        "scotia-old",
        date(2022, 3, 30),
        -1120.55,
        "ACCOUNT CLOSE TRANSFER",
        "Scotiabank",
        "transfer",
        transfer_id="x-close",
    )
    g.push(
        "rbc-chq",
        date(2022, 3, 31),
        1120.55,
        "INCOMING WIRE SCOTIA",
        "Scotiabank",
        "transfer",
        transfer_id="x-close",
    )


def _holdings(g: _Gen, months: list[date]) -> list[HoldingSnapshot]:
    out: list[HoldingSnapshot] = []
    tfsa_units, rrsp_units, xeqt, veqt = 180.0, 95.0, 24.1, 31.2
    for q in (m for m in months if (m.month - 1) % 3 == 2):
        d = _month_end(q)
        if d > END:
            break
        xeqt = round2(xeqt * (1 + 0.025 + g.gauss() * 0.06))
        veqt = round2(veqt * (1 + 0.024 + g.gauss() * 0.06))
        tfsa_units += 1200 / xeqt
        if q.month == 3:
            rrsp_units += 6000 / veqt
        origin: Literal["statement-pdf", "export"] = (
            "statement-pdf" if d < date(2024, 1, 1) else "export"
        )
        tf = _position("XEQT", "iShares Core Equity ETF", tfsa_units, xeqt, 24.5)
        cash = round2(1200 + g.rnd() * 900)
        rr = (
            _position("VEQT", "Vanguard All-Equity ETF", rrsp_units, veqt, 30.1),
            Position(
                symbol="CASH",
                name="Cash",
                quantity=money(cash),
                price=Decimal("1.00"),
                market_value=money(cash),
                book_cost=money(cash),
            ),
        )
        rr_total = round2(round2(rrsp_units * veqt) + cash)
        out.append(
            HoldingSnapshot(
                account_id="ws-tfsa", date=d, positions=(tf,), total=tf.market_value, origin=origin
            )
        )
        out.append(
            HoldingSnapshot(
                account_id="qt-rrsp", date=d, positions=rr, total=money(rr_total), origin=origin
            )
        )
    return out


def _position(symbol: str, name: str, units: float, price: float, cost: float) -> Position:
    return Position(
        symbol=symbol,
        name=name,
        quantity=money(units),
        price=money(price),
        market_value=money(units * price),
        book_cost=money(units * cost),
    )


_ValuationSource = Literal["purchase", "assessment", "estimate"]
_HOUSE: tuple[tuple[str, int, _ValuationSource], ...] = (
    ("2022-06-15", 612000, "purchase"),
    ("2023-01-01", 598000, "assessment"),
    ("2024-01-01", 641000, "assessment"),
    ("2025-01-01", 668000, "assessment"),
    ("2026-01-01", 684000, "assessment"),
    ("2026-09-01", 705000, "estimate"),
)
VALUATIONS: tuple[Valuation, ...] = tuple(
    Valuation(account_id="house", date=date.fromisoformat(d), value=Decimal(v), source=s)
    for d, v, s in _HOUSE
)

ASSERTION_OK: dict[tuple[str, date], bool] = {
    ("rbc-chq", date(2023, 8, 31)): False,
    ("rbc-chq", date(2025, 12, 31)): True,
}
"""The web fixture's `ok` flags. Every mortgage assertion is ok; the model has no such field."""


def _assertions(months: list[date]) -> list[BalanceAssertion]:
    out: list[BalanceAssertion] = []
    principal = 517000.0
    for m in months:
        if m.isoformat() < "2022-07":
            continue
        d = _month_end(m)
        if d > END:
            break
        principal = round2(principal - (2640 * 2 - principal * (0.0489 / 12)))
        out.append(
            BalanceAssertion(
                account_id="mortgage",
                date=d,
                balance=money(-principal),
                origin="synthetic mortgage statement",
            )
        )
    out.append(
        BalanceAssertion(
            account_id="rbc-chq",
            date=date(2023, 8, 31),
            balance=Decimal("7412.18"),
            origin="synthetic statement",
        )
    )
    out.append(
        BalanceAssertion(
            account_id="rbc-chq",
            date=date(2025, 12, 31),
            balance=Decimal("9120.40"),
            origin="synthetic statement",
        )
    )
    return out


def _batches(txns: list[Transaction]) -> list[ImportBatch]:
    ids = sorted({t.batch_id for t in txns})
    return [
        ImportBatch(
            id=b,
            imported_at=datetime(2026, 10, 18 + i, tzinfo=UTC),
            files=4 + i % 3,
            rows=sum(1 for t in txns if t.batch_id == b),
            note="Backfill from QFX + the Scotiabank CSV" if i == 0 else "Backfill",
        )
        for i, b in enumerate(ids)
    ]


def _rules(txns: list[Transaction]) -> list[Rule]:
    return [
        Rule(
            id=f"r{i}",
            match=" ".join(m.descriptor.split(" ")[:2]),
            category_id=m.category_id,
            merchant=m.merchant,
            created_from="correction" if i % 4 == 0 else "seed",
            hits=sum(1 for t in txns if t.merchant == m.merchant),
        )
        for i, m in enumerate(MERCHANTS)
    ]


@dataclass(frozen=True)
class Synthetic:
    ledger: Ledger
    preview: ImportPreview


def generate(seed: int = 1337) -> Synthetic:
    """The whole fixture: the ledger and the web's static import preview."""
    g = _Gen(mulberry32(seed))
    months = _months(START, END)
    _income(g, months)
    _spend(g, months)
    _oddities(g, months)
    _card_payments(g, months)
    _contributions(g, months)
    _one_offs(g, months)
    g.rows.sort(key=lambda r: (r.date, r.id))
    txns = [r.freeze() for r in g.rows]
    ledger = Ledger(
        id="synthetic",
        members=(Member(login=OWNER, role="owner"), Member(login=VIEWER, role="viewer")),
        accounts=ACCOUNTS,
        categories=CATEGORIES,
        transactions=tuple(txns),
        holdings=tuple(_holdings(g, months)),
        valuations=VALUATIONS,
        assertions=tuple(_assertions(months)),
        batches=tuple(_batches(txns)),
        rules=tuple(_rules(txns)),
    )
    return Synthetic(ledger=ledger, preview=_static_preview(ledger))


def build_ledger(seed: int = 1337, *, before: date | None = None) -> Ledger:
    """The synthetic ledger, October's preview rows included.

    `before` drops transactions on or after it. `before=PREVIEW_FROM` is the
    web fixture's ledger, the one `build_preview_files()` is previewed against;
    the default already holds those rows, so previewing them against it
    duplicates every one.
    """
    ledger = generate(seed).ledger
    if before is None:
        return ledger
    txns = [t for t in ledger.transactions if t.date < before]
    return ledger.model_copy(update={"transactions": tuple(txns), "batches": tuple(_batches(txns))})


def build_preview(seed: int = 1337) -> ImportPreview:
    """The web fixture's static preview, field for field."""
    return generate(seed).preview


def _preview_txns(ledger: Ledger) -> list[Transaction]:
    return [t for t in ledger.transactions if t.date >= PREVIEW_FROM]


@dataclass(frozen=True)
class _FileSpec:
    name: str
    format: Literal["csv", "qfx", "ofx", "pdf", "xlsx"]
    institution: str
    account_id: str | None
    rows_of: str | None
    date_from: date
    date_to: date
    pages: int | None = None
    scanned: bool | None = None


_PREVIEW_FILES: tuple[_FileSpec, ...] = (
    _FileSpec(
        "rbc-chequing-2026-10.qfx",
        "qfx",
        "RBC",
        "rbc-chq",
        "rbc-chq",
        date(2026, 10, 1),
        date(2026, 10, 24),
    ),
    _FileSpec(
        "amex-activity.csv", "csv", "Amex", "amex", "amex", date(2026, 9, 28), date(2026, 10, 23)
    ),
    _FileSpec(
        "td-visa-download.csv", "csv", "TD", None, "td-visa", date(2026, 10, 1), date(2026, 10, 22)
    ),
    _FileSpec(
        "Questrade_Statement_2021-09.pdf",
        "pdf",
        "Questrade",
        "qt-rrsp",
        None,
        date(2021, 7, 1),
        date(2021, 9, 30),
        pages=6,
        scanned=True,
    ),
)


def _finding_low(i: int, t: Transaction) -> LowConfidenceFinding:
    return LowConfidenceFinding(
        id=f"f{5 + i}",
        transaction_id=t.id,
        suggested_category_id="shopping" if t.category_id == "uncategorized" else t.category_id,
        confidence=t.confidence if t.confidence is not None else 0.5,
    )


def _static_preview(ledger: Ledger) -> ImportPreview:
    txns = list(ledger.transactions)
    new = _preview_txns(ledger)
    earlier = [t for t in txns if t.date < PREVIEW_FROM]
    low = [
        t
        for t in new
        if t.category_id == "uncategorized"
        or (t.confidence if t.confidence is not None else 1) < 0.8
    ]
    findings: list[Finding] = []
    for fid, merchant, reason in (
        (
            "f1",
            "Sobeys",
            "Same account, amount and date already imported from the QFX on 2026-10-18",
        ),
        ("f2", "Amazon", "Pending row re-posted with a different descriptor"),
    ):
        dup = next((t for t in new if t.merchant == merchant), None)
        if dup is not None:
            match = next(t for t in earlier if t.merchant == merchant)
            findings.append(
                DuplicateFinding(
                    id=fid, transaction_id=dup.id, matches_id=match.id, reason=reason, tier="fuzzy"
                )
            )
    findings.append(
        MissingPeriodFinding(
            id="f3",
            account_id="rbc-chq",
            date_from=date(2023, 7, 1),
            date_to=date(2023, 8, 31),
            expected_balance=Decimal("7412.18"),
            actual_balance=Decimal("6907.90"),
        )
    )
    out = next((t for t in new if t.descriptor == "AMEX PAYMENT"), None)
    back = next(
        (t for t in new if out and t.transfer_id == out.transfer_id and t.id != out.id), None
    )
    if out and back:
        findings.append(
            TransferFinding(id="f4", out_id=out.id, in_id=back.id, days_apart=1, auto=False)
        )
    findings.extend(_finding_low(i, t) for i, t in enumerate(low))
    outbound = tuple(dict.fromkeys(t.descriptor for t in low))
    return ImportPreview(
        files=tuple(_preview_file(spec, new) for spec in _PREVIEW_FILES),
        new_transactions=tuple(new),
        findings=tuple(findings),
        outbound_strings=outbound,
        rules_hit=len(new) - len(low),
        model_calls=len(outbound),
    )


def _preview_file(spec: _FileSpec, new: list[Transaction]) -> PreviewFile:
    rows = 2 if spec.rows_of is None else sum(1 for t in new if t.account_id == spec.rows_of)
    return PreviewFile(
        name=spec.name,
        format=spec.format,
        institution=spec.institution,
        account_id=spec.account_id,
        rows=rows,
        date_from=spec.date_from,
        date_to=spec.date_to,
        pages=spec.pages,
        scanned=spec.scanned,
        needs_account=spec.account_id is None and spec.format == "csv",
    )


def build_preview_files(seed: int = 1337) -> list[ParsedFile]:
    """October's exports as parsed files, to preview against `build_ledger(seed, before=...)`.

    Each cash file holds that account's October rows, so the engine's row
    counts match the web's static preview. The PDF carries the 2021-09 RRSP
    snapshot and no rows. The TD CSV has no account hint, as a CSV would not.
    """
    full = generate(seed).ledger
    new = _preview_txns(full)
    out: list[ParsedFile] = []
    for spec in _PREVIEW_FILES:
        if spec.rows_of is None:
            out.append(_pdf_file(spec, full))
            continue
        hint = spec.account_id
        rows = tuple(
            ParsedRow(
                account_hint=hint,
                date=t.date,
                amount=t.amount,
                descriptor=t.descriptor,
                fitid=f"SYN{t.id}" if spec.format == "qfx" else None,
            )
            for t in new
            if t.account_id == spec.rows_of
        )
        out.append(
            ParsedFile(
                name=spec.name,
                format=spec.format,
                institution=spec.institution,
                account_hint=hint,
                rows=rows,
                profile_id=f"synthetic-{spec.institution.lower()}"
                if spec.format == "csv"
                else None,
                sha256=_sha(spec.name, seed),
                date_from=spec.date_from,
                date_to=spec.date_to,
            )
        )
    return out


def _pdf_file(spec: _FileSpec, ledger: Ledger) -> ParsedFile:
    snap = next(
        h for h in ledger.holdings if h.account_id == spec.account_id and h.date == spec.date_to
    )
    return ParsedFile(
        name=spec.name,
        format=spec.format,
        institution=spec.institution,
        account_hint=spec.account_id,
        account_kind_hint=AccountKind.investment,
        rows=(),
        holdings=(snap.model_copy(update={"origin": "statement-pdf"}),),
        sha256=_sha(spec.name, -1),
        date_from=spec.date_from,
        date_to=spec.date_to,
        pages=spec.pages,
        scanned=spec.scanned,
    )


def _sha(name: str, seed: int) -> str:
    return hashlib.sha256(f"synthetic\x1f{seed}\x1f{name}".encode()).hexdigest()
