"""What the routes are given: settings from the environment and the services built from them."""

from __future__ import annotations

import logging
import os
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Protocol, cast

from fastapi import Request

from tally import report
from tally.classify.base import Classifier
from tally.classify.cascade import CascadeConfig, build
from tally.engine import Decisions
from tally.model import ImportPreview, Ledger, ParsedFile
from tally.server.crypto import Keyring
from tally.server.db import LedgerRepository

log = logging.getLogger(__name__)

ReportFn = Callable[[Ledger, date | None, date | None], object]
DEFAULT_WEB_DIST = Path(__file__).resolve().parents[3] / "web" / "dist"


class Engine(Protocol):
    def preview(
        self,
        files: Sequence[Path | ParsedFile],
        ledger: Ledger,
        classifier: Classifier,
        *,
        account_for_file: Mapping[str, str] | None = None,
        withhold: Collection[str] = (),
    ) -> ImportPreview: ...

    def apply(self, ledger: Ledger, preview: ImportPreview, decisions: Decisions) -> Ledger: ...


class LibraryEngine:
    def preview(
        self,
        files: Sequence[Path | ParsedFile],
        ledger: Ledger,
        classifier: Classifier,
        *,
        account_for_file: Mapping[str, str] | None = None,
        withhold: Collection[str] = (),
    ) -> ImportPreview:
        from tally import engine

        return engine.preview(
            files, ledger, classifier, account_for_file=account_for_file, withhold=withhold
        )

    def apply(self, ledger: Ledger, preview: ImportPreview, decisions: Decisions) -> Ledger:
        from tally import engine

        return engine.apply(ledger, preview, decisions)


def rules_only_classifier(ledger: Ledger) -> Classifier:
    """The ledger's rules and nothing else: no provider, so no string leaves the process."""
    return build(CascadeConfig(), ledger.rules)


def parse_file(path: Path) -> ParsedFile:
    from tally.parsers import parse

    return parse(path)


def _month(on: date | None) -> str | None:
    return report.month_key(on) if on else None


def _sankey(ledger: Ledger, start: date | None, end: date | None) -> object:
    last = ledger.as_of or date.today()
    first = min((t.date for t in ledger.transactions), default=last)
    return report.sankey(ledger, start=start or first, end=end or last)


REPORTS: dict[str, ReportFn] = {
    "net-worth": lambda ledger, _start, _end: report.net_worth_series(ledger),
    "spend": lambda ledger, start, end: report.monthly_spend_by_category(
        ledger, start=_month(start), end=_month(end)
    ),
    "merchants": lambda ledger, start, end: report.top_merchants(ledger, start=start, end=end),
    "cash-flow": lambda ledger, start, end: report.cash_flow(
        ledger, start=_month(start), end=_month(end)
    ),
    "sankey": _sankey,
}


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default="sqlite://", repr=False)
    keyring: Keyring | None = field(default=None, repr=False)
    owners: frozenset[str] = frozenset()
    dev_login: str | None = None
    web_dist: Path | None = DEFAULT_WEB_DIST
    synthetic: bool = False
    max_upload_bytes: int = 32 * 1024 * 1024
    max_upload_files: int = 64
    # The pod's /tmp holds the spooled body and the parser's copy: keep 2x under it.
    max_request_bytes: int = 128 * 1024 * 1024
    engine: Engine = field(default_factory=LibraryEngine)
    parse: Callable[[Path], ParsedFile] = parse_file
    classifier_for: Callable[[Ledger], Classifier] = rules_only_classifier
    reports: Mapping[str, ReportFn] = field(default_factory=lambda: dict(REPORTS))

    @classmethod
    def from_env(
        cls, environ: Mapping[str, str] = os.environ, *, synthetic: bool = False
    ) -> Settings:
        synthetic = synthetic or environ.get("TALLY_SYNTHETIC", "") not in ("", "0", "false")
        url = environ.get("TALLY_DATABASE_URL") or environ.get("DATABASE_URL")
        if not url and not synthetic:
            raise ValueError("set TALLY_DATABASE_URL (or run with --synthetic)")
        keyring = (
            Keyring.from_env(environ)
            if not synthetic or "TALLY_KEYRING" in environ or "TALLY_KEYRING_FILE" in environ
            else None
        )
        dist = environ.get("TALLY_WEB_DIST")
        owners = frozenset(o.strip() for o in environ.get("TALLY_OWNERS", "").split(",")) - {""}
        return cls(
            database_url="sqlite://" if synthetic else cast(str, url),
            keyring=keyring,
            owners=owners,
            dev_login=environ.get("TALLY_DEV_LOGIN") or None,
            web_dist=Path(dist) if dist else DEFAULT_WEB_DIST,
            synthetic=synthetic,
        )


@dataclass(frozen=True)
class Services:
    settings: Settings
    repo: LedgerRepository


def services(request: Request) -> Services:
    return cast(Services, request.app.state.services)
