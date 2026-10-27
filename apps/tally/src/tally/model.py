"""The nouns.

These mirror apps/tally/web/src/fixtures/types.ts, which the React app reads.
The domain-model ticket (08) may rename them; until then this file and that
file move together. Money is a Decimal in CAD with two places; `cents()` gives
the integer the reconcile code compares on.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CENT = Decimal("0.01")


def cents(amount: Decimal) -> int:
    """Exact integer cents. Dedupe and transfer pairing compare on this."""
    return int(amount.quantize(CENT, rounding=ROUND_HALF_UP) * 100)


class Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class AccountKind(StrEnum):
    chequing = "chequing"
    savings = "savings"
    credit = "credit"
    mortgage = "mortgage"
    investment = "investment"
    asset = "asset"


class Account(Model):
    id: str
    name: str
    institution: str
    kind: AccountKind
    since: date
    currency: Literal["CAD"] = "CAD"


class Flow(StrEnum):
    income = "income"
    expense = "expense"
    transfer = "transfer"


class Category(Model):
    id: str
    name: str
    parent_id: str | None
    flow: Flow


class Source(StrEnum):
    rule = "rule"
    model = "model"
    manual = "manual"


class Transaction(Model):
    id: str
    account_id: str
    date: date
    amount: Decimal = Field(description="Signed CAD. Negative leaves the account.")
    descriptor: str = Field(description="What the bank printed, verbatim.")
    merchant: str = Field(description="Normalised merchant name.")
    category_id: str
    tags: tuple[str, ...] = ()
    transfer_id: str | None = None
    source: Source = Source.rule
    confidence: float | None = None
    batch_id: str
    fitid: str | None = Field(default=None, description="The institution's id, a hint only.")
    pending: bool = False


class Position(Model):
    symbol: str
    name: str
    quantity: Decimal
    price: Decimal
    market_value: Decimal
    book_cost: Decimal


class HoldingSnapshot(Model):
    account_id: str
    date: date
    positions: tuple[Position, ...]
    total: Decimal
    origin: Literal["statement-pdf", "export"]


class Valuation(Model):
    account_id: str
    date: date
    value: Decimal
    source: Literal["purchase", "assessment", "estimate"]


class BalanceAssertion(Model):
    """The institution said the balance on `date` was `balance`."""

    account_id: str
    date: date
    balance: Decimal
    origin: str = Field(description="Which file or statement said so.")


class ImportBatch(Model):
    id: str
    imported_at: datetime
    files: int
    rows: int
    note: str = ""


class Rule(Model):
    id: str
    match: str = Field(description="Case-insensitive substring over the descriptor, or /regex/.")
    category_id: str
    merchant: str
    created_from: Literal["correction", "seed", "model"]
    account_id: str | None = None
    hits: int = 0


# Import preview: what the review screen reacts to.


class ParsedRow(Model):
    """One transaction as a file states it, before it has a ledger identity."""

    account_hint: str | None = Field(
        default=None, description="Account id from the file (OFX ACCTID) or None for a CSV."
    )
    date: date
    amount: Decimal
    descriptor: str
    memo: str = ""
    fitid: str | None = None
    pending: bool = False
    balance_after: Decimal | None = Field(
        default=None, description="A running balance the row carried, if the file had one."
    )
    tags: tuple[str, ...] = Field(
        default=(),
        description="Trusted hints the file carried, `<prefix>:<group>/<category>` for a category"
        " the owner chose by hand and `<prefix>:transfer` for a transfer.",
    )


class AccountHint(Model):
    """What a file says about an account its rows name, for the account the import creates."""

    hint: str
    name: str
    kind: AccountKind | None = None


class ParsedFile(Model):
    """What a parser hands the engine. Shapes only: no bytes of the file survive here."""

    name: str
    format: Literal["csv", "qfx", "ofx", "pdf", "xlsx"]
    institution: str | None
    account_hint: str | None
    account_kind_hint: AccountKind | None = None
    accounts: tuple[AccountHint, ...] = ()
    rows: tuple[ParsedRow, ...]
    assertions: tuple[BalanceAssertion, ...] = ()
    holdings: tuple[HoldingSnapshot, ...] = ()
    profile_id: str | None = Field(default=None, description="The CSV profile that parsed it.")
    sha256: str
    date_from: date | None
    date_to: date | None
    pages: int | None = None
    scanned: bool | None = None


class PreviewFile(Model):
    name: str
    format: Literal["csv", "qfx", "ofx", "pdf", "xlsx"]
    institution: str | None
    account_id: str | None
    rows: int
    date_from: date | None
    date_to: date | None
    pages: int | None = None
    scanned: bool | None = None
    needs_account: bool = False
    account_kind: AccountKind | None = None


class DuplicateFinding(Model):
    kind: Literal["duplicate"] = "duplicate"
    id: str
    transaction_id: str
    matches_id: str
    reason: str
    tier: Literal["fitid", "fuzzy"]


class MissingPeriodFinding(Model):
    kind: Literal["missing-period"] = "missing-period"
    id: str
    account_id: str
    date_from: date
    date_to: date
    expected_balance: Decimal
    actual_balance: Decimal


class TransferFinding(Model):
    kind: Literal["transfer"] = "transfer"
    id: str
    out_id: str
    in_id: str
    days_apart: int
    auto: bool = Field(description="True when unique on both sides and accepted without asking.")


class LowConfidenceFinding(Model):
    kind: Literal["low-confidence"] = "low-confidence"
    id: str
    transaction_id: str
    suggested_category_id: str
    confidence: float


Finding = DuplicateFinding | MissingPeriodFinding | TransferFinding | LowConfidenceFinding


class ImportPreview(Model):
    files: tuple[PreviewFile, ...]
    new_transactions: tuple[Transaction, ...]
    findings: tuple[Finding, ...]
    outbound_strings: tuple[str, ...] = Field(
        description="Exactly what would be sent to a model, nothing else."
    )
    rules_hit: int
    model_calls: int
    holdings: tuple[HoldingSnapshot, ...] = ()
    assertions: tuple[BalanceAssertion, ...] = ()
    new_accounts: tuple[Account, ...] = Field(
        default=(), description="Accounts the files name that the ledger lacks."
    )
    new_categories: tuple[Category, ...] = Field(
        default=(), description="Categories the files' trusted tags need that the ledger lacks."
    )
    seed_rules: tuple[Rule, ...] = Field(
        default=(), description="Rules the files' trusted tags imply, for the ledger to keep."
    )


class Member(Model):
    login: str = Field(description="A tailnet login, e.g. jon@example.com.")
    role: Literal["owner", "viewer"]


class Ledger(Model):
    """A whole ledger in memory. The CLI holds one; the server loads one per request scope."""

    id: str
    members: tuple[Member, ...]
    accounts: tuple[Account, ...]
    categories: tuple[Category, ...]
    transactions: tuple[Transaction, ...]
    holdings: tuple[HoldingSnapshot, ...] = ()
    valuations: tuple[Valuation, ...] = ()
    assertions: tuple[BalanceAssertion, ...] = ()
    batches: tuple[ImportBatch, ...] = ()
    rules: tuple[Rule, ...] = ()

    @property
    def owner(self) -> str:
        return next(m.login for m in self.members if m.role == "owner")

    @property
    def as_of(self) -> date | None:
        return max((t.date for t in self.transactions), default=None)
