from __future__ import annotations

import importlib.util
import json
import sys
import types
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from rich.console import Console
from typer.testing import CliRunner

from tally import cli, config
from tally.classify.base import Request
from tally.model import (
    ImportPreview,
    LowConfidenceFinding,
    ParsedFile,
    ParsedRow,
    PreviewFile,
    Source,
    Transaction,
)
from tally.parsers import ParseError
from tally.store import Store

runner = CliRunner()
DESCRIPTORS = ("CORNER BAKERY 12", "ACME HARDWARE", "MOONLIGHT CINEMA")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    for var in (
        "TALLY_TOKEN",
        "TALLY_PROVIDER",
        "TALLY_TOKEN_COMMAND",
        "OPENAI_API_KEY",
        "TALLY_OPENAI_API_KEY",
        "TALLY_IMPORT_ROOT",
        "TALLY_SERVER_URL",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("TALLY_CONFIG", str(tmp_path / "absent.toml"))
    monkeypatch.setenv("TALLY_DB", str(tmp_path / "state" / "tally.db"))
    monkeypatch.setattr(cli, "console", Console(width=240))
    monkeypatch.setattr(cli, "err", Console(width=240, stderr=True))


def _db(tmp_path: Path) -> Store:
    return Store.open(tmp_path / "state" / "tally.db")


# config


@pytest.mark.parametrize(
    "rel",
    [
        "CRA/notice.pdf",
        "Investments/PWL/PWL Signed Documents/form.pdf",
        "Investments/PWL/PWL Transfer/ID/scan.png",
        "Investments/PWL/PWL Transfer/Forms/a.pdf",
        "Photo ID.pdf",
        "PhotoID.jpg",
        "my_sin.txt",
        "Drivers Licence.pdf",
        "PASSPORT scan.pdf",
        "Docs/ID/whatever.csv",
    ],
)
def test_identity_paths_are_excluded(rel):
    assert config.is_excluded(Path("/r/initial/Finances") / rel)


@pytest.mark.parametrize(
    "rel",
    [
        "Register.csv",
        "Provident Statement.pdf",
        "Business Expenses.csv",
        "Scotiabank/VISA/a.pdf",
        "Investments/PWL/PWL Transfer/Statements/s.pdf",
        "Paid Invoices.pdf",
    ],
)
def test_ordinary_paths_are_not_excluded(rel):
    assert not config.is_excluded(Path("/r/initial/Finances") / rel)


def test_config_file_adds_excludes_but_never_drops_identity(tmp_path):
    cfg = tmp_path / "config.toml"
    cfg.write_text('exclude = ["Receipts"]\nprovider = "fake"\nthreshold = 0.5\n')
    s = config.load(cfg, env={"TALLY_PROVIDER": "codex", "TALLY_DB": "~/x.db"})
    assert s.exclude[: len(config.IDENTITY_DIRS)] == config.IDENTITY_DIRS
    assert "Receipts" in s.exclude
    assert s.provider == "codex"
    assert s.threshold == 0.5
    assert s.db_path == Path.home() / "x.db"
    assert config.is_excluded(Path("/x/Receipts/r.pdf"), s.exclude)


def test_bad_settings_exit_2(monkeypatch):
    monkeypatch.setenv("TALLY_PROVIDER", "somewhere-else")
    result = runner.invoke(cli.app, ["rules", "list"])
    assert result.exit_code == 2
    assert "bad settings" in result.output


def test_token_prefers_env_then_command(monkeypatch):
    s = config.Settings(token_command="echo from-command")
    assert s.token() == "from-command"
    monkeypatch.setenv("TALLY_TOKEN", "from-env")
    assert s.token() == "from-env"


# inventory


class FakeParser:
    def __init__(self, opened: list[Path]) -> None:
        self.opened = opened

    def sniff(self, path: Path, head: bytes) -> bool:
        self.opened.append(path)
        return path.suffix == ".csv"

    def parse(self, path: Path) -> ParsedFile:
        if b"broken" in path.read_bytes():
            raise ParseError(f"{path.name}: three columns, wanted five")
        return _parsed(path.name, profile="invented-bank")


def _tree(root: Path) -> None:
    files = {
        "Bank/one.csv": "x",
        "Bank/two.csv": "x",
        "Bank/bad.csv": "broken",
        "Bank/notes.zip": "z",
        "CRA/letter.csv": "x",
        "Investments/PWL/PWL Transfer/ID/card.csv": "x",
        "Investments/PWL/PWL Transfer/Statements/s.csv": "x",
        "Licence scan.csv": "x",
        ".hidden.csv": "x",
    }
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)


def test_inventory_prints_shapes_and_never_opens_identity_files(tmp_path, monkeypatch):
    root = tmp_path / "finance"
    _tree(root)
    opened: list[Path] = []
    monkeypatch.setattr("tally.parsers.parsers", lambda: (FakeParser(opened),))
    result = runner.invoke(cli.app, ["inventory", str(root), "--json"])
    assert result.exit_code == 0, result.output
    body = json.loads(result.output)
    assert (body["files"], body["excluded"], body["hidden"]) == (5, 3, 1)
    (group,) = body["groups"]
    assert group["family"] == "test_cli:invented-bank"
    assert (group["files"], group["rows"], group["assertions"]) == (3, 9, 0)
    assert group["date_from"] == "2030-01-01"
    reasons = {(e["reason"], e["extension"]): e["files"] for e in body["errors"]}
    assert reasons == {("ParseError", ".csv"): 1, ("archive", ".zip"): 1}
    names = {p.name for p in opened}
    assert names.isdisjoint(
        {"letter.csv", "card.csv", "Licence scan.csv", ".hidden.csv", "notes.zip"}
    )
    assert "DESCRIPTOR" not in result.output
    assert not any(d in result.output for d in DESCRIPTORS)


def test_inventory_table_has_no_row_values(tmp_path, monkeypatch):
    root = tmp_path / "finance"
    _tree(root)
    monkeypatch.setattr("tally.parsers.parsers", lambda: (FakeParser([]),))
    result = runner.invoke(cli.app, ["inventory", str(root)])
    assert result.exit_code == 0, result.output
    assert "Sources" in result.output and "Not parsed" in result.output
    assert not any(d in result.output for d in DESCRIPTORS)
    assert "12.34" not in result.output


# preview


def _parsed(name: str, profile: str | None = None) -> ParsedFile:
    rows = tuple(
        ParsedRow(date=date(2030, 1, i + 1), amount=Decimal(f"-{i + 1}2.34"), descriptor=d)
        for i, d in enumerate(DESCRIPTORS)
    )
    return ParsedFile(
        name=name,
        format="csv",
        institution="Invented Bank",
        account_hint="acct-1",
        rows=rows,
        profile_id=profile,
        sha256=name.encode().hex().ljust(64, "0"),
        date_from=rows[0].date,
        date_to=rows[-1].date,
    )


def fake_engine_preview(files, ledger, classifier, *, threshold, **_):
    rows = [(pf, r) for pf in files for r in pf.rows]
    results = classifier.classify([Request(r.descriptor) for _, r in rows], ledger.categories)
    txs, low = [], []
    for i, ((_, r), res) in enumerate(zip(rows, results, strict=True)):
        tid = f"t{i}"
        txs.append(
            Transaction(
                id=tid,
                account_id="acct-1",
                date=r.date,
                amount=r.amount,
                descriptor=r.descriptor,
                merchant=res.merchant if res else r.descriptor,
                category_id=res.category_id if res else "uncategorized",
                source=res.source if res else Source.manual,
                confidence=res.confidence if res else None,
                batch_id="b",
            )
        )
        if res is not None and res.confidence < threshold:
            low.append(
                LowConfidenceFinding(
                    id=f"l{i}",
                    transaction_id=tid,
                    suggested_category_id=res.category_id,
                    confidence=res.confidence,
                )
            )
    return ImportPreview(
        files=tuple(
            PreviewFile(
                name=f.name,
                format=f.format,
                institution=f.institution,
                account_id="acct-1",
                rows=len(f.rows),
                date_from=f.date_from,
                date_to=f.date_to,
            )
            for f in files
        ),
        new_transactions=tuple(txs),
        findings=tuple(low),
        outbound_strings=tuple(classifier.outbound),
        rules_hit=sum(1 for t in txs if t.source is Source.rule),
        model_calls=len(classifier.audit.batches),
    )


@pytest.fixture
def stand_ins(tmp_path, monkeypatch):
    path = tmp_path / "export.csv"
    path.write_text("invented")
    monkeypatch.setattr("tally.parsers.parse", lambda p: _parsed(p.name))
    monkeypatch.setattr("tally.engine.preview", fake_engine_preview)
    return path


def test_preview_with_the_fake_provider_lists_and_audits_outbound(tmp_path, stand_ins):
    result = runner.invoke(
        cli.app, ["preview", str(stand_ins), "--synthetic", "--provider", "fake"]
    )
    assert result.exit_code == 0, result.output
    assert "3 strings were sent" in result.output
    assert all(d in result.output for d in DESCRIPTORS)
    assert "Low confidence" in result.output
    with _db(tmp_path) as store:
        (batch,) = store.outbound()
        assert sorted(batch.strings) == sorted(DESCRIPTORS)
        assert set(store.answers()) == set(DESCRIPTORS)
        assert store.seen(_parsed("export.csv").sha256, "previewed")


def test_a_second_preview_sends_nothing(tmp_path, stand_ins):
    args = ["preview", str(stand_ins), "--synthetic", "--provider", "fake"]
    runner.invoke(cli.app, args)
    result = runner.invoke(cli.app, args)
    assert result.exit_code == 0, result.output
    assert "No string leaves the lab." in result.output
    with _db(tmp_path) as store:
        assert len(store.outbound()) == 1


def test_dry_run_sends_and_records_nothing(tmp_path, stand_ins):
    result = runner.invoke(
        cli.app, ["preview", str(stand_ins), "--synthetic", "--provider", "fake", "--dry-run"]
    )
    assert result.exit_code == 0, result.output
    assert "3 strings would leave the lab" in result.output
    with _db(tmp_path) as store:
        assert store.outbound() == []
        assert store.answers() == {}


def test_withheld_strings_never_reach_the_provider(tmp_path, stand_ins):
    result = runner.invoke(
        cli.app,
        [
            "preview",
            str(stand_ins),
            "--synthetic",
            "--provider",
            "fake",
            "--withhold",
            "acme hardware",
        ],
    )
    assert result.exit_code == 0, result.output
    assert "2 strings were sent" in result.output
    assert "1 strings withheld." in result.output
    with _db(tmp_path) as store:
        (batch,) = store.outbound()
        assert "ACME HARDWARE" not in batch.strings
        assert "ACME HARDWARE" not in store.answers()


def test_provider_none_sends_nothing(tmp_path, stand_ins):
    result = runner.invoke(cli.app, ["preview", str(stand_ins), "--synthetic"])
    assert result.exit_code == 0, result.output
    assert "No string leaves the lab." in result.output


def test_excluded_files_are_not_parsed(tmp_path, stand_ins, monkeypatch):
    secret = tmp_path / "CRA" / "a.csv"
    secret.parent.mkdir()
    secret.write_text("invented")
    seen: list[str] = []
    monkeypatch.setattr("tally.parsers.parse", lambda p: seen.append(p.name) or _parsed(p.name))
    result = runner.invoke(cli.app, ["preview", str(stand_ins), str(secret), "--synthetic"])
    assert result.exit_code == 0, result.output
    assert seen == ["export.csv"]
    assert "excluded" in result.output


def test_preview_without_a_ledger_exits_2(stand_ins):
    result = runner.invoke(cli.app, ["preview", str(stand_ins)])
    assert result.exit_code == 2


def test_a_ledger_file_is_snapshotted_for_offline_use(tmp_path, stand_ins):
    from tally.synthetic import build_ledger

    led = tmp_path / "ledger.json"
    led.write_text(build_ledger().model_dump_json())
    assert runner.invoke(cli.app, ["preview", str(stand_ins), "--ledger", str(led)]).exit_code == 0
    result = runner.invoke(cli.app, ["preview", str(stand_ins)])
    assert result.exit_code == 0, result.output


@pytest.mark.skipif(
    importlib.util.find_spec("tally.engine_impl") is None, reason="engine_impl is not built yet"
)
def test_preview_through_the_real_engine(tmp_path, monkeypatch):
    path = tmp_path / "export.csv"
    path.write_text("invented")
    monkeypatch.setattr("tally.parsers.parse", lambda p: _parsed(p.name))
    result = runner.invoke(
        cli.app, ["preview", str(path), "--synthetic", "--provider", "fake", "--dry-run"]
    )
    assert result.exit_code == 0, result.output
    assert "Summary" in result.output


# push


def _server(seen: list[httpx.Request], status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json={"id": "p-42", "url": "https://tally.example/i/p-42"})

    return httpx.MockTransport(handler)


def test_push_uploads_with_the_bearer_token_once(tmp_path, monkeypatch, stand_ins):
    seen: list[httpx.Request] = []
    monkeypatch.setenv("TALLY_TOKEN", "t0ken")
    monkeypatch.setattr(cli, "_transport", lambda: _server(seen))
    result = runner.invoke(cli.app, ["push", str(stand_ins)])
    assert result.exit_code == 0, result.output
    assert "p-42" in result.output and "https://tally.example/i/p-42" in result.output
    (req,) = seen
    assert req.url.path == "/api/import/preview"
    assert req.headers["authorization"] == "Bearer t0ken"
    assert b'filename="export.csv"' in req.content
    again = runner.invoke(cli.app, ["push", str(stand_ins)])
    assert "already pushed" in again.output and len(seen) == 1
    runner.invoke(cli.app, ["push", str(stand_ins), "--force"])
    assert len(seen) == 2


def test_push_without_a_token_exits_2(stand_ins):
    assert runner.invoke(cli.app, ["push", str(stand_ins)]).exit_code == 2


def test_push_refused_by_the_server_exits_1(monkeypatch, stand_ins, tmp_path):
    monkeypatch.setenv("TALLY_TOKEN", "t0ken")
    monkeypatch.setattr(cli, "_transport", lambda: _server([], status=403))
    result = runner.invoke(cli.app, ["push", str(stand_ins)])
    assert result.exit_code == 1
    assert "HTTP 403" in result.output
    with _db(tmp_path) as store:
        assert not store.seen(_parsed("export.csv").sha256, "pushed")


def test_push_refuses_excluded_files(monkeypatch, tmp_path):
    monkeypatch.setenv("TALLY_TOKEN", "t0ken")
    seen: list[httpx.Request] = []
    monkeypatch.setattr(cli, "_transport", lambda: _server(seen))
    for name in ("Passport.pdf", "bundle.zip"):
        p = tmp_path / name
        p.write_text("invented")
        assert runner.invoke(cli.app, ["push", str(p)]).exit_code == 2
    assert seen == []


# report


def _fake_report() -> types.ModuleType:
    mod = types.ModuleType("tally.report")

    def net_worth_series(ledger):
        return [
            {"month": "2000-01", "total": 1},
            {"month": "2999-01", "total": 2},
            {"month": ledger.as_of.isoformat()[:7], "total": Decimal("3.50")},
        ]

    def monthly_spend_by_category(ledger, start=None, end=None):
        return {"keys": ["food"], "rows": [{"month": "m", "by": {"food": 1.5}}]}

    def top_merchants(ledger, limit=10):
        return [{"merchant": "Invented Co", "total": 9}]

    def cash_flow(ledger):
        return [{"month": "m", "income": 1, "spend": 2, "net": -1}]

    def sankey(ledger, date_from, date_to):
        assert date_from <= date_to
        return {"nodes": [], "links": [{"source": "a", "target": "b", "value": 4}]}

    for fn in (net_worth_series, monthly_spend_by_category, top_merchants, cash_flow, sankey):
        setattr(mod, fn.__name__, fn)
    return mod


def test_report_renders_the_five_sections(monkeypatch):
    monkeypatch.setitem(sys.modules, "tally.report", _fake_report())
    import tally

    monkeypatch.setattr(tally, "report", sys.modules["tally.report"], raising=False)
    result = runner.invoke(cli.app, ["report", "--synthetic", "--period", "last3"])
    assert result.exit_code == 0, result.output
    for title, _ in cli.REPORT_SECTIONS:
        assert title in result.output
    assert "3.50" in result.output and "2999-01" not in result.output
    assert "by.food" in result.output and "Invented Co" in result.output


@pytest.mark.skipif(
    importlib.util.find_spec("tally.report") is None, reason="tally.report is not built yet"
)
@pytest.mark.parametrize("period", ["ytd", "last3", "month", "all"])
def test_report_on_the_real_aggregates(period):
    result = runner.invoke(cli.app, ["report", "--synthetic", "--period", period])
    assert result.exit_code == 0, result.output
    for title, _ in cli.REPORT_SECTIONS:
        assert title in result.output
    assert "missing" not in result.output and "cannot fill" not in result.output


def test_window_for_each_period():
    from tally.synthetic import build_ledger

    led = build_ledger()
    end = led.as_of
    assert end is not None
    assert cli._window(led, cli.Period.ytd) == (date(end.year, 1, 1), end)
    assert cli._window(led, cli.Period.month) == (end.replace(day=1), end)
    start, _ = cli._window(led, cli.Period.last3) or (None, None)
    assert start is not None and start.day == 1
    assert (end.year * 12 + end.month) - (start.year * 12 + start.month) == 2


# rules


REGISTER_HEADER = (
    '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category",'
    '"Memo","Outflow","Inflow","Cleared"'
)


def _register(path: Path) -> None:
    rows = [
        f'"Chq","","2030-01-0{d}","Corner Bakery","Everyday: Groceries","Everyday","Groceries",'
        f'"","$1{d}.00","$0.00","Cleared"'
        for d in range(1, 4)
    ]
    rows.append('"Chq","","2030-01-05","Transfer : Savings","","","","","$5.00","$0.00","Cleared"')
    path.write_text("﻿" + "\n".join([REGISTER_HEADER, *rows]) + "\n")


def test_seed_ynab_prints_counts_and_stores_rules(tmp_path):
    reg = tmp_path / "Register.csv"
    _register(reg)
    result = runner.invoke(cli.app, ["rules", "seed-ynab", str(reg)])
    assert result.exit_code == 0, result.output
    assert "1 rules seeded" in result.output
    assert "Corner Bakery" not in result.output
    listed = runner.invoke(cli.app, ["rules", "list"])
    assert "1 rules" in listed.output
    exported = json.loads(runner.invoke(cli.app, ["rules", "export"]).output)
    assert len(exported["rules"]) == 1 and exported["answers"] == []


def test_rules_export_to_a_file(tmp_path):
    out = tmp_path / "rules.json"
    result = runner.invoke(cli.app, ["rules", "export", "--out", str(out)])
    assert result.exit_code == 0, result.output
    assert json.loads(out.read_text()) == {"rules": [], "answers": []}


# serve


def test_serve_passes_synthetic_and_port_to_uvicorn(monkeypatch):
    calls: dict[str, object] = {}
    mod = types.ModuleType("tally.server.app")

    def create_app(*, synthetic: bool = False) -> str:
        calls["synthetic"] = synthetic
        return "asgi-app"

    mod.create_app = create_app  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tally.server.app", mod)
    monkeypatch.setenv("TALLY_SYNTHETIC", "0")
    import uvicorn

    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: calls.update(app=app, **kw))
    result = runner.invoke(cli.app, ["serve", "--synthetic", "--port", "9999"])
    assert result.exit_code == 0, result.output
    assert calls == {"synthetic": True, "app": "asgi-app", "host": "127.0.0.1", "port": 9999}


def test_serve_without_a_server_says_so(monkeypatch):
    monkeypatch.setitem(sys.modules, "tally.server.app", None)
    result = runner.invoke(cli.app, ["serve"])
    assert result.exit_code == 1
    assert "not built yet" in result.output


@pytest.mark.parametrize(
    ("args", "env"),
    [
        (["serve", "--synthetic", "--host", "0.0.0.0"], {}),
        (["serve", "--host", "0.0.0.0"], {"TALLY_DEV_LOGIN": "dev@example.invalid"}),
    ],
)
def test_a_dev_login_never_binds_beyond_loopback(monkeypatch, args, env):
    ran: list[object] = []
    import uvicorn

    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: ran.append(app))
    monkeypatch.setenv("TALLY_SYNTHETIC", "0")
    monkeypatch.delenv("TALLY_ALLOW_DEV_LOGIN", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    result = runner.invoke(cli.app, args)
    assert result.exit_code == 2
    assert "TALLY_ALLOW_DEV_LOGIN" in result.output
    assert ran == []
