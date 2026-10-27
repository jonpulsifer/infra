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
5. `Report` says what happened and highlights what disagrees: accounts whose
   rows do not sum to the balances their statements assert (per period and
   over the whole span), files that need an account, files that could not
   be read, and rows nobody categorised. The first two are the exit code.

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
    packed: bool = False

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
    twins: int = 0


def collect(root: Path, settings: config.Settings, scratch: Path) -> Collected:
    """Every readable file under `root`, parsed, with zip members written under `scratch`.

    A file whose bytes another file already supplied (a zip of the same export
    beside it) is a twin and is counted, not loaded twice.
    """
    paths, excluded, hidden = files.walk(root, settings)
    sources: list[Source] = []
    skipped: list[Skipped] = []
    for path in paths:
        if path.suffix.lower() == ".zip":
            for member in files.unpack(path, settings, scratch):
                if member.path is None:
                    skipped.append(Skipped(member.shown, member.reason or "not opened"))
                else:
                    _parse_into(member.path, member.shown, sources, skipped, packed=True)
        elif files.is_archive(path):
            skipped.append(Skipped(path.name, "an archive tally does not open"))
        else:
            _parse_into(path, path.name, sources, skipped)
    seen: set[str] = set()
    unique: list[Source] = []
    for s in sorted(sources, key=lambda s: s.packed):  # a loose file beats its zipped twin
        if s.parsed.sha256 not in seen:
            seen.add(s.parsed.sha256)
            unique.append(s)
    return Collected(
        tuple(unique), tuple(skipped), excluded, hidden, twins=len(sources) - len(unique)
    )


def _parse_into(
    path: Path, shown: str, sources: list[Source], skipped: list[Skipped], *, packed: bool = False
) -> None:
    try:
        pf = parsers.parse(path)
    except parsers.ParseError as exc:
        skipped.append(Skipped(shown, _reason(str(exc), path.name)))
        return
    except Exception as exc:
        skipped.append(Skipped(shown, type(exc).__name__))
        return
    sources.append(Source(path, shown, pf.model_copy(update={"name": shown}), packed))


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
    """Sources in load order: one group per shape, groups by their earliest file, at most
    BATCH_LIMIT to a batch, so every statement of one card is decided together.
    """
    groups: dict[tuple[Any, ...], list[Source]] = {}
    for s in sorted(sources, key=_rank):
        groups.setdefault(_shape(s), []).append(s)
    out: list[list[Source]] = []
    for members in sorted(groups.values(), key=lambda g: _rank(g[0])):
        out.extend(members[i : i + BATCH_LIMIT] for i in range(0, len(members), BATCH_LIMIT))
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
    """The account the engine would give the file's rows with no decision.

    None when there is nothing to decide: the rows name more than one account,
    or the file has no rows and its snapshots and assertions name their own.
    """
    pf = s.parsed
    hints = {r.account_hint for r in pf.rows if r.account_hint}
    if len(hints) > 1:
        return None
    hint = pf.account_hint or next(iter(hints), None)
    if hint:
        return hint if hint in known else minted_account_id(pf.institution, hint)
    stated = [*(a.account_id for a in pf.assertions), *(h.account_id for h in pf.holdings)]
    if not pf.rows and stated and all(stated):
        return None
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
        kept = decided.get(s.key, remembered.get(s.key))
        if kept is not None and kept in known:
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

    def __init__(self, http: Any, *, dedupe_window_days: int | None = None) -> None:
        self.http = http
        self._window = dedupe_window_days
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
        form = {"account_for_file": json.dumps(dict(account_for_file))}
        if self._window is not None:
            form["dedupe_window_days"] = str(self._window)
        resp = self.http.post("/api/import/preview", files=uploads, data=form)
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
    twins: int = 0
    batches: list[BatchResult] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)
    unclear: list[Unclear] = field(default_factory=list)
    accounts: dict[str, str] = field(default_factory=dict)
    gaps: list[MissingPeriodFinding] = field(default_factory=list)
    ladders: list[AccountLadder] = field(default_factory=list)
    uncategorised: int = 0
    transactions: int = 0
    ledger_accounts: dict[str, str] = field(default_factory=dict)

    @property
    def added(self) -> int:
        return sum(b.added for b in self.batches)

    @property
    def discrepancies(self) -> int:
        """What needs the owner: an account off its statements, a file with no account.

        A file that could not be read is listed, not counted: a finance folder
        holds tax slips and receipts that are not ledger input.
        """
        off = sum(1 for ladder in self.ladders if not ladder.holds)
        return off + len(self.unclear)

    def as_json(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "dryRun": self.dry_run,
            "added": self.added,
            "already": self.already,
            "twins": self.twins,
            "batches": [b.__dict__ for b in self.batches],
            "skipped": [s.__dict__ for s in self.skipped],
            "unclear": [u.__dict__ for u in self.unclear],
            "accounts": self.accounts,
            "gaps": [g.model_dump(mode="json") for g in self.gaps],
            "ladders": [
                {**ladder.__dict__, "span_difference": str(ladder.span_difference)}
                for ladder in self.ladders
            ],
            "uncategorised": self.uncategorised,
            "transactions": self.transactions,
        }


def decide(preview: ImportPreview) -> Decisions:
    """Drop every fuzzy duplicate, keep a posting of a pending row, and pair the transfers
    the file itself tagged as transfers on both legs.
    """
    tagged = {
        t.id
        for t in preview.new_transactions
        if any(tag.partition(":")[2] == "transfer" for tag in t.tags)
    }
    accept = {
        f.id
        for f in preview.findings
        if isinstance(f, DuplicateFinding)
        and f.tier == "fuzzy"
        and not f.reason.startswith("replaces pending")
    }
    accept |= {
        f.id
        for f in preview.findings
        if isinstance(f, TransferFinding) and f.out_id in tagged and f.in_id in tagged
    }
    return Decisions(accept_findings=frozenset(accept))


def _unmatched_in_overlap(preview: ImportPreview, ledger: Ledger, chosen: Mapping[str, str]) -> int:
    """New rows dated inside a span the chosen account already covers from another source."""
    spans: dict[str, tuple[date, date]] = {}
    for t in ledger.transactions:
        lo, hi = spans.get(t.account_id, (t.date, t.date))
        spans[t.account_id] = (min(lo, t.date), max(hi, t.date))
    dropped = {
        f.transaction_id
        for f in preview.findings
        if isinstance(f, DuplicateFinding) and f.transaction_id != f.matches_id
    }
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


@dataclass(frozen=True)
class AccountLadder:
    """How one account's rows stand against every balance an institution asserted for it.

    `periods_off` counts assertions the running total misses. `span_difference`
    is what the whole span is off by: the last asserted balance less the
    first, less every row dated between them. Periods off with a span that
    holds means rows sit on the wrong side of statement dates (a register
    kept by purchase date against statements kept by posting date); a span
    off means money is missing (positive: money in) or counted twice.
    """

    account_id: str
    assertions: int
    periods_off: int
    span_difference: Decimal
    date_from: date
    date_to: date

    @property
    def holds(self) -> bool:
        return self.periods_off == 0 and self.span_difference == 0


def ladders(ledger: Ledger) -> list[AccountLadder]:
    """One summary per account that has balance assertions and is summed from its rows."""
    kinds = {a.id: a.kind for a in ledger.accounts}
    gaps = Counter(g.account_id for g in balance_gaps(ledger))
    out: list[AccountLadder] = []
    for account_id in dict.fromkeys(a.account_id for a in ledger.assertions):
        if kinds.get(account_id) not in (*LADDERED, None):
            continue
        asserted = sorted(
            (a for a in ledger.assertions if a.account_id == account_id), key=lambda a: a.date
        )
        first, last = asserted[0], asserted[-1]
        between = sum(
            (
                t.amount
                for t in ledger.transactions
                if t.account_id == account_id and not t.pending and first.date < t.date <= last.date
            ),
            Decimal(),
        )
        span = ((last.balance - first.balance) - between).quantize(Decimal("0.01"))
        out.append(
            AccountLadder(account_id, len(asserted), gaps[account_id], span, first.date, last.date)
        )
    return out


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
        report.twins = found.twins
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
            remembered = {**remembered, **mapping.decided}
            if not dry_run:
                for key, account_id in mapping.decided.items():
                    store.remember_account(key, account_id)
                for s in sending:
                    store.mark_file(s.parsed.sha256, "pushed")
            report.accounts.update(mapping.chosen)
    final = target.ledger()
    report.gaps = balance_gaps(final)
    report.ladders = ladders(final)
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
