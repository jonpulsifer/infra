"""`tally load` end to end: a finance directory into the real server app, twice."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from rich.console import Console
from typer.testing import CliRunner

from tally import cli, config, files, load
from tally.engine import Decisions
from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    DuplicateFinding,
    ImportPreview,
    Ledger,
    Member,
    ParsedFile,
    ParsedRow,
    PreviewFile,
    Transaction,
)
from tally.server.app import create_app
from tally.server.context import Settings
from tally.server.crypto import Keyring
from tally.store import Store

KEYRING = Keyring(active="v1", keys={"v1": bytes(range(32))})
OWNER = "owner@example.invalid"
HEADERS = {"Tailscale-User-Login": OWNER}

YNAB_HEADER = (
    '"Account","Flag","Date","Payee","Category Group/Category","Category Group",'
    '"Category","Memo","Outflow","Inflow","Cleared"'
)
# Two accounts, four categorised rows, one transfer pair, one uncategorised row.
YNAB_ROWS = [
    '"Test Chequing","","2031-01-02","Fake Mart","Everyday: Groceries","Everyday","Groceries",'
    '"","$25.10","$0.00","Reconciled"',
    '"Test Chequing","","2031-01-15","Example Corp","Inflow: Salary","Inflow","Salary",'
    '"","$0.00","$1,500.00","Reconciled"',
    '"Test Chequing","","2031-01-20","Transfer : Test Visa","","","","","$100.00",'
    '"$0.00","Reconciled"',
    '"Test Visa","","2031-01-20","Transfer : Test Chequing","","","","","$0.00",'
    '"$100.00","Reconciled"',
    '"Test Visa","","2031-01-21","Lantern Cafe","Everyday: Coffee","Everyday","Coffee",'
    '"","$4.50","$0.00","Reconciled"',
    '"Test Visa","","2031-01-22","Widget Shop","Odd Group: Widgets","Odd Group","Widgets",'
    '"","$30.00","$0.00","Reconciled"',
    '"Test Visa","","2031-01-23","Mystery Vendor","","","","","$7.00","$0.00","Reconciled"',
]
# The bank's own export of the chequing account: the same money, bank spellings, one row more.
SCOTIA_ROWS = [
    "1/2/31,-25.10,-,POS Purchase,FAKE MART 0001",
    "1/15/31,1500.00,-,Payroll Deposit,EXAMPLE CORP",
    "1/20/31,-100.00,-,Customer Transfer Dr.,TO VISA",
    "2/3/31,-3.00,-,Service Charge,MONTHLY FEE",
]


def write(path: Path, lines: list[str], encoding: str = "utf-8") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes("\r\n".join(lines).encode(encoding) + b"\r\n")
    return path


@pytest.fixture
def finance(tmp_path: Path) -> Path:
    root = tmp_path / "finance"
    write(root / "Finances" / "Register.csv", [YNAB_HEADER, *YNAB_ROWS], "utf-8-sig")
    chq = write(root / "Finances" / "Scotiabank" / "chq.csv", SCOTIA_ROWS)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("exports/chq-copy.csv", chq.read_bytes())
        zf.writestr("manage.statements.pdfFilename", b"%PDF-1.4 not really")
        zf.writestr("Passport.pdf", b"%PDF-1.4 not really")
        zf.writestr("inner.zip", b"PK")
    (root / "Finances" / "Scotiabank" / "2031 e-statements.zip").write_bytes(buf.getvalue())
    write(root / "Finances" / "CRA" / "secret.csv", SCOTIA_ROWS)
    (root / "Finances" / "junk.pdf").write_bytes(b"%PDF-1.7 garbage")
    return root


@pytest.fixture
def http() -> TestClient:
    settings = Settings(
        database_url="sqlite://", keyring=KEYRING, owners=frozenset({OWNER}), web_dist=None
    )
    client = TestClient(create_app(settings), headers=HEADERS)
    assert client.get("/api/me").status_code == 200
    return client


@pytest.fixture
def settings(tmp_path: Path) -> config.Settings:
    return config.Settings(db_path=tmp_path / "state" / "tally.db")


def run(root: Path, settings: config.Settings, http: TestClient, **kw) -> load.Report:
    with Store.open(settings.db_path) as store:
        return load.run(root, settings, load.Remote(http), store, **kw)


def test_collect_opens_zips_sniffs_members_and_keeps_identity_names_out(finance, settings, tmp):
    found = load.collect(finance, settings, tmp)
    shown = {s.shown for s in found.sources}
    assert shown == {"Register.csv", "chq.csv", "2031 e-statements__chq-copy.csv"}
    reasons = {s.name: s.reason for s in found.skipped}
    assert reasons["2031 e-statements__Passport.pdf"] == "excluded"
    assert reasons["2031 e-statements__inner.zip"] == "an archive inside an archive"
    assert reasons["2031 e-statements__manage.statements.pdfFilename.pdf"] == "unreadable PDF"
    assert reasons["junk.pdf"] == "unreadable PDF"
    assert found.excluded == 1  # the CRA directory, pruned before descent
    assert "secret.csv" not in shown


@pytest.fixture
def tmp(tmp_path: Path) -> Path:
    out = tmp_path / "scratch"
    out.mkdir()
    return out


def test_batches_put_the_register_first_then_rows_by_date_then_statements():
    def src(name, profile=None, rows=1, on=date(2031, 1, 1), fmt="csv", kind=None):
        pf = ParsedFile(
            name=name,
            format=fmt,
            institution="X",
            account_hint="h",
            account_kind_hint=kind,
            profile_id=profile,
            rows=tuple(
                ParsedRow(date=on, amount=Decimal("-1"), descriptor="d") for _ in range(rows)
            ),
            sha256=name.encode().hex().ljust(64, "0")[:64],
            date_from=on,
            date_to=on,
        )
        return load.Source(Path(name), name, pf)

    sources = [
        src("holdings.pdf", rows=0, fmt="pdf", kind=AccountKind.investment),
        src("late.csv", on=date(2031, 6, 1)),
        src("Register.csv", profile="ynab-register", on=date(2031, 3, 1)),
        src("early.csv", on=date(2031, 2, 1)),
    ]
    got = [[s.shown for s in b] for b in load.batches(sources)]
    assert got == [["Register.csv"], ["early.csv", "late.csv"], ["holdings.pdf"]]


def test_load_twice_adds_once_and_maps_the_bank_export_onto_the_register_account(
    finance, settings, http
):
    first = run(finance, settings, http, dry_run=False)
    ledger = load.Remote(http).ledger()

    names = {a.name: a for a in ledger.accounts}
    assert {"Test Chequing", "Test Visa"} <= set(names)
    assert names["Test Visa"].kind is AccountKind.credit
    assert names["Test Chequing"].kind is AccountKind.chequing
    # the bank export landed in the register's chequing account: three duplicates, one new row
    assert first.accounts["chq.csv"] == names["Test Chequing"].id
    (register, bank) = first.batches
    assert (register.added, bank.added) == (len(YNAB_ROWS), 1)
    # the export and its copy in the zip: 2 x 4 rows; 6 already held by id, 3 dropped
    assert (bank.files, bank.rows, bank.held, bank.new, bank.dropped) == (2, 8, 6, 2, 3)
    assert bank.unmatched_in_overlap == 0
    assert first.added == len(ledger.transactions) == len(YNAB_ROWS) + 1
    # the owner's categories came along, and the rules they seed classified the bank spellings
    cats = {c.id for c in ledger.categories}
    by_desc = {t.descriptor: t for t in ledger.transactions}
    assert by_desc["Lantern Cafe"].category_id == "coffee"
    assert by_desc["Widget Shop"].category_id in cats
    assert by_desc["Widget Shop"].category_id.startswith("ynab")
    assert by_desc["Widget Shop"].tags == ("ynab:Odd Group/Widgets",)
    assert {r.match for r in ledger.rules} >= {"fake mart", "lantern cafe", "widget shop"}
    assert by_desc["MONTHLY FEE"].category_id == "uncategorized"
    assert [t for t in ledger.transactions if t.transfer_id]
    # what disagreed: the junk PDF and the identity member, nothing else
    assert {s.name for s in first.skipped} == {
        "junk.pdf",
        "2031 e-statements__Passport.pdf",
        "2031 e-statements__inner.zip",
        "2031 e-statements__manage.statements.pdfFilename.pdf",
    }
    assert first.unclear == [] and first.gaps == []
    assert first.uncategorised == 2  # the mystery vendor and the monthly fee

    second = run(finance, settings, http, dry_run=False)
    assert second.added == 0
    assert second.already == 3
    assert second.batches == []
    again = load.Remote(http).ledger()
    assert len(again.transactions) == len(ledger.transactions)
    assert again.categories == ledger.categories and again.rules == ledger.rules
    with Store.open(settings.db_path) as store:
        assert store.account_map() == {
            "Scotiabank:scotiabank-chequing-headerless": names["Test Chequing"].id
        }

    forced = run(finance, settings, http, dry_run=False, force=True)
    assert forced.added == 0 and len(forced.batches) == 2
    assert len(load.Remote(http).ledger().transactions) == len(ledger.transactions)


def test_a_dry_run_decides_everything_and_sends_nothing(finance, settings, http):
    remote = load.Remote(http)
    target = load.Local(remote.ledger(), dedupe_window_days=3, transfer_window_days=4)
    with Store.open(settings.db_path) as store:
        report = load.run(finance, settings, target, store, dry_run=True)
        assert store.account_map() == {}
    assert report.added == len(YNAB_ROWS) + 1
    assert report.dry_run and "chq.csv" in report.accounts
    assert remote.ledger().transactions == ()


def test_an_export_that_matches_two_accounts_waits_for_the_owner():
    def acct(id_):
        return Account(
            id=id_, name=id_, institution="Bank", kind=AccountKind.chequing, since=date(2031, 1, 1)
        )

    def txn(id_, acct_id):
        return Transaction(
            id=id_,
            account_id=acct_id,
            date=date(2031, 1, 2),
            amount=Decimal("-25.10"),
            descriptor="FAKE MART",
            merchant="Fake Mart",
            category_id="uncategorized",
            batch_id="b",
        )

    ledger = Ledger(
        id="l",
        members=(Member(login=OWNER, role="owner"),),
        accounts=(acct("a"), acct("b")),
        categories=(),
        transactions=(txn("t1", "a"), txn("t2", "b")),
    )
    pf = ParsedFile(
        name="chq.csv",
        format="csv",
        institution="Bank",
        account_hint=None,
        account_kind_hint=AccountKind.chequing,
        profile_id="p",
        rows=(
            ParsedRow(date=date(2031, 1, 2), amount=Decimal("-25.10"), descriptor="FAKE MART 1"),
        ),
        sha256="1" * 64,
        date_from=date(2031, 1, 2),
        date_to=date(2031, 1, 2),
    )
    s = load.Source(Path("chq.csv"), "chq.csv", pf)
    got = load.choose_accounts([s], ledger, remembered={}, overrides={}, window_days=3)
    (u,) = got.unclear
    assert (u.shown, set(u.candidates)) == ("chq.csv", {"a", "b"})
    assert got.chosen == {}

    forced = load.choose_accounts(
        [s], ledger, remembered={}, overrides={"chq.csv": "b"}, window_days=3
    )
    assert forced.chosen == {"chq.csv": "b"} and forced.decided == {"Bank:p": "b"}
    kept = load.choose_accounts(
        [s], ledger, remembered={"Bank:p": "a"}, overrides={}, window_days=3
    )
    assert kept.chosen == {"chq.csv": "a"} and kept.decided == {}


def test_decide_drops_fuzzy_duplicates_but_keeps_a_posting():
    def dup(i, tier, reason):
        return DuplicateFinding(
            id=f"d{i}", transaction_id=f"t{i}", matches_id="m", reason=reason, tier=tier
        )

    p = ImportPreview(
        files=(),
        new_transactions=(),
        findings=(
            dup(1, "fuzzy", "same amount, same day"),
            dup(2, "fitid", "same FITID"),
            dup(3, "fuzzy", "replaces pending row: same amount"),
        ),
        outbound_strings=(),
        rules_hit=0,
        model_calls=0,
    )
    assert load.decide(p) == Decisions(accept_findings=frozenset({"d1"}))


def test_balance_gaps_cover_the_whole_ledger_for_laddered_accounts_only():
    ledger = Ledger(
        id="l",
        members=(Member(login=OWNER, role="owner"),),
        accounts=(
            Account(
                id="c", name="c", institution="B", kind=AccountKind.chequing, since=date(2031, 1, 1)
            ),
            Account(
                id="i",
                name="i",
                institution="B",
                kind=AccountKind.investment,
                since=date(2031, 1, 1),
            ),
        ),
        categories=(),
        transactions=(
            Transaction(
                id="t",
                account_id="c",
                date=date(2031, 1, 5),
                amount=Decimal("10"),
                descriptor="x",
                merchant="x",
                category_id="uncategorized",
                batch_id="b",
            ),
        ),
        assertions=(
            BalanceAssertion(
                account_id="c", date=date(2031, 1, 1), balance=Decimal("0"), origin="s1"
            ),
            BalanceAssertion(
                account_id="c", date=date(2031, 1, 31), balance=Decimal("15"), origin="s2"
            ),
            BalanceAssertion(
                account_id="i", date=date(2031, 1, 31), balance=Decimal("999"), origin="s3"
            ),
        ),
    )
    (gap,) = load.balance_gaps(ledger)
    assert (gap.account_id, load.difference(gap)) == ("c", Decimal("5"))


def test_unpack_refuses_what_is_not_a_zip(tmp_path, settings):
    bad = tmp_path / "x.zip"
    bad.write_bytes(b"nope")
    (got,) = list(files.unpack(bad, settings, tmp_path / "out"))
    assert got.path is None and got.reason == "not a zip tally can open"


# the command


def test_the_load_command_reports_and_exits_3_on_discrepancies(
    finance, settings, http, monkeypatch
):
    monkeypatch.setenv("TALLY_CONFIG", str(finance / "absent.toml"))
    monkeypatch.setenv("TALLY_DB", str(settings.db_path))
    monkeypatch.setenv("TALLY_TOKEN", "t0ken")
    monkeypatch.setattr(cli, "_server", lambda _settings, _token: http)
    monkeypatch.setattr(cli, "console", Console(width=240))
    monkeypatch.setattr(cli, "err", Console(width=240, stderr=True))
    runner = CliRunner()

    result = runner.invoke(cli.app, ["load", str(finance), "--dry-run"])
    assert result.exit_code == 3, result.output
    assert "rows would be added" in result.output
    assert "Accounts decided" in result.output and "Test Chequing" in result.output
    assert "Not read" in result.output and "junk.pdf" in result.output
    assert load.Remote(http).ledger().transactions == ()

    result = runner.invoke(cli.app, ["load", str(finance), "--json"])
    assert result.exit_code == 3, result.output
    body = json.loads(result.output)
    assert body["added"] == len(YNAB_ROWS) + 1
    assert [s["name"] for s in body["skipped"]]

    args = ["load", str(finance), "--force", "--account", "chq.csv=nope"]
    again = runner.invoke(cli.app, args)
    assert again.exit_code == 3
    assert "no account nope" in again.output


def test_the_load_command_needs_a_token(finance, monkeypatch):
    monkeypatch.delenv("TALLY_TOKEN", raising=False)
    monkeypatch.setenv("TALLY_CONFIG", str(finance / "absent.toml"))
    assert CliRunner().invoke(cli.app, ["load", str(finance)]).exit_code == 2


def test_preview_file_wire_round_trip():
    pf = PreviewFile(
        name="a.csv",
        format="csv",
        institution=None,
        account_id=None,
        rows=1,
        date_from=date(2031, 1, 1),
        date_to=date(2031, 1, 2),
    )
    body = {
        "files": [
            {
                "name": "a.csv",
                "format": "csv",
                "institution": None,
                "accountId": None,
                "rows": 1,
                "from": "2031-01-01",
                "to": "2031-01-02",
            }
        ],
        "newTransactions": [],
        "findings": [],
        "outboundStrings": [],
        "rulesHit": 0,
        "modelCalls": 0,
    }
    assert load.preview_from_wire(body).files == (pf,)
