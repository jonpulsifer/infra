from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tally.model import ParsedFile
from tally.server.app import create_app
from tally.server.context import Services, Settings
from tally.server.crypto import Keyring

KEYRING = Keyring(active="v1", keys={"v1": bytes(range(32))})
OWNER = "owner@example.invalid"
VIEWER = "partner@example.invalid"
STRANGER = "stranger@example.invalid"


def parse_json(path: Path) -> ParsedFile:
    return ParsedFile.model_validate_json(path.read_text())


def make(**overrides) -> tuple[TestClient, Services]:
    settings = Settings(
        database_url="sqlite://",
        keyring=KEYRING,
        owners=frozenset({OWNER, VIEWER}),
        web_dist=None,
        parse=parse_json,
        **overrides,
    )
    app = create_app(settings)
    return TestClient(app), app.state.services


def as_(login: str, **extra: str) -> dict[str, str]:
    return {"Tailscale-User-Login": login, "Tailscale-User-Name": "Someone", **extra}


@pytest.fixture
def client() -> TestClient:
    return make()[0]


def test_no_identity_is_refused(client):
    assert client.get("/api/me").status_code == 401


@pytest.mark.parametrize("login", ["tagged-devices", "build-box.tail1234.ts.net"])
def test_tagged_nodes_are_refused(client, login):
    assert client.get("/api/me", headers=as_(login)).status_code == 403


def test_a_login_with_no_ledger_is_refused(client):
    assert client.get("/api/me", headers=as_(STRANGER)).status_code == 403


def test_an_owner_gets_a_ledger_on_first_sight(client):
    first = client.get("/api/me", headers=as_(OWNER))
    assert first.status_code == 200
    body = first.json()
    assert body["role"] == "owner"
    assert body["via"] == "tailscale"
    assert body["name"] == "Someone"
    again = client.get("/api/me", headers=as_(OWNER)).json()
    assert again["ledgerId"] == body["ledgerId"]
    assert len(again["memberships"]) == 1


def test_dev_login_stands_in_only_without_headers():
    client, _ = make(dev_login=OWNER)
    assert client.get("/api/me").json()["via"] == "dev"
    assert client.get("/api/me", headers=as_(STRANGER)).status_code == 403


def test_viewers_read_but_do_not_write(client):
    client.get("/api/me", headers=as_(OWNER))
    invited = client.post("/api/members", json={"login": STRANGER}, headers=as_(OWNER))
    assert invited.status_code == 201
    assert {m["login"] for m in invited.json()} == {OWNER, STRANGER}
    viewer = as_(STRANGER)
    assert client.get("/api/me", headers=viewer).json()["role"] == "viewer"
    assert client.get("/api/ledger", headers=viewer).status_code == 200
    assert client.get("/api/rules", headers=viewer).status_code == 200
    for method, path, kwargs in [
        ("post", "/api/rules", {"json": {"match": "x", "categoryId": "c", "merchant": "m"}}),
        ("post", "/api/import/preview", {"files": {"files": ("a.json", b"{}")}}),
        ("post", "/api/accounts", {"json": {"name": "n", "kind": "asset", "since": "2030-01-01"}}),
        ("get", "/api/audit", {}),
        ("post", "/api/members", {"json": {"login": "x@example.invalid"}}),
        ("post", "/api/tokens", {}),
    ]:
        assert getattr(client, method)(path, headers=viewer, **kwargs).status_code == 403, path


def test_the_ledger_header_chooses_among_memberships(client):
    mine = client.get("/api/me", headers=as_(OWNER)).json()["ledgerId"]
    theirs = client.get("/api/me", headers=as_(VIEWER)).json()["ledgerId"]
    client.post("/api/members", json={"login": OWNER}, headers=as_(VIEWER))
    assert client.get("/api/me", headers=as_(OWNER)).json()["ledgerId"] == mine
    chosen = client.get("/api/me", headers=as_(OWNER, **{"X-Tally-Ledger": theirs})).json()
    assert (chosen["ledgerId"], chosen["role"]) == (theirs, "viewer")
    refused = client.get("/api/me", headers=as_(STRANGER, **{"X-Tally-Ledger": mine}))
    assert refused.status_code == 403


def test_tagged_logins_cannot_be_invited(client):
    client.get("/api/me", headers=as_(OWNER))
    got = client.post("/api/members", json={"login": "tagged-devices"}, headers=as_(OWNER))
    assert got.status_code == 422


def test_bearer_tokens_act_for_the_owner_but_cannot_mint(client):
    client.get("/api/me", headers=as_(OWNER))
    minted = client.post("/api/tokens", headers=as_(OWNER))
    assert minted.status_code == 201
    secret = minted.json()["secret"]
    bearer = {"Authorization": f"Bearer {secret}"}
    me = client.get("/api/me", headers=bearer).json()
    assert (me["login"], me["role"], me["via"]) == (OWNER, "owner", "bearer")
    assert client.post("/api/tokens", headers=bearer).status_code == 403
    assert client.post("/api/members", json={"login": STRANGER}, headers=bearer).status_code == 403
    listed = client.get("/api/tokens", headers=as_(OWNER)).json()
    assert [t["secret"] for t in listed] == [None]
    gone = client.delete(f"/api/tokens/{minted.json()['id']}", headers=as_(OWNER))
    assert gone.status_code == 204
    assert client.get("/api/me", headers=bearer).status_code == 401


def test_a_bad_bearer_token_is_refused_even_with_headers(client):
    client.get("/api/me", headers=as_(OWNER))
    headers = as_(OWNER, Authorization="Bearer nope")
    assert client.get("/api/me", headers=headers).status_code == 401


def test_removing_a_member_ends_their_access(client):
    client.get("/api/me", headers=as_(OWNER))
    client.post("/api/members", json={"login": STRANGER}, headers=as_(OWNER))
    assert client.delete(f"/api/members/{STRANGER}", headers=as_(OWNER)).status_code == 204
    assert client.get("/api/me", headers=as_(STRANGER)).status_code == 403
    assert client.delete(f"/api/members/{OWNER}", headers=as_(OWNER)).status_code == 404
