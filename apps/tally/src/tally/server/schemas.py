"""The wire shapes: tally.model in camelCase, matching web/src/fixtures/types.ts.

Money crosses the wire as a JSON number, as the web reads it. Where types.ts
names a field differently from the model (`from`/`to` on preview files and
missing periods, `owner`/`viewers`/`asOf` on the ledger), the wire takes the
types.ts name.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer
from pydantic.alias_generators import to_camel

from tally import model
from tally.server.db import ApiToken, AuditEntry, Membership, StoredPreview

Money = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]


class Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel, populate_by_name=True, frozen=True, extra="forbid"
    )

    @classmethod
    def of(cls, source: BaseModel) -> Self:
        return cls.model_validate(source.model_dump())


class AccountOut(Wire):
    id: str
    name: str
    institution: str
    kind: model.AccountKind
    since: date
    currency: model.Currency = "CAD"


class CategoryOut(Wire):
    id: str
    name: str
    parent_id: str | None
    flow: model.Flow


class TransactionOut(Wire):
    id: str
    account_id: str
    date: date
    amount: Money
    descriptor: str
    merchant: str
    category_id: str
    tags: tuple[str, ...] = ()
    transfer_id: str | None = None
    source: model.Source
    confidence: float | None = None
    batch_id: str
    fitid: str | None = None
    pending: bool = False


class PositionOut(Wire):
    symbol: str
    name: str
    quantity: Decimal
    price: Money
    market_value: Money
    book_cost: Money


class HoldingSnapshotOut(Wire):
    account_id: str
    date: date
    positions: tuple[PositionOut, ...]
    total: Money
    origin: Literal["statement-pdf", "export"]


class ValuationOut(Wire):
    account_id: str
    date: date
    value: Money
    source: Literal["purchase", "assessment", "estimate"]


class BalanceAssertionOut(Wire):
    account_id: str
    date: date
    balance: Money
    origin: str


class ImportBatchOut(Wire):
    id: str
    imported_at: datetime
    files: int
    rows: int
    note: str = ""


class RuleOut(Wire):
    id: str
    match: str
    category_id: str
    merchant: str
    created_from: Literal["correction", "seed", "model"]
    account_id: str | None = None
    hits: int = 0


class MemberOut(Wire):
    login: str
    role: Literal["owner", "viewer"]


class PreviewFileOut(Wire):
    name: str
    format: Literal["csv", "qfx", "ofx", "pdf", "xlsx"]
    institution: str | None
    account_id: str | None
    rows: int
    date_from: date | None = Field(alias="from")
    date_to: date | None = Field(alias="to")
    pages: int | None = None
    scanned: bool | None = None
    needs_account: bool = False
    account_kind: model.AccountKind | None = None
    currency: model.Currency = "CAD"


class DuplicateFindingOut(Wire):
    kind: Literal["duplicate"] = "duplicate"
    id: str
    transaction_id: str
    matches_id: str
    reason: str
    tier: Literal["fitid", "fuzzy"]


class MissingPeriodFindingOut(Wire):
    kind: Literal["missing-period"] = "missing-period"
    id: str
    account_id: str
    date_from: date = Field(alias="from")
    date_to: date = Field(alias="to")
    expected_balance: Money
    actual_balance: Money


class TransferFindingOut(Wire):
    kind: Literal["transfer"] = "transfer"
    id: str
    out_id: str
    in_id: str
    days_apart: int
    auto: bool


class LowConfidenceFindingOut(Wire):
    kind: Literal["low-confidence"] = "low-confidence"
    id: str
    transaction_id: str
    suggested_category_id: str
    confidence: float


FindingOut = Annotated[
    DuplicateFindingOut | MissingPeriodFindingOut | TransferFindingOut | LowConfidenceFindingOut,
    Field(discriminator="kind"),
]


class ImportPreviewOut(Wire):
    files: tuple[PreviewFileOut, ...]
    new_transactions: tuple[TransactionOut, ...]
    findings: tuple[FindingOut, ...]
    outbound_strings: tuple[str, ...]
    rules_hit: int
    model_calls: int
    holdings: tuple[HoldingSnapshotOut, ...] = ()
    assertions: tuple[BalanceAssertionOut, ...] = ()
    new_accounts: tuple[AccountOut, ...] = ()
    new_categories: tuple[CategoryOut, ...] = ()
    seed_rules: tuple[RuleOut, ...] = ()
    held_ids: tuple[str, ...] = ()


class StoredPreviewOut(Wire):
    id: str
    created: datetime
    created_by: str
    preview: ImportPreviewOut

    @classmethod
    def from_stored(cls, stored: StoredPreview) -> StoredPreviewOut:
        return cls(
            id=stored.id,
            created=stored.created,
            created_by=stored.created_by,
            preview=ImportPreviewOut.model_validate(stored.preview.model_dump()),
        )


class LedgerOut(Wire):
    id: str
    owner: str
    viewers: tuple[str, ...]
    members: tuple[MemberOut, ...]
    accounts: tuple[AccountOut, ...]
    categories: tuple[CategoryOut, ...]
    transactions: tuple[TransactionOut, ...]
    holdings: tuple[HoldingSnapshotOut, ...]
    valuations: tuple[ValuationOut, ...]
    assertions: tuple[BalanceAssertionOut, ...]
    batches: tuple[ImportBatchOut, ...]
    rules: tuple[RuleOut, ...]
    as_of: date | None

    @classmethod
    def from_ledger(cls, ledger: model.Ledger) -> LedgerOut:
        dumped = ledger.model_dump()
        return cls.model_validate(
            {
                **dumped,
                "owner": ledger.owner,
                "viewers": tuple(m.login for m in ledger.members if m.role == "viewer"),
                "as_of": ledger.as_of,
            }
        )


class MembershipOut(Wire):
    ledger_id: str
    role: Literal["owner", "viewer"]

    @classmethod
    def from_membership(cls, m: Membership) -> MembershipOut:
        return cls(ledger_id=m.ledger_id, role=m.role)


class MeOut(Wire):
    login: str
    name: str | None
    via: Literal["tailscale", "bearer", "dev"]
    ledger_id: str
    role: Literal["owner", "viewer"]
    memberships: tuple[MembershipOut, ...]


class AccountDetailOut(Wire):
    account: AccountOut
    balance: Money
    transactions: int
    holdings: tuple[HoldingSnapshotOut, ...]
    valuations: tuple[ValuationOut, ...]
    assertions: tuple[BalanceAssertionOut, ...]


class AuditEntryOut(Wire):
    id: str
    created: datetime
    classifier: str
    strings: tuple[str, ...]

    @classmethod
    def from_entry(cls, e: AuditEntry) -> AuditEntryOut:
        return cls(id=e.id, created=e.created, classifier=e.classifier, strings=e.strings)


class TokenOut(Wire):
    id: str
    login: str
    created: datetime
    secret: str | None = Field(default=None, description="Present once, when minted.")

    @classmethod
    def from_token(cls, t: ApiToken, secret: str | None = None) -> TokenOut:
        return cls(id=t.id, login=t.login, created=t.created, secret=secret)


class ApplyOut(Wire):
    added: int
    skipped_tombstoned: int
    version: int


class RecategoriseOut(Wire):
    transaction: TransactionOut
    rule: RuleOut | None
    moved: int


# Inputs.


class DecisionsIn(Wire):
    accept_findings: frozenset[str] = frozenset()
    dismiss_findings: frozenset[str] = frozenset()
    account_for_file: dict[str, str] = Field(default_factory=dict)
    recategorise: dict[str, str] = Field(default_factory=dict)
    make_rules: frozenset[str] = frozenset()
    withhold_strings: frozenset[str] = frozenset()
    replace_findings: frozenset[str] = frozenset()
    authoritative_files: frozenset[str] = frozenset()


class RecategoriseIn(Wire):
    category_id: str
    always: bool = False
    match: str | None = Field(
        default=None, description="The rule's pattern when `always`; defaults to the descriptor."
    )


class RuleIn(Wire):
    match: str = Field(min_length=1)
    category_id: str
    merchant: str = Field(min_length=1)
    account_id: str | None = None


class AccountIn(Wire):
    id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
    name: str = Field(min_length=1)
    institution: str = ""
    kind: model.AccountKind
    since: date


class ValuationIn(Wire):
    date: date
    value: Decimal
    source: Literal["purchase", "assessment", "estimate"]


class MemberIn(Wire):
    login: str = Field(min_length=3)
    role: Literal["viewer"] = "viewer"
