import pytest
from fastapi.testclient import TestClient

from tally.server.app import create_app
from tally.server.context import Settings
from tally.server.crypto import Keyring

KEYRING = Keyring(active="v1", keys={"v1": bytes(range(32))})


@pytest.fixture
def dist(tmp_path):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>tally</title>")
    (root / "assets" / "index-abc123.js").write_text("console.log(1)")
    (root / "favicon.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("outside the dist")
    return root


def client_for(dist) -> TestClient:
    return TestClient(create_app(Settings(keyring=KEYRING, web_dist=dist)))


def test_index_and_spa_fallback(dist):
    client = client_for(dist)
    for path in ("/", "/transactions", "/accounts/acct-1"):
        got = client.get(path)
        assert got.status_code == 200, path
        assert "<title>tally</title>" in got.text
        assert got.headers["cache-control"] == "no-cache"


def test_a_nul_in_the_path_is_not_found(dist):
    assert client_for(dist).get("/a%00b").status_code == 404


def test_hashed_assets_are_immutable(dist):
    got = client_for(dist).get("/assets/index-abc123.js")
    assert got.status_code == 200
    assert "immutable" in got.headers["cache-control"]
    assert client_for(dist).get("/favicon.svg").headers["cache-control"] == "no-cache"


def test_a_missing_file_is_not_the_index(dist):
    assert client_for(dist).get("/assets/gone.js").status_code == 404


def test_the_api_wins(dist):
    client = client_for(dist)
    assert client.get("/api/nope").status_code == 404
    assert client.get("/api/nope").headers["content-type"].startswith("application/json")
    assert client.get("/api/me").status_code == 401
    assert client.get("/healthz").json() == {"status": "ok"}


def test_no_escape_from_the_dist(dist):
    client = client_for(dist)
    for path in ("/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"):
        assert "outside the dist" not in client.get(path).text, path


def test_without_a_build_only_the_api_is_served(tmp_path):
    client = client_for(tmp_path / "missing")
    assert client.get("/").status_code == 404
    assert client.get("/healthz").status_code == 200
