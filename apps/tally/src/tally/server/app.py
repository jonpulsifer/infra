"""`create_app(settings) -> FastAPI`, and `serve` for the CLI."""

from __future__ import annotations

import logging
from dataclasses import replace

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from tally import __version__
from tally.server.api import router
from tally.server.context import Services, Settings
from tally.server.crypto import Keyring, KeyringError
from tally.server.db import ConflictError, LedgerNotFoundError, LedgerRepository, connect, migrate
from tally.server.guards import BodyLimit, SameOrigin
from tally.server.static import mount_spa

log = logging.getLogger(__name__)

DEFAULT_SYNTHETIC_LOGIN = "owner@tally.invalid"


def create_app(settings: Settings | None = None, *, synthetic: bool = False) -> FastAPI:
    """Build the app. With no settings, read them from the environment."""
    settings = settings or Settings.from_env(synthetic=synthetic)
    keyring = settings.keyring
    if keyring is None:
        if not settings.synthetic:
            raise KeyringError("set TALLY_KEYRING or TALLY_KEYRING_FILE")
        keyring = Keyring.generate("synthetic")
    engine = connect(settings.database_url)
    migrate(engine)
    repo = LedgerRepository(engine, keyring)
    if settings.synthetic:
        settings = seed_synthetic(repo, settings)
    if settings.dev_login:
        log.warning("dev login is set: requests with no tailnet identity act as that login")

    docs = settings.synthetic
    app = FastAPI(
        title="tally",
        version=__version__,
        docs_url="/api/docs" if docs else None,
        openapi_url="/api/openapi.json" if docs else None,
        redoc_url=None,
    )
    app.add_middleware(SameOrigin)
    app.add_middleware(BodyLimit, limit=settings.max_request_bytes)
    app.state.services = Services(settings=settings, repo=repo)
    app.add_exception_handler(ConflictError, _conflict)
    app.add_exception_handler(LedgerNotFoundError, _missing)

    @app.get("/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(router)
    mount_spa(app, settings.web_dist)
    return app


async def _conflict(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": "the ledger changed; reload"}, status.HTTP_409_CONFLICT)


async def _missing(_request: Request, _exc: Exception) -> JSONResponse:
    return JSONResponse({"detail": "no such ledger"}, status.HTTP_404_NOT_FOUND)


def seed_synthetic(repo: LedgerRepository, settings: Settings) -> Settings:
    """Seed the synthetic ledger, or an empty one when `tally.synthetic` is not there yet.

    The seeded owner becomes the dev login unless one is set, so the local web
    app works without tailnet headers.
    """
    try:
        from tally.synthetic import PREVIEW_FROM, build_ledger
    except ImportError:
        login = settings.dev_login or DEFAULT_SYNTHETIC_LOGIN
        log.warning("tally.synthetic is not importable; seeding an empty ledger")
        repo.create_ledger(login)
        return replace(settings, dev_login=login)
    ledger = build_ledger(before=PREVIEW_FROM)
    owner = next((m.login for m in ledger.members if m.role == "owner"), DEFAULT_SYNTHETIC_LOGIN)
    repo.create_ledger(owner, ledger.id)
    for m in ledger.members:
        if m.role == "viewer":
            repo.add_member(ledger.id, m.login, "viewer")
    repo.save(ledger)
    log.info("seeded the synthetic ledger: %d transactions", len(ledger.transactions))
    return replace(settings, dev_login=settings.dev_login or owner)


def serve(settings: Settings, host: str = "127.0.0.1", port: int = 8081) -> None:
    import uvicorn

    uvicorn.run(create_app(settings), host=host, port=port)
