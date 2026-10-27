"""`tally load`: everything under a directory into the ledger, once, with the disagreements shown.

The run is a pipeline of pure steps over one `Plan`:

1. `collect` walks the directory under the identity exclusions, opens each
   zip one level deep, and parses every file locally. What cannot be read is
   kept as a `Skipped` with its reason.
2. `batches` orders the sources: a YNAB register first (it carries the
   owner's categories and names the accounts), then files with rows by date,
   then holdings and balance statements. Files of one shape go together.
3. `choose_accounts` decides which ledger account each file's rows belong
   to. A file that resolves to an account the ledger lacks is tried against
   every existing account: the one whose rows the file's rows already match
   (the overlap) wins when the match is clear. A decision is remembered in
   the local store, so the next statement of the same card lands in the same
   account without an overlap. What stays unclear is reported, never guessed.
4. Each batch is previewed and applied through a `Target`, the server or a
   local copy for a dry run. A fuzzy duplicate is dropped: an overlapping
   export of an account the ledger holds adds nothing.
5. `Report` says what happened and highlights what disagrees: balances the
   institutions asserted that the ledger does not sum to, files that need an
   account, rows that could not be read, and rows nobody categorised.

Running it again changes nothing: a file already applied is skipped by its
hash, and a row already held keeps its id and is never drafted twice.
"""

from __future__ import annotations

import json
import tempfile
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from tally import config, files, parsers
from tally.classify.base import Classifier
from tally.classify.cascade import CascadeConfig, build
from tally.engine import Decisions
from tally.engine_impl import LADDERED, UNASSIGNED, minted_account_id, placeholder
from tally.model import (
    Account,
    AccountKind,
    DuplicateFinding,
    ImportPreview,
    Ledger,
    LowConfidenceFinding,
    MissingPeriodFinding,
    ParsedFile,
    TransferFinding,
)
from tally.store import Store

REGISTER = "ynab-register"
MATCH_SHARE = 0.5
BATCH_LIMIT = 64
UNCATEGORIZED = "uncategorized"


@dataclass(frozen=True)
class Source:
    path: Path
    shown: str
    parsed: ParsedFile

    @property
    def key(self) -> str:
        """What a mapping decision is remembered under: the institution and the file's hint."""
        pf = self.parsed
        hint = pf.account_hint or pf.profile_id or pf.account_kind_hint or "file"
        return f"{pf.institution or 'unknown'}:{hint}"


@dataclass(frozen=True)
class Skipped:
    name: str
    reason: str


@dataclass(frozen=True)
class Collected:
    sources: tuple[Source, ...]
    skipped: tuple[Skipped, ...]
    excluded: int
    hidden: int


def collect(root: Path, settings: config.Settings, scratch: Path) -> Collected:
    """Every readable file under `root`, parsed, with zip members written under `scratch`."""
    paths, excluded, hidden = files.walk(root, settings)
    sources: list[Source] = []
    skipped: list[Skipped] = []
    for path in paths:
        if path.suffix.lower() == ".zip":
            for member in files.unpack(path, settings, scratch):
                if member.path is None:
                    skipped.append(Skipped(member.shown, member.reason or "not opened"))
                else:
                    _parse_into(member.path, member.shown, sources, skipped)
        elif files.is_archive(path):
            skipped.append(Skipped(path.name, "an archive tally does not open"))
        else:
            _parse_into(path, path.name, sources, skipped)
    return Collected(tuple(sources), tuple(skipped), excluded, hidden)


def _parse_into(path: Path, shown: str, sources: list[Source], skipped: list[Skipped]) -> None:
    try:
        pf = parsers.parse(path)
    except parsers.ParseError as exc:
        skipped.append(Skipped(shown, _reason(str(exc), path.name)))
        return
    except Exception as exc:
        skipped.append(Skipped(shown, type(exc).__name__))
        return
    sources.append(Source(path, shown, pf.model_copy(update={"name": shown})))


def _reason(message: str, name: str) -> str:
    """A parser's reason without the file name it opens with."""
    return message.removeprefix(f"{name}: ")


def _rank(s: Source) -> tuple[int, date, str]:
    pf = s.parsed
    tier = 0 if pf.profile_id == REGISTER else 1 if pf.rows else 2
    return (tier, pf.date_from or date.max, s.shown)


def _shape(s: Source) -> tuple[Any, ...]:
    pf = s.parsed
    return (
        pf.profile_id == REGISTER,
        pf.institution,
        pf.format,
        pf.profile_id,
        pf.account_kind_hint,
    )


def batches(sources: Iterable[Source]) -> list[list[Source]]:
    """Sources in load order, grouped by shape, at most BATCH_LIMIT to a batch."""
    out: list[list[Source]] = []
    for s in sorted(sources, key=_rank):
        if out and _shape(out[-1][-1]) == _shape(s) and len(out[-1]) < BATCH_LIMIT:
            out[-1].append(s)
        else:
            out.append([s])
    return out


# accounts


@dataclass(frozen=True)
class Unclear:
    """A file whose account could not be decided, with the accounts it might belong to."""

    shown: str
    reason: str
    candidates: tuple[str, ...] = ()


@dataclass(frozen=True)
class Chosen:
    chosen: dict[str, str]
    decided: dict[str, str]
    unclear: list[Unclear]


def own_account(s: Source, known: Mapping[str, Account]) -> str | None:
    """The account the engine would give the file's rows with no decision, or None if mixed."""
    pf = s.parsed
    hints = {r.account_hint for r in pf.rows if r.account_hint}
    if len(hints) > 1:
        return None
    if pf.account_hint:
        return (
            pf.account_hint
            if pf.account_hint in known
            else minted_account_id(pf.institution, pf.account_hint)
        )
    return placeholder(pf.name)


def overlap(s: Source, account: Account, ledger: Ledger, window_days: int) -> float:
    """The share of the file's rows the ledger already holds under `account`."""
    from tally.reconcile.dedupe import dedupe

    rows = [r.model_copy(update={"account_hint": account.id}) for r in s.parsed.rows]
    if not rows:
        return 0.0
    held = [t for t in ledger.transactions if t.account_id == account.id]
    if not held:
        return 0.0
    found = dedupe(held, rows, window_days=window_days)
    return len(found.findings) / len(rows)


def choose_accounts(
    batch: Sequence[Source],
    ledger: Ledger,
    *,
    remembered: Mapping[str, str],
    overrides: Mapping[str, str],
    window_days: int,
) -> Chosen:
    """`account_for_file` for the batch: overrides, then memory, then overlap, then a lone fit."""
    known = {a.id: a for a in ledger.accounts}
    chosen: dict[str, str] = {}
    decided: dict[str, str] = {}
    unclear: list[Unclear] = []
    for s in batch:
        if (forced := overrides.get(s.shown)) is not None:
            if forced not in known:
                unclear.append(Unclear(s.shown, f"no account {forced}", tuple(known)))
                continue
            chosen[s.shown] = decided[s.key] = forced
            continue
        own = own_account(s, known)
        if own is None or own in known:
            continue
        if (kept := remembered.get(s.key)) in known and kept is not None:
            chosen[s.shown] = kept
            continue
        if s.parsed.rows:
            scores = {a.id: overlap(s, a, ledger, window_days) for a in known.values()}
            best = sorted(scores.items(), key=lambda kv: -kv[1])
            clear = [aid for aid, share in best if share >= MATCH_SHARE]
            if len(clear) == 1:
                chosen[s.shown] = decided[s.key] = clear[0]
                continue
            if len(clear) > 1:
                unclear.append(
                    Unclear(s.shown, "its rows match more than one account", tuple(clear))
                )
                continue
        if own.startswith(UNASSIGNED):
            fits = [
                a.id
                for a in known.values()
                if a.institution == (s.parsed.institution or a.institution)
                and (s.parsed.account_kind_hint is None or a.kind == s.parsed.account_kind_hint)
            ]
            if len(fits) == 1:
                chosen[s.shown] = decided[s.key] = fits[0]
            else:
                unclear.append(Unclear(s.shown, "needs an account", tuple(fits)))
    return Chosen(chosen, decided, unclear)


# targets


class Target(Protocol):
    """Where a batch goes: the server, or a local copy of the ledger for a dry run."""

    def ledger(self) -> Ledger: ...

    def preview(
        self, batch: Sequence[Source], account_for_file: Mapping[str, str]
    ) -> ImportPreview: ...

    def apply(self, preview: ImportPreview, decisions: Decisions) -> int:
        """Apply and return how many rows were added."""
        ...


def rules_only(ledger: Ledger) -> Classifier:
    return build(CascadeConfig(), ledger.rules)


class Local:
    """A dry run: the engine against a copy of the ledger, applied in memory, nothing sent."""

    def __init__(
        self, ledger: Ledger, *, dedupe_window_days: int, transfer_window_days: int
    ) -> None:
        self._ledger = ledger
        self._dedupe = dedupe_window_days
        self._transfers = transfer_window_days
        self._last: ImportPreview | None = None

    def ledger(self) -> Ledger:
        return self._ledger

    def preview(
        self, batch: Sequence[Source], account_for_file: Mapping[str, str]
    ) -> ImportPreview:
        from tally import engine

        self._last = engine.preview(
            [s.parsed for s in batch],
            self._ledger,
            rules_only(self._ledger),
            dedupe_window_days=self._dedupe,
            transfer_window_days=self._transfers,
            account_for_file=account_for_file,
        )
        return self._last

    def apply(self, preview: ImportPreview, decisions: Decisions) -> int:
        from tally import engine

        before = {t.id for t in self._ledger.transactions}
        self._ledger = engine.apply(self._ledger, preview, decisions)
        return sum(1 for t in self._ledger.transactions if t.id not in before)


class Remote:
    """The server's import routes over an httpx client that already authenticates."""

    def __init__(self, http: Any) -> None:
        self.http = http
        self._ids: dict[int, str] = {}

    def ledger(self) -> Ledger:
        resp = self.http.get("/api/ledger")
        resp.raise_for_status()
        return ledger_from_wire(resp.json())

    def preview(
        self, batch: Sequence[Source], account_for_file: Mapping[str, str]
    ) -> ImportPreview:
        uploads = [
            ("files", (s.shown, s.path.read_bytes(), "application/octet-stream")) for s in batch
        ]
        resp = self.http.post(
            "/api/import/preview",
            files=uploads,
            data={"account_for_file": json.dumps(dict(account_for_file))},
        )
        resp.raise_for_status()
        body = resp.json()
        preview = preview_from_wire(body["preview"])
        self._ids[id(preview)] = body["id"]
        return preview

    def apply(self, preview: ImportPreview, decisions: Decisions) -> int:
        pid = self._ids.pop(id(preview))
        body = {
            "acceptFindings": sorted(decisions.accept_findings),
            "dismissFindings": sorted(decisions.dismiss_findings),
            "accountForFile": dict(decisions.account_for_file),
        }
        resp = self.http.post(f"/api/import/preview/{pid}/apply", json=body)
        resp.raise_for_status()
        return int(resp.json()["added"])


def ledger_from_wire(body: Mapping[str, Any]) -> Ledger:
    from tally.server import schemas

    out = schemas.LedgerOut.model_validate(body)
    return Ledger.model_validate(out.model_dump(exclude={"owner", "viewers", "as_of"}))


def preview_from_wire(body: Mapping[str, Any]) -> ImportPreview:
    from tally.server import schemas

    out = schemas.ImportPreviewOut.model_validate(body)
    return ImportPreview.model_validate(out.model_dump())


# the run


@dataclass
class BatchResult:
    files: int
    rows: int
    held: int
    new: int
    added: int
    dropped: int
    unmatched_in_overlap: int
    transfers_auto: int
    transfers_open: int
    uncategorised: int
    assertions: int
    holdings: int
    shape: str


@dataclass
class Report:
    root: Path
    dry_run: bool
    excluded: int = 0
    hidden: int = 0
    already: int = 0
    batches: list[BatchResult] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)
    unclear: list[Unclear] = field(default_factory=list)
    accounts: dict[str, str] = field(default_factory=dict)
    gaps: list[MissingPeriodFinding] = field(default_factory=list)
    uncategorised: int = 0
    transactions: int = 0
    ledger_accounts: dict[str, str] = field(default_factory=dict)

    @property
    def added(self) -> int:
        return sum(b.added for b in self.batches)

    @property
    def discrepancies(self) -> int:
        return len(self.gaps) + len(self.unclear) + len(self.skipped)

    def as_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "dryRun": self.dry_run,
            "added": self.added,
            "already": self.already,
            "batches": [b.__dict__ for b in self.batches],
            "skipped": [s.__dict__ for s in self.skipped],
            "unclear": [u.__dict__ for u in self.unclear],
            "accounts": self.accounts,
            "gaps": [g.model_dump(mode="json") for g in self.gaps],
            "uncategorised": self.uncategorised,
            "transactions": self.transactions,
        }


def decide(preview: ImportPreview) -> Decisions:
    """Drop every fuzzy duplicate; keep an incoming row that posts a pending one."""
    accept = frozenset(
        f.id
        for f in preview.findings
        if isinstance(f, DuplicateFinding)
        and f.tier == "fuzzy"
        and not f.reason.startswith("replaces pending")
    )
    return Decisions(accept_findings=accept)


def _unmatched_in_overlap(preview: ImportPreview, ledger: Ledger, chosen: Mapping[str, str]) -> int:
    """New rows dated inside a span the chosen account already covers from another source."""
    spans: dict[str, tuple[date, date]] = {}
    for t in ledger.transactions:
        lo, hi = spans.get(t.account_id, (t.date, t.date))
        spans[t.account_id] = (min(lo, t.date), max(hi, t.date))
    dropped = {f.transaction_id for f in preview.findings if isinstance(f, DuplicateFinding)}
    count = 0
    for t in preview.new_transactions:
        span = spans.get(t.account_id)
        if span and t.id not in dropped and span[0] <= t.date <= span[1]:
            count += 1
    return count


def _summarise(
    batch: Sequence[Source],
    preview: ImportPreview,
    ledger: Ledger,
    chosen: Mapping[str, str],
    added: int,
) -> BatchResult:
    dups = [f for f in preview.findings if isinstance(f, DuplicateFinding)]
    transfers = [f for f in preview.findings if isinstance(f, TransferFinding)]
    low = [f for f in preview.findings if isinstance(f, LowConfidenceFinding)]
    first = batch[0].parsed
    shape = " ".join(
        p
        for p in (first.institution, first.format, first.profile_id or first.account_kind_hint)
        if p
    )
    rows = sum(len(s.parsed.rows) for s in batch)
    return BatchResult(
        files=len(batch),
        rows=rows,
        held=rows - len(preview.new_transactions),
        new=len(preview.new_transactions),
        added=added,
        dropped=len(dups),
        unmatched_in_overlap=_unmatched_in_overlap(preview, ledger, chosen),
        transfers_auto=sum(f.auto for f in transfers),
        transfers_open=sum(not f.auto for f in transfers),
        uncategorised=len(low),
        assertions=len(preview.assertions),
        holdings=len(preview.holdings),
        shape=shape,
    )


def balance_gaps(ledger: Ledger) -> list[MissingPeriodFinding]:
    """Every asserted balance the ledger does not sum to, over the whole ledger."""
    from tally.reconcile.balances import check

    kinds = {a.id: a.kind for a in ledger.accounts}
    laddered = [a for a in ledger.assertions if kinds.get(a.account_id) in (*LADDERED, None)]
    return check(ledger.transactions, laddered)


def run(
    root: Path,
    settings: config.Settings,
    target: Target,
    store: Store,
    *,
    dry_run: bool,
    force: bool = False,
    overrides: Mapping[str, str] | None = None,
    say: Callable[[str], None] = lambda _: None,
) -> Report:
    report = Report(root=root, dry_run=dry_run)
    with tempfile.TemporaryDirectory(prefix="tally-load-") as tmp:
        found = collect(root, settings, Path(tmp))
        report.excluded, report.hidden = found.excluded, found.hidden
        report.skipped.extend(found.skipped)
        fresh: list[Source] = []
        for s in found.sources:
            if not force and not dry_run and store.seen(s.parsed.sha256, "pushed"):
                report.already += 1
            else:
                fresh.append(s)
        n, k, had = len(found.sources), len(found.skipped), report.already
        say(f"{n} files read, {k} not read, {had} already loaded")
        remembered = store.account_map()
        for batch in batches(fresh):
            ledger = target.ledger()
            mapping = choose_accounts(
                batch,
                ledger,
                remembered=remembered,
                overrides=overrides or {},
                window_days=settings.dedupe_window_days,
            )
            report.unclear.extend(mapping.unclear)
            held = {u.shown for u in mapping.unclear}
            sending = [s for s in batch if s.shown not in held]
            if not sending:
                continue
            preview = target.preview(sending, mapping.chosen)
            added = target.apply(preview, decide(preview))
            report.batches.append(_summarise(sending, preview, ledger, mapping.chosen, added))
            verb = "would add" if dry_run else "added"
            say(f"{report.batches[-1].shape}: {len(sending)} files, {verb} {added} rows")
            if not dry_run:
                for key, account_id in mapping.decided.items():
                    store.remember_account(key, account_id)
                    remembered = {**remembered, key: account_id}
                for s in sending:
                    store.mark_file(s.parsed.sha256, "pushed")
            report.accounts.update(mapping.chosen)
    final = target.ledger()
    report.gaps = balance_gaps(final)
    report.transactions = len(final.transactions)
    report.uncategorised = sum(1 for t in final.transactions if t.category_id == UNCATEGORIZED)
    report.ledger_accounts = {a.id: a.name for a in final.accounts}
    return report


def totals(report: Report) -> Counter[str]:
    c: Counter[str] = Counter()
    for b in report.batches:
        c.update(
            {
                "files": b.files,
                "rows": b.rows,
                "held": b.held,
                "new": b.new,
                "added": b.added,
                "dropped": b.dropped,
                "assertions": b.assertions,
                "holdings": b.holdings,
            }
        )
    return c


def difference(gap: MissingPeriodFinding) -> Decimal:
    return gap.expected_balance - gap.actual_balance


def kind_of(ledger: Ledger, account_id: str) -> AccountKind | None:
    return next((a.kind for a in ledger.accounts if a.id == account_id), None)


__all__ = [
    "BatchResult",
    "Collected",
    "Local",
    "Remote",
    "Report",
    "Skipped",
    "Source",
    "Target",
    "Unclear",
    "batches",
    "choose_accounts",
    "collect",
    "decide",
    "ledger_from_wire",
    "preview_from_wire",
    "run",
]
