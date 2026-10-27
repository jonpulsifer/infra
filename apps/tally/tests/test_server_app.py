import base64
import json
import logging

import pytest
from fastapi.testclient import TestClient

from tally.server import app as server_app
from tally.server.app import create_app
from tally.server.context import Settings
from tally.server.crypto import KeyringError

KEYRING_JSON = json.dumps({"active": "v1", "keys": {"v1": base64.b64encode(bytes(32)).decode()}})


def test_synthetic_mode_seeds_a_ledger_and_needs_no_headers():
    client = TestClient(create_app(Settings(synthetic=True, web_dist=None)))
    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["role"] == "owner"
    ledger = client.get("/api/ledger").json()
    assert len(ledger["transactions"]) > 0
    assert client.get("/api/report/net-worth").status_code == 200


def test_synthetic_mode_without_the_builder_seeds_an_empty_ledger(monkeypatch, caplog):
    real_import = __import__

    def no_synthetic(name, *args, **kwargs):
        if name == "tally.synthetic":
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr("builtins.__import__", no_synthetic)
    with caplog.at_level(logging.WARNING):
        client = TestClient(create_app(Settings(synthetic=True, web_dist=None)))
    assert "seeding an empty ledger" in caplog.text
    assert client.get("/api/me").json()["login"] == server_app.DEFAULT_SYNTHETIC_LOGIN
    assert client.get("/api/ledger").json()["transactions"] == []


def test_settings_never_print_the_database_password():
    assert "hunter2" not in repr(Settings(database_url="postgresql://tally:hunter2@db/tally"))


def test_production_needs_a_keyring():
    with pytest.raises(KeyringError):
        create_app(Settings(web_dist=None))


def test_settings_from_env():
    settings = Settings.from_env(
        {
            "TALLY_DATABASE_URL": "postgresql://u@db/tally",
            "TALLY_KEYRING": KEYRING_JSON,
            "TALLY_OWNERS": " a@example.invalid, ,b@example.invalid",
            "TALLY_WEB_DIST": "/srv/web",
        }
    )
    assert settings.owners == {"a@example.invalid", "b@example.invalid"}
    assert settings.keyring is not None
    assert settings.dev_login is None
    assert str(settings.web_dist) == "/srv/web"
    assert not settings.synthetic


def test_settings_need_a_database_outside_synthetic_mode():
    with pytest.raises(ValueError, match="TALLY_DATABASE_URL"):
        Settings.from_env({"TALLY_KEYRING": KEYRING_JSON})


def test_synthetic_from_env_needs_no_database_or_keyring():
    settings = Settings.from_env({"TALLY_SYNTHETIC": "1"})
    assert settings.synthetic
    assert settings.database_url == "sqlite://"
    assert settings.keyring is None


def test_create_app_reads_the_environment(monkeypatch):
    monkeypatch.delenv("TALLY_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("TALLY_WEB_DIST", "/nonexistent")
    client = TestClient(create_app(synthetic=True))
    assert client.get("/api/me").status_code == 200
