import sqlite3
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
import sqlalchemy as sa

from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    Category,
    Flow,
    HoldingSnapshot,
    ImportBatch,
    ImportPreview,
    Ledger,
    ParsedFile,
    ParsedRow,
    Position,
    Rule,
    Transaction,
    Valuation,
)
from tally.server import db
from tally.server.crypto import Keyring, KeyringError, TamperedError

KEYRING = Keyring(active="v1", keys={"v1": bytes(range(32))})
OWNER = "owner@example.invalid"

DESCRIPTOR = "ZQXWIDGETEMPORIUM 4471 NOWHERESVILLE"
MERCHANT = "Zqx Widget Emporium"
AMOUNT = Decimal("-8123.47")
TXN_DATE = date(2031, 4, 17)
ACCOUNT_NAME = "Hidden Rainy Day Fund"
CATEGORY_NAME = "Quietly Sensitive Clinic"
SYMBOL = "ZQXFUND"
NEEDLES = [
    DESCRIPTOR,
    "ZQXWIDGET",
    MERCHANT,
    "8123.47",
    "812347",
    "2031-04-17",
    ACCOUNT_NAME,
    CATEGORY_NAME,
    SYMBOL,
    "9876.54",
    "Invented Mutual",
]


def invented_ledger(ledger_id: str) -> Ledger:
    return Ledger(
        id=ledger_id,
        members=(),
        accounts=(
            Account(
                id="acct-cheq",
                name=ACCOUNT_NAME,
                institution="Invented Mutual",
                kind=AccountKind.chequing,
                since=date(2030, 1, 1),
            ),
            Account(
                id="acct-house",
                name="A House",
                institution="",
                kind=AccountKind.asset,
                since=date(2030, 1, 1),
            ),
        ),
        categories=(
            Category(id="cat-clinic", name=CATEGORY_NAME, parent_id=None, flow=Flow.expense),
            Category(id="cat-pay", name="Pay", parent_id=None, flow=Flow.income),
        ),
        transactions=(
            Transaction(
                id="t-1",
                account_id="acct-cheq",
                date=TXN_DATE,
                amount=AMOUNT,
                descriptor=DESCRIPTOR,
                merchant=MERCHANT,
                category_id="cat-clinic",
                batch_id="b-1",
            ),
            Transaction(
                id="t-2",
                account_id="acct-cheq",
                date=date(2031, 4, 18),
                amount=Decimal("9876.54"),
                descriptor="PAYROLL INVENTED CO",
                merchant="Invented Co",
                category_id="cat-pay",
                batch_id="b-1",
            ),
        ),
        holdings=(
            HoldingSnapshot(
                account_id="acct-cheq",
                date=date(2031, 4, 30),
                positions=(
                    Position(
                        symbol=SYMBOL,
                        name="An Invented Fund",
                        quantity=Decimal("12.5"),
                        price=Decimal("10.00"),
                        market_value=Decimal("125.00"),
                        book_cost=Decimal("100.00"),
                    ),
                ),
                total=Decimal("125.00"),
                origin="export",
            ),
        ),
        valuations=(
            Valuation(
                account_id="acct-house",
                date=date(2030, 1, 1),
                value=Decimal("500000"),
                source="purchase",
            ),
        ),
        assertions=(
            BalanceAssertion(
                account_id="acct-cheq",
                date=date(2031, 4, 30),
                balance=Decimal("1753.07"),
                origin="statement",
            ),
        ),
        batches=(
            ImportBatch(id="b-1", imported_at=datetime(2031, 5, 1, tzinfo=UTC), files=1, rows=2),
        ),
        rules=(
            Rule(
                id="r-1",
                match="zqxwidget",
                category_id="cat-clinic",
                merchant=MERCHANT,
                created_from="correction",
            ),
        ),
    )


def invented_file() -> ParsedFile:
    return ParsedFile(
        name="upload.qfx",
        format="qfx",
        institution="Invented Mutual",
        account_hint="acct-cheq",
        rows=(ParsedRow(date=TXN_DATE, amount=AMOUNT, descriptor=DESCRIPTOR),),
        sha256="0" * 64,
        date_from=TXN_DATE,
        date_to=TXN_DATE,
    )


@pytest.fixture
def engine(tmp_path):
    eng = db.connect(f"sqlite:///{tmp_path / 'tally.db'}")
    db.migrate(eng)
    return eng


@pytest.fixture
def repo(engine):
    return db.LedgerRepository(engine, KEYRING)


def stored(repo: db.LedgerRepository) -> Ledger:
    lid = repo.create_ledger(OWNER)
    return repo.save(invented_ledger(lid))


def test_migrations_apply_once(engine):
    assert db.migrate(engine) == ()


def test_migrations_match_the_table_definitions(engine):
    inspector = sa.inspect(engine)
    for table in db.metadata.sorted_tables:
        live = {c["name"] for c in inspector.get_columns(table.name)}
        assert live == {c.name for c in table.columns}, table.name


def test_a_ledger_round_trips(repo):
    saved = stored(repo)
    fresh = db.LedgerRepository(repo.engine, KEYRING).load(saved.id)
    assert fresh == saved
    assert fresh.owner == OWNER
    assert fresh.transactions[0].amount == AMOUNT


def test_the_database_file_holds_no_plaintext(repo, tmp_path):
    saved = stored(repo)
    repo.put_preview(saved.id, OWNER, 1, [invented_file()], _preview(saved))
    repo.record_audit(saved.id, "fake:model", [DESCRIPTOR])
    repo.engine.dispose()
    path = tmp_path / "tally.db"
    raw = path.read_bytes()
    with sqlite3.connect(path) as conn:
        dump = "\n".join(conn.iterdump())
    for needle in NEEDLES:
        assert needle.encode() not in raw, needle
        assert needle.lower().encode() not in raw, needle
        assert needle not in dump, needle


def _preview(ledger: Ledger) -> ImportPreview:
    return ImportPreview(
        files=(),
        new_transactions=ledger.transactions[:1],
        findings=(),
        outbound_strings=(DESCRIPTOR,),
        rules_hit=0,
        model_calls=1,
    )


def test_previews_and_audit_round_trip_sealed(repo):
    saved = stored(repo)
    put = repo.put_preview(saved.id, OWNER, 3, [invented_file()], _preview(saved))
    got = repo.get_preview(saved.id, put.id)
    assert got is not None
    assert got.files == (invented_file(),)
    assert got.preview == _preview(saved)
    assert got.base_version == 3
    repo.record_audit(saved.id, "fake:model", [DESCRIPTOR])
    assert [e.strings for e in repo.audit_log(saved.id)] == [(DESCRIPTOR,)]


def test_a_payload_moved_to_another_row_does_not_open(repo):
    saved = stored(repo)
    t = db.transactions
    with repo.engine.begin() as conn:
        one = conn.execute(sa.select(t.c.payload).where(t.c.id == "t-1")).scalar_one()
        conn.execute(t.update().where(t.c.id == "t-2").values(payload=one))
    with pytest.raises(TamperedError):
        db.LedgerRepository(repo.engine, KEYRING).load(saved.id)


def test_load_is_cached_until_the_version_moves(repo):
    saved = stored(repo)
    assert repo.load(saved.id) is repo.load(saved.id)
    other = db.LedgerRepository(repo.engine, KEYRING)
    other.save(saved.model_copy(update={"rules": ()}))
    assert repo.load(saved.id).rules == ()


def test_unchanged_rows_are_not_rewritten(repo):
    saved = stored(repo)
    before = _payloads(repo)
    repo.save(saved.model_copy(update={"rules": ()}))
    after = _payloads(repo)
    assert {k: v for k, v in after.items() if k[0] != "rules"} == {
        k: v for k, v in before.items() if k[0] != "rules"
    }


def _payloads(repo: db.LedgerRepository) -> dict[tuple[str, str], bytes]:
    out = {}
    with repo.engine.connect() as conn:
        for table in (db.accounts, db.transactions, db.rules, db.holdings):
            for row in conn.execute(sa.select(table.c.id, table.c.payload)):
                out[(table.name, row.id)] = bytes(row.payload)
    return out


def test_duplicate_ids_are_refused(repo):
    saved = stored(repo)
    twice = (*saved.transactions, saved.transactions[0])
    with pytest.raises(ValueError, match="duplicate"):
        repo.save(saved.model_copy(update={"transactions": twice}))


def test_identical_holdings_collapse(repo):
    saved = stored(repo)
    doubled = repo.save(saved.model_copy(update={"holdings": saved.holdings * 2}))
    assert len(doubled.holdings) == 1
    assert len(db.LedgerRepository(repo.engine, KEYRING).load(saved.id).holdings) == 1


def test_a_deleted_transaction_stays_buried(repo):
    saved = stored(repo)
    gone = saved.transactions[0]
    after = repo.save(saved.model_copy(update={"transactions": saved.transactions[1:]}))
    same_id = after.model_copy(update={"transactions": (*after.transactions, gone)})
    same_row = after.model_copy(
        update={"transactions": (*after.transactions, gone.model_copy(update={"id": "t-new"}))}
    )
    for candidate in (same_id, same_row):
        kept, dropped = repo.drop_tombstoned(after, candidate)
        assert dropped == 1
        assert [t.id for t in kept.transactions] == ["t-2"]


def test_rotation_rewraps_without_touching_rows(repo):
    saved = stored(repo)
    before = _payloads(repo)
    ring = Keyring(active="v1", keys={"v1": KEYRING.master("v1"), "v2": bytes(range(50, 82))})
    rotating = db.LedgerRepository(repo.engine, ring)
    assert rotating.rotate("v2") == 1
    assert _payloads(repo) == before
    only_new = Keyring(active="v2", keys={"v2": ring.master("v2")})
    assert db.LedgerRepository(repo.engine, only_new).load(saved.id) == saved
    with pytest.raises(KeyringError, match="v2"):
        db.LedgerRepository(repo.engine, KEYRING).load(saved.id)


def test_memberships(repo):
    lid = repo.create_ledger(OWNER)
    repo.add_member(lid, "viewer@example.invalid", "viewer")
    assert repo.memberships("viewer@example.invalid") == (db.Membership(lid, "viewer"),)
    assert [m.login for m in repo.load(lid).members] == [OWNER, "viewer@example.invalid"]
    assert not repo.remove_member(lid, OWNER)
    assert repo.remove_member(lid, "viewer@example.invalid")
    assert repo.memberships("viewer@example.invalid") == ()


def test_tokens_are_stored_hashed(repo, tmp_path):
    lid = repo.create_ledger(OWNER)
    token, secret = repo.mint_token(lid, OWNER)
    assert repo.resolve_token(secret) == token
    assert repo.resolve_token(secret + "x") is None
    repo.engine.dispose()
    assert secret.encode() not in (tmp_path / "tally.db").read_bytes()
    assert repo.revoke_token(lid, token.id)
    assert repo.resolve_token(secret) is None


def test_unknown_ledger():
    eng = db.connect("sqlite://")
    db.migrate(eng)
    with pytest.raises(db.LedgerNotFoundError):
        db.LedgerRepository(eng, KEYRING).load("nope")


def test_postgres_urls_use_psycopg():
    eng = db.connect("postgresql://u:p@localhost:5432/tally")
    assert eng.dialect.driver == "psycopg"
