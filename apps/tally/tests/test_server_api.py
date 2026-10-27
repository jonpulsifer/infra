import json
from collections.abc import Sequence
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tally.classify.base import Request, Result
from tally.model import (
    AccountKind,
    BalanceAssertion,
    Category,
    Flow,
    HoldingSnapshot,
    Ledger,
    ParsedFile,
    ParsedRow,
    Position,
    Source,
)
from tally.parsers import ParseError
from tally.server.app import create_app
from tally.server.context import Services, Settings
from tally.server.crypto import Keyring
from tally.server.db import ConflictError

KEYRING = Keyring(active="v1", keys={"v1": bytes(range(32))})
OWNER = "owner@example.invalid"
HEADERS = {"Tailscale-User-Login": OWNER}
CATEGORIES = (
    Category(id="food", name="Food", parent_id=None, flow=Flow.expense),
    Category(id="food.cafe", name="Cafe", parent_id="food", flow=Flow.expense),
    Category(id="home", name="Home", parent_id=None, flow=Flow.expense),
    Category(id="pay", name="Pay", parent_id=None, flow=Flow.income),
)
ROWS = (
    ("2030-01-02", "-4.50", "INVENTED BEANS #12 TOWNVILLE"),
    ("2030-01-03", "-5.25", "INVENTED BEANS #12 TOWNVILLE"),
    ("2030-01-04", "-61.10", "MADE UP HARDWARE 0099"),
    ("2030-01-15", "2100.00", "PAYROLL FICTIONAL LTD"),
)


def parse_json(path: Path) -> ParsedFile:
    if path.suffix != ".json":
        raise ParseError(f"{path.name}: not a stand-in")
    return ParsedFile.model_validate_json(path.read_text())


def stand_in(name: str = "january.qfx", rows=ROWS) -> bytes:
    parsed = ParsedFile(
        name=name,
        format="qfx",
        institution="Invented Mutual",
        account_hint="CHQ-0001",
        account_kind_hint=AccountKind.chequing,
        rows=tuple(
            ParsedRow(date=date.fromisoformat(d), amount=Decimal(a), descriptor=s)
            for d, a, s in rows
        ),
        sha256="a" * 64,
        date_from=date.fromisoformat(rows[0][0]),
        date_to=date.fromisoformat(rows[-1][0]),
    )
    return parsed.model_dump_json().encode()


class FakeClassifier:
    """Files everything under food.cafe with low confidence, remembering what it saw."""

    name = "fake"

    def __init__(self) -> None:
        self.seen: list[Request] = []

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        self.seen.extend(requests)
        return [
            Result(r.descriptor, "food.cafe", r.descriptor.title(), 0.5, Source.model)
            for r in requests
        ]


def make(**overrides) -> tuple[TestClient, Services]:
    defaults = {
        "database_url": "sqlite://",
        "keyring": KEYRING,
        "owners": frozenset({OWNER}),
        "web_dist": None,
        "parse": parse_json,
    }
    settings = Settings(**{**defaults, **overrides})
    app = create_app(settings)
    client = TestClient(app)
    lid = client.get("/api/me", headers=HEADERS).json()["ledgerId"]
    svc: Services = app.state.services
    ledger = svc.repo.load(lid)
    svc.repo.save(ledger.model_copy(update={"categories": CATEGORIES}))
    return client, svc


@pytest.fixture
def client() -> TestClient:
    return make()[0]


def upload(client: TestClient, *files: tuple[str, bytes]):
    parts = [("files", (name, body, "application/json")) for name, body in files]
    return client.post("/api/import/preview", files=parts, headers=HEADERS)


def imported(client: TestClient) -> dict:
    preview = upload(client, ("january.json", stand_in())).json()
    applied = client.post(f"/api/import/preview/{preview['id']}/apply", headers=HEADERS)
    assert applied.status_code == 200, applied.text
    return client.get("/api/ledger", headers=HEADERS).json()


def test_preview_then_apply(client):
    got = upload(client, ("january.json", stand_in()))
    assert got.status_code == 201, got.text
    body = got.json()
    preview = body["preview"]
    assert len(preview["newTransactions"]) == len(ROWS)
    assert preview["files"][0]["from"] == "2030-01-02"
    assert isinstance(preview["newTransactions"][0]["amount"], float)
    again = client.get(f"/api/import/preview/{body['id']}", headers=HEADERS).json()
    assert again["preview"] == preview

    applied = client.post(f"/api/import/preview/{body['id']}/apply", json={}, headers=HEADERS)
    assert applied.status_code == 200, applied.text
    assert applied.json()["added"] == len(ROWS)
    ledger = client.get("/api/ledger", headers=HEADERS).json()
    assert len(ledger["transactions"]) == len(ROWS)
    assert ledger["accounts"][0]["institution"] == "Invented Mutual"
    assert ledger["owner"] == OWNER
    assert ledger["asOf"] == "2030-01-15"
    assert len(ledger["batches"]) == 1
    gone = client.get(f"/api/import/preview/{body['id']}", headers=HEADERS)
    assert gone.status_code == 404


def statement_stand_in() -> bytes:
    on = date(2030, 1, 31)
    cash = Position(
        symbol="CASH",
        name="Cash",
        quantity=Decimal("25.00"),
        price=Decimal("1"),
        market_value=Decimal("25.00"),
        book_cost=Decimal("25.00"),
    )
    parsed = ParsedFile(
        name="plan.pdf",
        format="pdf",
        institution="Invented Brokerage",
        account_hint="PLAN-0001",
        account_kind_hint=AccountKind.investment,
        rows=(),
        assertions=(
            BalanceAssertion(
                account_id="PLAN-0001", date=on, balance=Decimal("25.00"), origin="plan.pdf"
            ),
        ),
        holdings=(
            HoldingSnapshot(
                account_id="PLAN-0001",
                date=on,
                positions=(cash,),
                total=Decimal("25.00"),
                origin="statement-pdf",
            ),
        ),
        sha256="b" * 64,
        date_from=on,
        date_to=on,
        pages=2,
    )
    return parsed.model_dump_json().encode()


def test_statement_holdings_and_balances_survive_preview_and_apply(client):
    body = upload(client, ("plan.json", statement_stand_in())).json()
    preview = body["preview"]
    assert preview["files"][0]["accountKind"] == "investment"
    assert [h["total"] for h in preview["holdings"]] == [25.0]
    assert [a["balance"] for a in preview["assertions"]] == [25.0]
    applied = client.post(f"/api/import/preview/{body['id']}/apply", json={}, headers=HEADERS)
    assert applied.status_code == 200, applied.text
    ledger = client.get("/api/ledger", headers=HEADERS).json()
    (account,) = ledger["accounts"]
    assert account["kind"] == "investment"
    assert "PLAN-0001" not in account["id"]
    assert [h["accountId"] for h in ledger["holdings"]] == [account["id"]]
    assert [a["accountId"] for a in ledger["assertions"]] == [account["id"]]


def test_reimport_finds_nothing_new(client):
    imported(client)
    preview = upload(client, ("january.json", stand_in())).json()["preview"]
    assert preview["newTransactions"] == []


def test_a_stale_preview_is_refused(client):
    preview = upload(client, ("january.json", stand_in())).json()
    client.post("/api/rules", json=_rule("beans", "food.cafe"), headers=HEADERS)
    stale = client.post(f"/api/import/preview/{preview['id']}/apply", headers=HEADERS)
    assert stale.status_code == 409


def _rule(match: str, category: str) -> dict:
    return {"match": match, "categoryId": category, "merchant": match.title()}


def test_a_deleted_transaction_is_never_resurrected(client):
    ledger = imported(client)
    victim = ledger["transactions"][0]["id"]
    assert client.delete(f"/api/transactions/{victim}", headers=HEADERS).status_code == 204
    preview = upload(client, ("january.json", stand_in())).json()
    applied = client.post(f"/api/import/preview/{preview['id']}/apply", headers=HEADERS)
    assert applied.json()["skippedTombstoned"] == 1
    ids = [t["id"] for t in client.get("/api/ledger", headers=HEADERS).json()["transactions"]]
    assert victim not in ids
    assert len(ids) == len(ROWS) - 1


def test_only_descriptors_reach_the_classifier_and_the_audit_keeps_them():
    fake = FakeClassifier()
    client, _ = make(classifier_for=lambda _ledger: fake)
    upload(client, ("january.json", stand_in()))
    descriptors = {s for _, _, s in ROWS}
    assert {r.descriptor for r in fake.seen} <= descriptors
    assert all(set(vars(r)) <= {"descriptor", "account_kind"} for r in fake.seen)
    trail = client.get("/api/audit", headers=HEADERS).json()
    assert len(trail) == 1
    assert set(trail[0]["strings"]) <= descriptors
    assert trail[0]["classifier"] == "fake"
    dumped = json.dumps(trail)
    for _, amount, _ in ROWS:
        assert amount.lstrip("-") not in dumped


def test_no_strings_leave_without_a_provider(client):
    upload(client, ("january.json", stand_in()))
    assert client.get("/api/audit", headers=HEADERS).json() == []


def test_recategorise_always_makes_a_rule_and_moves_the_rest(client):
    ledger = imported(client)
    beans = [t for t in ledger["transactions"] if "BEANS" in t["descriptor"]]
    got = client.post(
        f"/api/transactions/{beans[0]['id']}/category",
        json={"categoryId": "food.cafe", "always": True},
        headers=HEADERS,
    )
    assert got.status_code == 200, got.text
    body = got.json()
    assert body["transaction"]["source"] == "manual"
    assert body["rule"]["createdFrom"] == "correction"
    assert body["moved"] == len(beans) - 1
    after = client.get("/api/transactions", params={"category": "food"}, headers=HEADERS).json()
    assert {t["id"] for t in after} == {t["id"] for t in beans}
    assert len(client.get("/api/rules", headers=HEADERS).json()) == 1


def test_recategorise_once_makes_no_rule(client):
    ledger = imported(client)
    txn = ledger["transactions"][0]["id"]
    got = client.post(
        f"/api/transactions/{txn}/category", json={"categoryId": "home"}, headers=HEADERS
    ).json()
    assert got["rule"] is None
    assert got["moved"] == 0


def test_recategorise_refuses_unknown_categories_and_rows(client):
    ledger = imported(client)
    txn = ledger["transactions"][0]["id"]
    bad = client.post(
        f"/api/transactions/{txn}/category", json={"categoryId": "nope"}, headers=HEADERS
    )
    assert bad.status_code == 422
    missing = client.post(
        "/api/transactions/nope/category", json={"categoryId": "home"}, headers=HEADERS
    )
    assert missing.status_code == 404


def test_rules(client):
    made = client.post("/api/rules", json=_rule("/^made up/", "home"), headers=HEADERS)
    assert made.status_code == 201
    assert client.post("/api/rules", json=_rule("/(/", "home"), headers=HEADERS).status_code == 422
    assert client.post("/api/rules", json=_rule("x", "nope"), headers=HEADERS).status_code == 422
    client.post("/api/rules", json=_rule("/^made up/", "home"), headers=HEADERS)
    assert len(client.get("/api/rules", headers=HEADERS).json()) == 1


def test_manual_assets_and_valuations(client):
    made = client.post(
        "/api/accounts",
        json={"name": "The House", "kind": "asset", "since": "2029-06-01"},
        headers=HEADERS,
    )
    assert made.status_code == 201
    acct = made.json()["id"]
    valued = client.post(
        f"/api/accounts/{acct}/valuations",
        json={"date": "2029-06-01", "value": "450000", "source": "purchase"},
        headers=HEADERS,
    )
    assert valued.status_code == 201
    detail = client.get(f"/api/accounts/{acct}", headers=HEADERS).json()
    assert detail["balance"] == 450000
    assert detail["valuations"][0]["source"] == "purchase"
    dup = {"id": acct, "name": "Again", "kind": "asset", "since": "2029-06-01"}
    assert client.post("/api/accounts", json=dup, headers=HEADERS).status_code == 409


def test_valuations_only_for_assets(client):
    ledger = imported(client)
    cheq = ledger["accounts"][0]["id"]
    body = {"date": "2030-02-01", "value": "1", "source": "estimate"}
    got = client.post(f"/api/accounts/{cheq}/valuations", json=body, headers=HEADERS)
    assert got.status_code == 422
    assert client.get("/api/accounts/nope", headers=HEADERS).status_code == 404


def test_transaction_search(client):
    imported(client)
    found = client.get("/api/transactions", params={"text": "beans"}, headers=HEADERS).json()
    assert len(found) == 2
    assert found[0]["date"] > found[1]["date"]
    ranged = client.get(
        "/api/transactions", params={"from": "2030-01-04", "limit": 1}, headers=HEADERS
    ).json()
    assert [t["date"] for t in ranged] == ["2030-01-15"]


def test_reports(client):
    imported(client)
    for name in ("net-worth", "spend", "merchants", "cash-flow", "sankey"):
        got = client.get(f"/api/report/{name}", headers=HEADERS)
        assert got.status_code == 200, name
    flow = client.get(
        "/api/report/cash-flow", params={"from": "2030-01-01", "to": "2030-01-31"}, headers=HEADERS
    ).json()
    assert [row["month"] for row in flow] == ["2030-01"]
    assert client.get("/api/report/nope", headers=HEADERS).status_code == 404


def test_reports_are_pluggable():
    seen: list[tuple[Ledger, date | None, date | None]] = []

    def fake(ledger: Ledger, start: date | None, end: date | None) -> object:
        seen.append((ledger, start, end))
        return {"keptKey": Decimal("1.50")}

    client, _ = make(reports={"fake": fake})
    got = client.get("/api/report/fake", params={"from": "2030-01-01"}, headers=HEADERS)
    assert got.json() == {"keptKey": 1.5}
    assert seen[0][1:] == (date(2030, 1, 1), None)


def test_parse_errors_are_reported_without_rows(client):
    got = upload(client, ("statement.csv", b"2030-01-01,-1.00,SOMETHING"))
    assert got.status_code == 422
    assert "SOMETHING" not in got.text


def test_uploads_have_a_ceiling():
    client, _ = make(max_upload_bytes=64)
    assert upload(client, ("big.json", stand_in())).status_code == 413


def test_ledger_wire_shape_is_camel_case(client):
    ledger = imported(client)
    txn = ledger["transactions"][0]
    assert {"accountId", "categoryId", "batchId", "transferId"} <= txn.keys()
    assert {"parentId", "flow"} <= ledger["categories"][0].keys()
    assert {"owner", "viewers", "asOf", "members"} <= ledger.keys()


def test_an_imported_ledger_leaves_no_plaintext_on_disk(tmp_path):
    path = tmp_path / "tally.db"
    client, svc = make(database_url=f"sqlite:///{path}", classifier_for=lambda _: FakeClassifier())
    imported(client)
    upload(client, ("january.json", stand_in()))
    svc.repo.engine.dispose()
    raw = path.read_bytes()
    for day, amount, descriptor in ROWS:
        word = max(descriptor.split(), key=len)
        for needle in (descriptor, word, amount.lstrip("-"), day):
            assert needle.encode() not in raw, needle
    assert b"Invented Mutual" not in raw


def test_a_parse_error_names_the_upload_by_position_not_its_name(client):
    got = upload(client, ("acct-5500123456.csv", b"x"))
    assert got.status_code == 422
    assert "5500123456" not in got.text
    assert "file-1.csv" in got.json()["detail"]


def test_a_dot_dot_upload_name_is_refused_cleanly(client):
    for name in ("..", "."):
        assert upload(client, (name, stand_in())).status_code == 422


def test_the_preview_shows_the_name_the_file_was_uploaded_under(client):
    body = upload(client, ("january.json", stand_in())).json()
    assert [f["name"] for f in body["preview"]["files"]] == ["january.json"]


def test_uploads_have_a_file_count_and_total_ceiling():
    client, _ = make(max_upload_files=2)
    three = [(f"m{i}.json", stand_in()) for i in range(3)]
    assert upload(client, *three).status_code == 422
    client, _ = make(max_request_bytes=len(stand_in()) * 2)
    assert upload(client, *three).status_code == 413


def test_a_cross_site_write_is_refused(client):
    cross = {**HEADERS, "Sec-Fetch-Site": "cross-site"}
    assert client.post("/api/tokens", headers=cross).status_code == 403
    sibling = {**HEADERS, "Sec-Fetch-Site": "same-site"}
    assert client.post("/api/tokens", headers=sibling).status_code == 403
    same = {**HEADERS, "Sec-Fetch-Site": "same-origin"}
    assert client.post("/api/tokens", headers=same).status_code == 201
    assert client.get("/api/me", headers=cross).status_code == 200


def test_the_api_docs_are_not_served_outside_synthetic_mode(client):
    assert client.get("/api/docs").status_code == 404
    assert client.get("/api/openapi.json").status_code == 404


def test_a_stale_write_is_a_conflict_not_a_silent_delete():
    client, svc = make()
    imported(client)
    lid = client.get("/api/me", headers=HEADERS).json()["ledgerId"]
    version, stale = svc.repo.load_versioned(lid)
    svc.repo.save(stale.model_copy(update={"rules": ()}), expected_version=version)
    with pytest.raises(ConflictError):
        svc.repo.save(stale.model_copy(update={"transactions": ()}), expected_version=version)
    assert len(svc.repo.load(lid).transactions) == len(ROWS)
