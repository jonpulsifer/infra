"""The `tally` CLI: one of the two shells over the engine.

Engine, parsers, report, providers and the server import inside the command
that needs them, so the CLI starts while any of them is unfinished.
"""

from __future__ import annotations

import dataclasses
import hashlib
import inspect
import json
import os
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any

import typer
from pydantic import BaseModel
from rich.console import Console
from rich.table import Table
from rich.text import Text

from tally import config
from tally.classify.base import Result
from tally.model import (
    DuplicateFinding,
    ImportPreview,
    Ledger,
    LowConfidenceFinding,
    MissingPeriodFinding,
    ParsedFile,
    Source,
    TransferFinding,
)
from tally.store import Answer, Store

if TYPE_CHECKING:
    import httpx

    from tally.classify.cascade import TallyCascade
    from tally.parsers import Parser

app = typer.Typer(no_args_is_help=True, help="A privacy-first household ledger.")
rules_app = typer.Typer(no_args_is_help=True, help="The cached classification rules.")
app.add_typer(rules_app, name="rules")
console = Console()
err = Console(stderr=True)
UNCATEGORIZED = "uncategorized"
ARCHIVES = frozenset({".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"})
_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})
_OFF = ("", "0", "false")


class ProviderChoice(StrEnum):
    none = "none"
    fake = "fake"
    openai_api = "openai_api"
    codex = "codex"


class Period(StrEnum):
    ytd = "ytd"
    last3 = "last3"
    month = "month"
    all = "all"


@app.callback()
def _main(
    ctx: typer.Context,
    config_path: Annotated[
        Path | None, typer.Option("--config", help="Settings file.", envvar="TALLY_CONFIG")
    ] = None,
) -> None:
    try:
        ctx.obj = config.load(config_path)
    except (ValueError, OSError) as exc:
        raise _fail(f"bad settings: {exc}", 2) from exc


def _settings(ctx: typer.Context) -> config.Settings:
    obj = ctx.find_root().obj
    return obj if isinstance(obj, config.Settings) else config.load()


def _fail(message: str, code: int = 1) -> typer.Exit:
    err.print(Text(message, style="red"))
    return typer.Exit(code)


def _cell(value: object) -> Text:
    match value:
        case None:
            return Text("")
        case bool():
            return Text("yes" if value else "no")
        case int():
            return Text(f"{value:,}", justify="right")
        case Decimal() | float():
            return Text(f"{value:,.2f}", justify="right")
        case date():
            return Text(value.isoformat())
        case _:
            return Text(str(value))


def _table(title: str, columns: Sequence[str], rows: Iterable[Sequence[object]]) -> Table:
    table = Table(title=title, title_justify="left", show_edge=False)
    for col in columns:
        table.add_column(col)
    for row in rows:
        table.add_row(*(_cell(v) for v in row))
    return table


def _guarded(path: Path, settings: config.Settings) -> bool:
    return config.is_excluded(path, settings.exclude) or config.is_excluded(
        path.resolve(), settings.exclude
    )


def archive(path: Path) -> bool:
    """An archive may hold anything, identity documents included, so tally never opens one."""
    return path.suffix.lower() in ARCHIVES


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# inventory


@dataclass
class _Group:
    files: int = 0
    rows: int = 0
    date_from: date | None = None
    date_to: date | None = None
    assertions: int = 0
    holdings: int = 0

    def add(self, pf: ParsedFile) -> None:
        self.files += 1
        self.rows += len(pf.rows)
        self.assertions += len(pf.assertions)
        self.holdings += len(pf.holdings)
        if pf.date_from and (self.date_from is None or pf.date_from < self.date_from):
            self.date_from = pf.date_from
        if pf.date_to and (self.date_to is None or pf.date_to > self.date_to):
            self.date_to = pf.date_to


@dataclass
class Inventory:
    root: Path
    files: int = 0
    excluded: int = 0
    hidden: int = 0
    groups: dict[tuple[str, str, str], _Group] = field(default_factory=dict)
    errors: Counter[tuple[str, str]] = field(default_factory=Counter)

    def as_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "files": self.files,
            "excluded": self.excluded,
            "hidden": self.hidden,
            "groups": [
                {
                    "institution": inst,
                    "format": fmt,
                    "family": fam,
                    **dataclasses.asdict(g),
                    "date_from": g.date_from.isoformat() if g.date_from else None,
                    "date_to": g.date_to.isoformat() if g.date_to else None,
                }
                for (inst, fmt, fam), g in sorted(self.groups.items())
            ],
            "errors": [
                {"reason": reason, "extension": ext, "files": n}
                for (reason, ext), n in sorted(self.errors.items())
            ],
        }


def walk(root: Path, settings: config.Settings) -> tuple[list[Path], int, int]:
    """Files under `root` that may be opened, plus counts of the excluded and the hidden.

    Excluded directories are pruned before descent, so nothing inside one is listed.
    """
    keep: list[Path] = []
    excluded = hidden = 0
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        for d in list(dirnames):
            if d.startswith("."):
                hidden += 1
                dirnames.remove(d)
            elif _guarded(here / d, settings):
                excluded += 1
                dirnames.remove(d)
        for name in filenames:
            path = here / name
            if name.startswith("."):
                hidden += 1
            elif _guarded(path, settings):
                excluded += 1
            else:
                keep.append(path)
    return sorted(keep), excluded, hidden


def _family(parser: Parser, pf: ParsedFile) -> str:
    module = type(parser).__module__.rsplit(".", 1)[-1]
    if module in ("builtins", "__main__"):
        module = type(parser).__name__
    return f"{module}:{pf.profile_id}" if pf.profile_id else module


def _sniff(path: Path, registry: Sequence[Parser]) -> tuple[str, ParsedFile] | str:
    """The claiming family and its parse, or the reason class of the failure."""
    with path.open("rb") as fh:
        head = fh.read(4096)
    for parser in registry:
        if not parser.sniff(path, head):
            continue
        try:
            pf = parser.parse(path)
        except Exception as exc:
            return type(exc).__name__
        return _family(parser, pf), pf
    return "unclaimed"


def take_inventory(root: Path, settings: config.Settings) -> Inventory:
    from tally import parsers

    registry = parsers.parsers()
    paths, excluded, hidden = walk(root, settings)
    inv = Inventory(root=root, files=len(paths), excluded=excluded, hidden=hidden)
    for path in paths:
        got = "archive" if archive(path) else _sniff(path, registry)
        if isinstance(got, str):
            inv.errors[(got, path.suffix.lower() or "(none)")] += 1
            continue
        family, pf = got
        key = (pf.institution or "unknown", pf.format, family)
        inv.groups.setdefault(key, _Group()).add(pf)
    return inv


def _range(a: date | None, b: date | None) -> str:
    return f"{a.isoformat() if a else '?'} to {b.isoformat() if b else '?'}" if a or b else ""


@app.command()
def inventory(
    ctx: typer.Context,
    root: Annotated[Path | None, typer.Argument(help="Defaults to the import root.")] = None,
    as_json: Annotated[bool, typer.Option("--json", help="Machine-readable output.")] = False,
) -> None:
    """Sniff every file under ROOT and print shapes: counts, formats, ranges. Never a value."""
    settings = _settings(ctx)
    root = (root or settings.import_root).expanduser()
    if not root.is_dir():
        raise _fail(f"{root} is not a directory", 2)
    inv = take_inventory(root, settings)
    if as_json:
        typer.echo(json.dumps(inv.as_json(), indent=2))
        return
    console.print(
        Text(f"{inv.files} files read, {inv.excluded} excluded, {inv.hidden} hidden, under {root}")
    )
    console.print(
        _table(
            "Sources",
            ("institution", "format", "parser", "files", "rows", "dates", "assertions", "holdings"),
            (
                (
                    inst,
                    fmt,
                    fam,
                    g.files,
                    g.rows,
                    _range(g.date_from, g.date_to),
                    g.assertions,
                    g.holdings,
                )
                for (inst, fmt, fam), g in sorted(inv.groups.items())
            ),
        )
    )
    if inv.errors:
        console.print(
            _table(
                "Not parsed",
                ("reason", "extension", "files"),
                ((r, e, n) for (r, e), n in sorted(inv.errors.items())),
            )
        )


# preview


def withheld_results(parsed: Sequence[ParsedFile], held: frozenset[str]) -> list[Result]:
    """Answers for withheld descriptors, so the cascade's memory stops them before a provider.

    They land uncategorised at confidence 0, which raises a low-confidence finding.
    """
    found = {r.descriptor for pf in parsed for r in pf.rows if r.descriptor.casefold() in held}
    return [Result(d, UNCATEGORIZED, d, 0.0, Source.manual, "withhold") for d in sorted(found)]


def build_cascade(
    choice: ProviderChoice,
    settings: config.Settings,
    store: Store,
    ledger: Ledger,
    *,
    dry_run: bool,
    withheld: Sequence[Result] = (),
) -> TallyCascade:
    from tally.classify import cascade as cc
    from tally.classify.providers import ProviderUnavailableError

    cfg = cc.CascadeConfig(
        provider=choice.value,
        threshold=settings.threshold,
        model=settings.model,
        dry_run=dry_run,
        api_key=os.environ.get("TALLY_OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY"),
        codex_home=settings.codex_home,
    )
    rules = list({r.id: r for r in (*ledger.rules, *store.rules())}.values())
    remembered = [*store.remembered(), *withheld]
    try:
        return cc.build(cfg, rules, remembered=remembered)
    except ProviderUnavailableError as exc:
        err.print(Text(f"{choice.value} is unavailable ({exc}); no model is asked", style="yellow"))
        return cc.build(dataclasses.replace(cfg, provider="none"), rules, remembered=remembered)


def load_ledger(path: Path | None, synthetic: bool, store: Store) -> Ledger:
    if path is not None and synthetic:
        raise _fail("pass --ledger or --synthetic, not both", 2)
    if synthetic:
        try:
            from tally.synthetic import PREVIEW_FROM, build_ledger
        except ImportError as exc:
            raise _fail("tally.synthetic is not built yet") from exc
        led: Ledger = build_ledger(before=PREVIEW_FROM)
        return led
    if path is not None:
        led = Ledger.model_validate_json(path.read_text())
        store.save_snapshot(led)
        return led
    if (snap := store.snapshot()) is not None:
        return snap
    raise _fail("no ledger: pass --ledger PATH or --synthetic", 2)


def parse_files(
    files: Sequence[Path], settings: config.Settings
) -> tuple[list[ParsedFile], list[tuple[str, str]]]:
    from tally import parsers

    parsed: list[ParsedFile] = []
    failed: list[tuple[str, str]] = []
    for path in files:
        if _guarded(path, settings):
            failed.append((path.name, "excluded"))
            continue
        if archive(path):
            failed.append((path.name, "an archive: unpack it first"))
            continue
        try:
            parsed.append(parsers.parse(path))
        except parsers.ParseError as exc:
            failed.append((path.name, str(exc)))
        except Exception as exc:
            failed.append((path.name, type(exc).__name__))
    return parsed, failed


def remember(store: Store, cascade: TallyCascade) -> None:
    """Persist what this run bought: every batch that left, and every model answer."""
    for batch in cascade.audit.batches:
        store.record_outbound(batch.provider, batch.model, batch.strings)
    provider = cascade.provider.name if cascade.provider is not None else "none"
    store.put_answers(
        Answer.of(r, provider) for r in cascade.answers().values() if r.source is Source.model
    )


def _print_preview(
    result: ImportPreview,
    failed: Sequence[tuple[str, str]],
    ledger: Ledger,
    *,
    withheld: frozenset[str],
    live: bool,
) -> None:
    console.print(
        _table(
            "Files",
            ("file", "format", "institution", "account", "rows", "dates", "needs account"),
            (
                (
                    f.name,
                    f.format,
                    f.institution,
                    f.account_id,
                    f.rows,
                    _range(f.date_from, f.date_to),
                    f.needs_account,
                )
                for f in result.files
            ),
        )
    )
    if failed:
        console.print(_table("Not read", ("file", "reason"), failed))
    dupes = Counter(f.tier for f in result.findings if isinstance(f, DuplicateFinding))
    transfers = [f for f in result.findings if isinstance(f, TransferFinding)]
    missing = [f for f in result.findings if isinstance(f, MissingPeriodFinding)]
    low = [f for f in result.findings if isinstance(f, LowConfidenceFinding)]
    auto = sum(f.auto for f in transfers)
    console.print(
        _table(
            "Summary",
            ("", "count"),
            (
                ("new rows", len(result.new_transactions)),
                ("duplicates by FITID", dupes["fitid"]),
                ("duplicates by fuzzy match", dupes["fuzzy"]),
                ("transfers accepted", auto),
                ("transfers to confirm", len(transfers) - auto),
                ("missing periods", len(missing)),
                ("low confidence", len(low)),
                ("rules hit", result.rules_hit),
                ("model calls", result.model_calls),
                ("balance assertions", len(result.assertions)),
                ("holdings snapshots", len(result.holdings)),
            ),
        )
    )
    if missing:
        console.print(
            _table(
                "Missing periods",
                ("account", "from", "to", "expected", "actual", "difference"),
                (
                    (
                        m.account_id,
                        m.date_from,
                        m.date_to,
                        m.expected_balance,
                        m.actual_balance,
                        m.actual_balance - m.expected_balance,
                    )
                    for m in missing
                ),
            )
        )
    if low:
        txs = {t.id: t for t in result.new_transactions}
        names = {c.id: c.name for c in ledger.categories}
        console.print(
            _table(
                "Low confidence",
                ("descriptor", "suggested", "confidence"),
                (
                    (
                        txs[f.transaction_id].descriptor if f.transaction_id in txs else f.id,
                        names.get(f.suggested_category_id, f.suggested_category_id),
                        f"{f.confidence:.2f}",
                    )
                    for f in low
                ),
            )
        )
    _print_outbound(result.outbound_strings, withheld, live=live)


def _print_outbound(strings: Sequence[str], withheld: frozenset[str], *, live: bool) -> None:
    leaked = [s for s in strings if s.casefold() in withheld]
    if leaked:
        warning = f"{len(leaked)} withheld strings are in the outbound list"
        err.print(Text(warning, style="bold red"))
    if not strings:
        console.print(Text("No string leaves the lab."))
    else:
        verb = "were sent" if live else "would leave the lab"
        console.print(Text(f"{len(strings)} strings {verb}:", style="bold"))
        for s in strings:
            console.print(Text(s), soft_wrap=True)
    if withheld:
        console.print(Text(f"{len(withheld)} strings withheld."))


@app.command()
def preview(
    ctx: typer.Context,
    files: Annotated[list[Path], typer.Argument(exists=True, dir_okay=False)],
    ledger: Annotated[Path | None, typer.Option(help="A ledger JSON file.", exists=True)] = None,
    synthetic: Annotated[bool, typer.Option(help="Preview against the synthetic ledger.")] = False,
    provider: Annotated[ProviderChoice | None, typer.Option(help="Model provider.")] = None,
    dry_run: Annotated[bool, typer.Option(help="Ask no model; list what would go.")] = False,
    withhold: Annotated[
        list[str] | None, typer.Option(help="A descriptor that must not leave the lab.")
    ] = None,
) -> None:
    """Parse, dedupe, pair transfers, check balances and classify; commit nothing.

    Exits 0 whatever the findings: they are information.
    """
    from tally import engine
    from tally.classify.providers import ProviderError

    settings = _settings(ctx)
    choice = provider or ProviderChoice(settings.provider)
    held = frozenset(w.casefold() for w in withhold or ())
    with Store.open(settings.db_path) as store:
        led = load_ledger(ledger, synthetic, store)
        parsed, failed = parse_files(files, settings)
        withheld = withheld_results(parsed, held)
        cascade = build_cascade(choice, settings, store, led, dry_run=dry_run, withheld=withheld)
        try:
            result = engine.preview(
                parsed,
                led,
                cascade,
                dedupe_window_days=settings.dedupe_window_days,
                transfer_window_days=settings.transfer_window_days,
                threshold=settings.threshold,
                withhold=frozenset(r.descriptor for r in withheld),
            )
        except ModuleNotFoundError as exc:
            raise _fail(f"the engine is not built yet ({exc.name} is missing)") from exc
        except ProviderError as exc:
            remember(store, cascade)
            raise _fail(f"the provider failed: {exc}") from exc
        for pf in parsed:
            store.mark_file(pf.sha256, "previewed")
        remember(store, cascade)
    live = cascade.provider is not None and not dry_run
    _print_preview(result, failed, led, withheld=held, live=live)


# push


def _transport() -> httpx.BaseTransport | None:
    """The HTTP transport for `push`. Tests replace it with a mock."""
    return None


@app.command()
def push(
    ctx: typer.Context,
    files: Annotated[list[Path], typer.Argument(exists=True, dir_okay=False)],
    force: Annotated[bool, typer.Option(help="Push files already pushed.")] = False,
) -> None:
    """Upload FILES to the server's import preview and print where to review it."""
    import httpx

    settings = _settings(ctx)
    token = settings.token()
    if not token:
        raise _fail("no server token: set TALLY_TOKEN or token_command", 2)
    with Store.open(settings.db_path) as store:
        send: list[tuple[Path, str]] = []
        for path in files:
            if _guarded(path, settings) or archive(path):
                raise _fail(f"{path.name} is excluded and is never sent", 2)
            sha = _sha256(path)
            if store.seen(sha, "pushed") and not force:
                console.print(Text(f"{path.name}: already pushed, skipped", style="dim"))
                continue
            send.append((path, sha))
        if not send:
            console.print(Text("Nothing to push."))
            return
        uploads = [("files", (p.name, p.read_bytes(), "application/octet-stream")) for p, _ in send]
        try:
            with httpx.Client(
                base_url=settings.server_url, transport=_transport(), timeout=120.0
            ) as client:
                resp = client.post(
                    "/api/import/preview",
                    files=uploads,
                    headers={"Authorization": f"Bearer {token}"},
                )
                resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise _fail(f"the server refused the push: HTTP {exc.response.status_code}") from exc
        except httpx.TransportError as exc:
            raise _fail(f"the server at {settings.server_url} is unreachable") from exc
        body = resp.json()
        pid = str(body.get("id") or body.get("preview_id") or "")
        url = body.get("url") or f"{settings.server_url.rstrip('/')}/import/{pid}"
        for _, sha in send:
            store.mark_file(sha, "pushed", pid)
    console.print(Text(f"{len(send)} files pushed. Preview {pid}"))
    console.print(Text(str(url)))


# report


def _window(ledger: Ledger, period: Period) -> tuple[date, date] | None:
    end = ledger.as_of
    if end is None:
        return None
    match period:
        case Period.ytd:
            start = date(end.year, 1, 1)
        case Period.month:
            start = end.replace(day=1)
        case Period.last3:
            months = end.year * 12 + end.month - 1 - 2
            start = date(months // 12, months % 12 + 1, 1)
        case Period.all:
            start = min(t.date for t in ledger.transactions)
    return start, end


def _plain(obj: object) -> object:
    if isinstance(obj, BaseModel):
        return obj.model_dump()
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return dataclasses.asdict(obj)
    return obj


def records(obj: object) -> list[dict[str, object]]:
    """Rows for a table from whatever an aggregate returns: models, dataclasses, maps, lists."""
    obj = _plain(obj)
    if isinstance(obj, list | tuple):
        return [r for item in obj for r in _flat_row(_plain(item))]
    if isinstance(obj, Mapping):
        for key in ("rows", "links", "points"):
            if isinstance(obj.get(key), list | tuple):
                return records(obj[key])
        lists = [v for v in obj.values() if isinstance(v, list | tuple)]
        if lists:
            return records(lists[0])
        return _flat_row(obj)
    return [{"value": obj}]


def _flat_row(obj: object) -> list[dict[str, object]]:
    if not isinstance(obj, Mapping):
        return [{"value": obj}]
    row: dict[str, object] = {}
    for k, v in obj.items():
        v = _plain(v)
        if isinstance(v, Mapping):
            row.update({f"{k}.{ik}": iv for ik, iv in v.items()})
        else:
            row[str(k)] = v
    return [row]


_START_NAMES = frozenset({"start", "since", "begin", "from_", "frm", "date_from", "start_date"})
_END_NAMES = frozenset({"end", "until", "to", "to_", "date_to", "end_date"})


def _bound(p: inspect.Parameter, on: date) -> object:
    hint = str(p.annotation)
    return on.isoformat()[:7] if "str" in hint and "date" not in hint else on


def _call(fn: Any, ledger: Ledger, start: date, end: date) -> object:
    """Call an aggregate on an already-scoped ledger, filling only the window it requires.

    A month-keyed parameter (annotated str) gets YYYY-MM, anything else a date.
    """
    params = list(inspect.signature(fn).parameters.values())[1:]
    kwargs: dict[str, object] = {}
    for p in params:
        if p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD) or p.default is not p.empty:
            continue
        if p.name in _START_NAMES:
            kwargs[p.name] = _bound(p, start)
        elif p.name in _END_NAMES:
            kwargs[p.name] = _bound(p, end)
        else:
            raise TypeError(f"cannot fill {p.name}")
    return fn(ledger, **kwargs)


REPORT_SECTIONS: tuple[tuple[str, str], ...] = (
    ("Net worth", "net_worth_series"),
    ("Spend by category", "monthly_spend_by_category"),
    ("Top merchants", "top_merchants"),
    ("Cash flow", "cash_flow"),
    ("Where the money went", "sankey"),
)


def _in_window(row: Mapping[str, object], start: date, end: date) -> bool:
    month = row.get("month")
    if not isinstance(month, str):
        return True
    return start.isoformat()[:7] <= month <= end.isoformat()[:7]


@app.command()
def report(
    ctx: typer.Context,
    ledger: Annotated[Path | None, typer.Option(help="A ledger JSON file.", exists=True)] = None,
    synthetic: Annotated[bool, typer.Option(help="Report on the synthetic ledger.")] = False,
    period: Annotated[Period, typer.Option(help="The window.")] = Period.ytd,
) -> None:
    """The five dashboard numbers as tables."""
    try:
        from tally import report as agg
    except ImportError as exc:
        raise _fail("tally.report is not built yet") from exc
    settings = _settings(ctx)
    with Store.open(settings.db_path) as store:
        led = load_ledger(ledger, synthetic, store)
    window = _window(led, period)
    if window is None:
        console.print(Text("The ledger has no transactions."))
        return
    start, end = window
    scoped = led.model_copy(
        update={"transactions": tuple(t for t in led.transactions if start <= t.date <= end)}
    )
    console.print(Text(f"{period.value}: {start.isoformat()} to {end.isoformat()}", style="bold"))
    for title, name in REPORT_SECTIONS:
        fn = getattr(agg, name, None)
        if fn is None:
            console.print(Text(f"{title}: tally.report.{name} is missing", style="dim"))
            continue
        full = name == "net_worth_series"
        try:
            rows = records(_call(fn, led if full else scoped, start, end))
        except TypeError as exc:
            console.print(Text(f"{title}: {exc}", style="dim"))
            continue
        rows = [r for r in rows if _in_window(r, start, end)] if full else rows
        cols = list(dict.fromkeys(k for r in rows for k in r))
        console.print(_table(title, cols, ([r.get(c) for c in cols] for r in rows)))


# rules


@rules_app.command("list")
def rules_list(ctx: typer.Context) -> None:
    """The rules and cached answers in the local store."""
    settings = _settings(ctx)
    with Store.open(settings.db_path) as store:
        rules = store.rules()
        answers = store.answers()
    console.print(
        _table(
            f"{len(rules)} rules",
            ("id", "match", "category", "merchant", "from", "account", "hits"),
            (
                (r.id, r.match, r.category_id, r.merchant, r.created_from, r.account_id, r.hits)
                for r in rules
            ),
        )
    )
    console.print(Text(f"{len(answers)} cached model answers."))


def ynab_pairs(path: Path) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """(payee, category id) per categorised register row, and the (group, category) pairs seen."""
    from tally.classify.taxonomy import ynab_category_id
    from tally.parsers import csv_

    imp = csv_.read(path)
    pairs: list[tuple[str, str]] = []
    groups: list[tuple[str, str]] = []
    for row, tags in zip(imp.file.rows, imp.tags, strict=True):
        for tag in tags:
            prefix, _, value = tag.partition(":")
            group, slash, name = value.partition("/")
            if prefix != "ynab" or not slash:
                continue
            groups.append((group, name))
            if (cid := ynab_category_id(group, name)) is not None:
                pairs.append((row.descriptor, cid))
    return pairs, groups


@rules_app.command("seed-ynab")
def rules_seed_ynab(
    ctx: typer.Context,
    register: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
) -> None:
    """Seed rules from a YNAB register export. Prints counts only."""
    from tally.classify.rules import seed_from_ynab
    from tally.classify.taxonomy import from_ynab
    from tally.parsers import ParseError

    settings = _settings(ctx)
    if _guarded(register, settings):
        raise _fail(f"{register.name} is excluded and is never opened", 2)
    try:
        pairs, groups = ynab_pairs(register)
    except ParseError as exc:
        raise _fail(f"not a register tally can read: {exc}", 2) from exc
    rules = seed_from_ynab(pairs)
    extra = from_ynab(groups)
    with Store.open(settings.db_path) as store:
        store.put_rules(rules)
        total = len(store.rules())
    console.print(
        Text(
            f"{len(pairs)} categorised rows, {len(rules)} rules seeded, "
            f"{len(extra)} categories beyond the seed taxonomy, {total} rules stored."
        )
    )


@rules_app.command("export")
def rules_export(
    ctx: typer.Context,
    out: Annotated[Path | None, typer.Option(help="Write here instead of stdout.")] = None,
) -> None:
    """Rules and cached answers as JSON."""
    settings = _settings(ctx)
    with Store.open(settings.db_path) as store:
        body = {
            "rules": [r.model_dump(mode="json") for r in store.rules()],
            "answers": [
                {**dataclasses.asdict(a), "answered_at": a.answered_at.isoformat()}
                for a in store.answers().values()
            ],
        }
    text = json.dumps(body, indent=2)
    if out is None:
        typer.echo(text)
    else:
        out.write_text(text + "\n")
        console.print(Text(f"{len(body['rules'])} rules written to {out}"))


# serve


@app.command()
def serve(
    synthetic: Annotated[bool, typer.Option(help="Serve the synthetic ledger.")] = False,
    host: Annotated[str, typer.Option(help="Bind address.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port.")] = 8081,
) -> None:
    """Run the API server.

    A dev login (TALLY_DEV_LOGIN, or the synthetic ledger's owner) answers every
    request that has no tailnet identity, so it binds only to loopback unless
    TALLY_ALLOW_DEV_LOGIN=1 says otherwise.
    """
    try:
        from tally.server.app import create_app
    except ImportError as exc:
        raise _fail("tally.server is not built yet; nothing to serve") from exc
    import uvicorn

    env = os.environ
    dev = (
        synthetic or bool(env.get("TALLY_DEV_LOGIN")) or env.get("TALLY_SYNTHETIC", "") not in _OFF
    )
    if dev and host not in _LOOPBACK and env.get("TALLY_ALLOW_DEV_LOGIN") != "1":
        raise _fail(
            "a dev login trusts every request without a tailnet identity; bind 127.0.0.1 "
            "or set TALLY_ALLOW_DEV_LOGIN=1",
            2,
        )
    if synthetic:
        os.environ["TALLY_SYNTHETIC"] = "1"
    takes = inspect.signature(create_app).parameters
    server = create_app(synthetic=True) if synthetic and "synthetic" in takes else create_app()
    uvicorn.run(server, host=host, port=port)
