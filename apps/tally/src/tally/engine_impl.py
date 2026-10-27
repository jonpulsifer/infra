"""`preview` and `apply`, behind the contract in `tally.engine`.

Sibling modules are imported inside functions so this module loads while one
of them is still being written.

Account resolution: an account hint that is a ledger account id is that
account; any other hint (an OFX ACCTID) becomes a minted `acct_<hash>` id, so
no account number is stored as an id and a re-import finds the same account.
A file with no hint holds its rows under `unassigned:<file name>` until
`account_for_file` names an account.

Defaults when the owner decides nothing: a FITID duplicate is dropped, a fuzzy
duplicate is kept, an `auto` transfer is stamped, a "replaces pending"
duplicate keeps the incoming row and retires the pending one only on accept.
A posted row with the same id as a pending one (the same row, now cleared)
posts that row in place, keeping its category.

Rows moved to the account the owner names at apply were deduped at preview
under their placeholder account, so apply dedupes them again against the
chosen account and drops FITID duplicates, as preview would have.

Only `scrub`bed descriptors reach a classifier: number-shaped identifiers in
payee text are replaced first, and the scrubbed form is what is audited and
cached as a rule.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Collection, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from tally.classify.base import Classifier, Request, Result
from tally.classify.egress import pattern, scrub
from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    Category,
    DuplicateFinding,
    Finding,
    Flow,
    HoldingSnapshot,
    ImportBatch,
    ImportPreview,
    Ledger,
    LowConfidenceFinding,
    MissingPeriodFinding,
    ParsedFile,
    ParsedRow,
    PreviewFile,
    Rule,
    Source,
    Transaction,
    TransferFinding,
    cents,
)
from tally.report import Taxonomy

if TYPE_CHECKING:
    from tally.engine import Decisions

UNCATEGORIZED = "uncategorized"
TRANSFER = "transfer"
UNASSIGNED = "unassigned:"
REPLACES_PENDING = "replaces pending"
LADDERED = frozenset({AccountKind.chequing, AccountKind.savings, AccountKind.credit})


class EngineError(ValueError):
    """A preview cannot be applied as decided. The message names a file or an id, never a row."""


def _digest(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()


def minted_account_id(institution: str | None, hint: str) -> str:
    return f"acct_{_digest(institution or '', hint)[:12]}"


def placeholder(file_name: str) -> str:
    return f"{UNASSIGNED}{file_name}"


def _tombstones(ledger: Ledger, extra: Collection[str]) -> frozenset[str]:
    return frozenset(extra) | frozenset(getattr(ledger, "tombstones", ()))


@dataclass(frozen=True)
class _File:
    parsed: ParsedFile
    source: str
    account_id: str | None
    kind: AccountKind | None

    def account_for(self, row: ParsedRow, known: Mapping[str, Account]) -> str:
        if row.account_hint and row.account_hint != self.parsed.account_hint:
            return _resolve_hint(row.account_hint, self.parsed.institution, known)
        return self.account_id or placeholder(self.parsed.name)

    def restamp[T: (BalanceAssertion, HoldingSnapshot)](
        self, item: T, known: Mapping[str, Account]
    ) -> T:
        """Give a statement's assertion or snapshot the account its rows land in."""
        if self.account_id is not None and item.account_id == self.account_id:
            return item
        if item.account_id in (self.parsed.account_hint, ""):
            account = self.account_id or placeholder(self.parsed.name)
        else:
            account = _resolve_hint(item.account_id, self.parsed.institution, known)
        return item.model_copy(update={"account_id": account})

    @property
    def needs_account(self) -> bool:
        pf = self.parsed
        if self.account_id is not None:
            return False
        stated = [*(a.account_id for a in pf.assertions), *(h.account_id for h in pf.holdings)]
        return any(not r.account_hint for r in pf.rows) or any(
            a in ("", pf.account_hint) for a in stated
        )


def _resolve_hint(hint: str, institution: str | None, known: Mapping[str, Account]) -> str:
    return hint if hint in known else minted_account_id(institution, hint)


def _resolve(
    i: int, pf: ParsedFile, known: Mapping[str, Account], chosen: Mapping[str, str]
) -> _File:
    account = chosen.get(pf.name)
    if account is None and pf.account_hint:
        account = _resolve_hint(pf.account_hint, pf.institution, known)
    acct = known.get(account) if account else None
    kind = acct.kind if acct else pf.account_kind_hint
    return _File(pf, f"{i}\x1f{pf.name}", account, kind)


def _parse(item: Path | ParsedFile) -> ParsedFile:
    if isinstance(item, ParsedFile):
        return item
    from tally.parsers import parse

    return parse(item)


def _batch_id(files: Sequence[ParsedFile]) -> str:
    return f"b-{_digest(*sorted(f.sha256 for f in files))[:12]}"


@dataclass
class _Draft:
    """An incoming row while the preview decides its identity and category."""

    id: str
    account_id: str
    row: ParsedRow
    kind: AccountKind | None
    new: bool
    category_id: str = UNCATEGORIZED
    merchant: str = ""
    source: Source = Source.rule
    confidence: float | None = None

    def freeze(self, batch_id: str) -> Transaction:
        return Transaction(
            id=self.id,
            account_id=self.account_id,
            date=self.row.date,
            amount=self.row.amount,
            descriptor=self.row.descriptor,
            merchant=self.merchant or self.row.descriptor,
            category_id=self.category_id,
            source=self.source,
            confidence=self.confidence,
            batch_id=batch_id,
            fitid=self.row.fitid,
            pending=self.row.pending,
        )


@dataclass(frozen=True)
class _Classified:
    low: list[LowConfidenceFinding]
    outbound: tuple[str, ...]
    rules_hit: int


def preview(
    files: Sequence[Path | ParsedFile],
    ledger: Ledger,
    classifier: Classifier,
    *,
    dedupe_window_days: int = 3,
    transfer_window_days: int = 4,
    threshold: float = 0.8,
    account_for_file: Mapping[str, str] | None = None,
    withhold: Collection[str] = (),
    tombstones: Collection[str] = (),
) -> ImportPreview:
    from tally.reconcile.dedupe import dedupe

    known = {a.id: a for a in ledger.accounts}
    chosen = dict(account_for_file or {})
    resolved = [_resolve(i, _parse(f), known, chosen) for i, f in enumerate(files)]
    rows, sources, owners = _incoming(resolved, known)
    result = dedupe(ledger.transactions, rows, window_days=dedupe_window_days, sources=sources)
    drafts = _drafts(rows, owners, result.ids, frozenset(result.new), ledger, tombstones)
    drafted = {d.id for d in drafts}
    dups = [f for f in result.findings if f.transaction_id in drafted]
    _inherit(drafts, dups, ledger)
    batch_id = _batch_id([r.parsed for r in resolved])
    fresh = [d.freeze(batch_id) for d in drafts if d.new]
    transfers = _transfers(ledger, fresh, transfer_window_days)
    paired = frozenset(leg for f in transfers if f.auto for leg in (f.out_id, f.in_id))
    classified = _classify(
        [d for d in drafts if d.new], ledger, classifier, threshold, frozenset(withhold), paired
    )
    txns = [d.freeze(batch_id) for d in drafts]
    file_assertions = [r.restamp(a, known) for r in resolved for a in r.parsed.assertions]
    file_holdings = [r.restamp(h, known) for r in resolved for h in r.parsed.holdings]
    findings: list[Finding] = [
        *dups,
        *_missing_periods(ledger, fresh, file_assertions, _kinds(ledger, resolved)),
        *transfers,
        *classified.low,
    ]
    return ImportPreview(
        files=tuple(_preview_file(r) for r in resolved),
        new_transactions=tuple(txns),
        findings=tuple(findings),
        outbound_strings=classified.outbound,
        rules_hit=classified.rules_hit,
        model_calls=len(classified.outbound),
        holdings=tuple(file_holdings),
        assertions=tuple(file_assertions),
    )


def _incoming(
    resolved: Sequence[_File], known: Mapping[str, Account]
) -> tuple[list[ParsedRow], list[str], list[_File]]:
    rows: list[ParsedRow] = []
    sources: list[str] = []
    owners: list[_File] = []
    for f in resolved:
        for row in f.parsed.rows:
            rows.append(row.model_copy(update={"account_hint": f.account_for(row, known)}))
            sources.append(f.source)
            owners.append(f)
    return rows, sources, owners


def _drafts(
    rows: Sequence[ParsedRow],
    owners: Sequence[_File],
    ids: Sequence[str],
    new: frozenset[int],
    ledger: Ledger,
    tombstones: Collection[str],
) -> list[_Draft]:
    """One draft per distinct incoming id that the ledger does not hold and nobody buried.

    A posted row whose id the ledger holds as pending is drafted but not new:
    apply posts the ledger row. When an id repeats, a row dedupe kept wins.
    """
    held = {t.id: t for t in ledger.transactions}
    buried = _tombstones(ledger, tombstones)
    drafts: dict[str, _Draft] = {}
    for i, (row, owner, tid) in enumerate(zip(rows, owners, ids, strict=True)):
        stored = held.get(tid)
        posts = stored is not None and stored.pending and not row.pending
        if tid in buried or (stored is not None and not posts):
            continue
        if tid in drafts and (drafts[tid].new or i not in new):
            continue
        account = row.account_hint or placeholder(owner.parsed.name)
        drafts[tid] = _Draft(tid, account, row, owner.kind, new=i in new and not posts)
    return list(drafts.values())


def _inherit(drafts: Sequence[_Draft], dups: Sequence[DuplicateFinding], ledger: Ledger) -> None:
    """A row flagged as a duplicate takes the category of the row it matches; no model sees it."""
    by_id: dict[str, Transaction | _Draft] = {t.id: t for t in ledger.transactions}
    by_id.update({d.id: d for d in drafts if d.new})
    matches = {f.transaction_id: f.matches_id for f in dups}
    for d in drafts:
        match = by_id.get(matches.get(d.id, ""))
        if d.new or match is None:
            continue
        d.category_id, d.merchant = match.category_id, match.merchant
        d.source, d.confidence = match.source, match.confidence


type _Matcher = Callable[[str, str | None], Rule | None]


def _rule_matcher(rules: Iterable[Rule]) -> _Matcher:
    try:
        from tally.classify.rules import RulesClassifier
    except ImportError:
        return lambda descriptor, account_id: None
    return RulesClassifier(rules).match


def _classify(
    drafts: Sequence[_Draft],
    ledger: Ledger,
    classifier: Classifier,
    threshold: float,
    withhold: frozenset[str],
    paired: frozenset[str],
) -> _Classified:
    """Rules first, then the classifier. A leg of an auto transfer needs no model."""
    match = _rule_matcher(ledger.rules)
    known = {c.id for c in ledger.categories}
    rules_hit = 0
    asking: list[_Draft] = []
    for d in drafts:
        rule = match(d.row.descriptor, d.account_id)
        if rule is not None and rule.category_id in known:
            d.category_id, d.merchant, d.source = rule.category_id, rule.merchant, Source.rule
            rules_hit += 1
        elif d.id in paired:
            d.category_id = _transfer_root(ledger.categories)
        else:
            asking.append(d)
    answers, outbound = _ask(asking, ledger.categories, classifier, withhold)
    low: list[LowConfidenceFinding] = []
    for d in asking:
        res = answers.get(scrub(d.row.descriptor))
        if res is not None and res.category_id in known:
            d.category_id, d.merchant = res.category_id, res.merchant
            d.source, d.confidence = res.source, res.confidence
            rules_hit += res.source is Source.rule
            if res.confidence >= threshold:
                continue
        low.append(_low(d, res if res is not None and res.category_id in known else None))
    return _Classified(low=low, outbound=outbound, rules_hit=rules_hit)


def _ask(
    drafts: Sequence[_Draft],
    taxonomy: Sequence[Category],
    classifier: Classifier,
    withhold: frozenset[str],
) -> tuple[dict[str, Result], tuple[str, ...]]:
    """Each unique scrubbed descriptor once. Only it and the account kind are passed."""
    kinds: dict[str, str | None] = {}
    for d in drafts:
        text = scrub(d.row.descriptor)
        if d.row.descriptor in withhold or text in withhold:
            continue
        kind = d.kind.value if d.kind else None
        if text in kinds and kinds[text] != kind:
            kind = None
        kinds[text] = kind
    if not kinds:
        return {}, ()
    requests = [Request(descriptor=s, account_kind=k) for s, k in kinds.items()]
    log = getattr(classifier, "outbound", None)
    before = len(log) if isinstance(log, list) else 0
    results = classifier.classify(requests, taxonomy)
    if len(results) != len(requests):
        name = getattr(classifier, "name", type(classifier).__name__)
        raise EngineError(f"{name}: {len(results)} results for {len(requests)} requests")
    answers = {r.descriptor: res for r, res in zip(requests, results, strict=True) if res}
    sent = log[before:] if isinstance(log, list) else list(kinds)
    return answers, tuple(dict.fromkeys(str(s) for s in sent))


def _low(d: _Draft, res: Result | None) -> LowConfidenceFinding:
    return LowConfidenceFinding(
        id=f"low_{_digest(d.id)[:16]}",
        transaction_id=d.id,
        suggested_category_id=res.category_id if res else UNCATEGORIZED,
        confidence=res.confidence if res else 0.0,
    )


def _transfers(
    ledger: Ledger, fresh: Sequence[Transaction], window_days: int
) -> list[TransferFinding]:
    if not fresh:
        return []
    from tally.reconcile.transfers import propose

    lo = min(t.date for t in fresh) - timedelta(days=window_days)
    hi = max(t.date for t in fresh) + timedelta(days=window_days)
    nearby = [t for t in ledger.transactions if t.transfer_id is None and lo <= t.date <= hi]
    ids = {t.id for t in fresh}
    return [
        f
        for f in propose([*nearby, *fresh], window_days=window_days)
        if f.out_id in ids or f.in_id in ids
    ]


def _kinds(ledger: Ledger, resolved: Sequence[_File]) -> dict[str, AccountKind | None]:
    kinds: dict[str, AccountKind | None] = {
        f.account_id or placeholder(f.parsed.name): f.kind for f in resolved
    }
    kinds.update({a.id: a.kind for a in ledger.accounts})
    return kinds


def _missing_periods(
    ledger: Ledger,
    fresh: Sequence[Transaction],
    file_assertions: Sequence[BalanceAssertion],
    kinds: Mapping[str, AccountKind | None],
) -> list[MissingPeriodFinding]:
    """Only the gaps this import opens or changes; a gap the ledger already had is not news.

    A mortgage, investment or asset balance comes from statements, holdings or
    valuations rather than the sum of its rows, so only an account of a
    `LADDERED` kind, or of no known kind, is checked.
    """
    from tally.reconcile.balances import check

    def laddered(assertions: Iterable[BalanceAssertion]) -> list[BalanceAssertion]:
        return [a for a in assertions if kinds.get(a.account_id) in (*LADDERED, None)]

    def shape(f: MissingPeriodFinding) -> tuple[str, date, date, int, int]:
        return (
            f.account_id,
            f.date_from,
            f.date_to,
            int(f.expected_balance * 100),
            int(f.actual_balance * 100),
        )

    before = {shape(f) for f in check(ledger.transactions, laddered(ledger.assertions))}
    after = check([*ledger.transactions, *fresh], laddered([*ledger.assertions, *file_assertions]))
    return [f for f in after if shape(f) not in before]


def _preview_file(f: _File) -> PreviewFile:
    pf = f.parsed
    return PreviewFile(
        name=pf.name,
        format=pf.format,
        institution=pf.institution,
        account_id=f.account_id,
        rows=len(pf.rows) or sum(len(h.positions) for h in pf.holdings),
        date_from=pf.date_from,
        date_to=pf.date_to,
        pages=pf.pages,
        scanned=pf.scanned,
        needs_account=f.needs_account,
        account_kind=f.kind,
    )


def apply(
    ledger: Ledger,
    preview: ImportPreview,
    decisions: Decisions,
    *,
    tombstones: Collection[str] = (),
    now: datetime | None = None,
) -> Ledger:
    """Fold the preview in as decided. Raises EngineError rather than guess an account."""
    accept, dismiss = decisions.accept_findings, decisions.dismiss_findings
    dups = [f for f in preview.findings if isinstance(f, DuplicateFinding)]
    drop = {f.transaction_id for f in dups if _drops(f, accept, dismiss)}
    retire = {
        f.matches_id
        for f in dups
        if f.id in accept and _replaces(f) and f.transaction_id != f.matches_id
    }
    kept, id_map, moves = _assign_accounts(
        [t for t in preview.new_transactions if t.id not in drop | retire],
        preview,
        ledger,
        decisions,
    )
    kept = _drop_moved_twins(kept, frozenset(id_map.values()), ledger)
    posted = _postings(ledger, kept)
    buried = _tombstones(ledger, tombstones) | {t.id for t in ledger.transactions}
    kept = [t for t in kept if t.id not in buried]
    kept = _forget(kept, decisions.withhold_strings)
    kept = _recategorise(kept, preview, decisions, id_map, ledger)
    rules = _mint_rules(kept, decisions, id_map, ledger)
    rules += _cache_answers(kept, preview, id_map, [*ledger.rules, *rules])
    rows = _stamp_transfers(
        ledger,
        [_post(t, posted) for t in ledger.transactions if t.id not in retire],
        kept,
        preview,
        decisions,
        id_map,
    )
    holdings = _new_holdings(ledger, [_moved(h, moves) for h in preview.holdings])
    assertions = _new_assertions(ledger, [_moved(a, moves) for a in preview.assertions])
    return ledger.model_copy(
        update={
            "accounts": (
                *ledger.accounts,
                *_new_accounts(kept, holdings, assertions, preview, ledger),
            ),
            "transactions": tuple(sorted(rows, key=lambda t: (t.date, t.id))),
            "holdings": (*ledger.holdings, *holdings),
            "assertions": (*ledger.assertions, *assertions),
            "rules": (*ledger.rules, *rules),
            "batches": _batches(ledger, preview, kept, now),
        }
    )


def _drop_moved_twins(
    kept: list[Transaction], moved: frozenset[str], ledger: Ledger
) -> list[Transaction]:
    """Drop a moved row whose FITID the chosen account already holds."""
    from tally.reconcile.dedupe import dedupe

    moving = [t for t in kept if t.id in moved]
    if not moving:
        return kept
    found = dedupe(ledger.transactions, moving).findings
    twins = {f.transaction_id for f in found if f.tier == "fitid" and not _replaces(f)}
    return [t for t in kept if t.id not in twins]


def _postings(ledger: Ledger, kept: Sequence[Transaction]) -> dict[str, Transaction]:
    """Incoming posted rows whose id the ledger holds as pending, by that id."""
    pending = {t.id for t in ledger.transactions if t.pending}
    return {t.id: t for t in kept if t.id in pending and not t.pending}


def _post(t: Transaction, posted: Mapping[str, Transaction]) -> Transaction:
    incoming = posted.get(t.id)
    if incoming is None:
        return t
    return t.model_copy(update={"pending": False, "fitid": t.fitid or incoming.fitid})


def _forget(kept: list[Transaction], withheld: Collection[str]) -> list[Transaction]:
    """A model answer the owner withheld at apply is not kept, and so never cached as a rule."""
    if not withheld:
        return kept
    return [
        t.model_copy(
            update={
                "category_id": UNCATEGORIZED,
                "merchant": t.descriptor,
                "source": Source.manual,
                "confidence": None,
            }
        )
        if t.source is Source.model
        and (t.descriptor in withheld or scrub(t.descriptor) in withheld)
        else t
        for t in kept
    ]


def _moved[T: (BalanceAssertion, HoldingSnapshot)](item: T, moves: Mapping[str, str]) -> T:
    chosen = moves.get(item.account_id)
    return item.model_copy(update={"account_id": chosen}) if chosen else item


def _new_holdings(ledger: Ledger, incoming: Sequence[HoldingSnapshot]) -> list[HoldingSnapshot]:
    """One snapshot per account and date; the ledger's copy wins."""
    have = {(h.account_id, h.date) for h in ledger.holdings}
    out: list[HoldingSnapshot] = []
    for h in incoming:
        if (h.account_id, h.date) not in have:
            have.add((h.account_id, h.date))
            out.append(h)
    return out


def _new_assertions(ledger: Ledger, incoming: Sequence[BalanceAssertion]) -> list[BalanceAssertion]:
    have = {(a.account_id, a.date, cents(a.balance)) for a in ledger.assertions}
    out: list[BalanceAssertion] = []
    for a in incoming:
        key = (a.account_id, a.date, cents(a.balance))
        if key not in have:
            have.add(key)
            out.append(a)
    return out


def _replaces(f: DuplicateFinding) -> bool:
    return f.reason.startswith(REPLACES_PENDING)


def _drops(f: DuplicateFinding, accept: frozenset[str], dismiss: frozenset[str]) -> bool:
    if _replaces(f) or f.transaction_id == f.matches_id:
        return False
    return f.id in accept or (f.tier == "fitid" and f.id not in dismiss)


def _assign_accounts(
    txns: list[Transaction], preview: ImportPreview, ledger: Ledger, decisions: Decisions
) -> tuple[list[Transaction], dict[str, str], dict[str, str]]:
    """Move rows to the accounts the owner chose, re-deriving their ids for the real account."""
    from tally.reconcile.identity import assign_ids

    targets = {a.id for a in ledger.accounts} | {
        f.account_id for f in preview.files if f.account_id
    }
    moves: dict[str, str] = {}
    for f in preview.files:
        chosen = decisions.account_for_file.get(f.name)
        held = f.account_id or placeholder(f.name)
        if chosen is None or chosen == held:
            if chosen is None and f.needs_account:
                raise EngineError(f"{f.name}: needs an account")
            continue
        if chosen not in targets:
            raise EngineError(f"{f.name}: no account {chosen}")
        moves[held] = chosen
    id_map: dict[str, str] = {}
    for held, chosen in moves.items():
        moving = [t for t in txns if t.account_id == held]
        ids = assign_ids((chosen, t.date, cents(t.amount), t.descriptor) for t in moving)
        id_map.update((t.id, new) for t, new in zip(moving, ids, strict=True))
    moved = [
        t.model_copy(update={"id": id_map[t.id], "account_id": moves[t.account_id]})
        if t.id in id_map
        else t
        for t in txns
    ]
    return _first_per_id(moved), id_map, moves


def _first_per_id(txns: Iterable[Transaction]) -> list[Transaction]:
    seen: set[str] = set()
    out: list[Transaction] = []
    for t in txns:
        if t.id not in seen:
            seen.add(t.id)
            out.append(t)
    return out


def _recategorise(
    kept: list[Transaction],
    preview: ImportPreview,
    decisions: Decisions,
    id_map: Mapping[str, str],
    ledger: Ledger,
) -> list[Transaction]:
    known = {c.id for c in ledger.categories}
    chosen = {
        id_map.get(f.transaction_id, f.transaction_id): f.suggested_category_id
        for f in preview.findings
        if isinstance(f, LowConfidenceFinding) and f.id in decisions.accept_findings
    }
    chosen.update({id_map.get(k, k): v for k, v in decisions.recategorise.items()})
    for tid, cat in chosen.items():
        if cat not in known:
            raise EngineError(f"{tid}: no category {cat}")
    return [
        t.model_copy(
            update={"category_id": chosen[t.id], "source": Source.manual, "confidence": None}
        )
        if t.id in chosen
        else t
        for t in kept
    ]


def _mint_rules(
    kept: Sequence[Transaction], decisions: Decisions, id_map: Mapping[str, str], ledger: Ledger
) -> list[Rule]:
    wanted = {id_map.get(i, i) for i in decisions.make_rules}
    have = {r.id for r in ledger.rules}
    out: list[Rule] = []
    for t in kept:
        if t.id not in wanted:
            continue
        rule = _rule_from(t)
        if rule.id not in have:
            have.add(rule.id)
            out.append(rule)
    return out


def _cache_answers(
    kept: Sequence[Transaction],
    preview: ImportPreview,
    id_map: Mapping[str, str],
    rules: Sequence[Rule],
) -> list[Rule]:
    """A confident model answer becomes an exact-descriptor rule, so the string never goes twice.

    A row still under a low-confidence finding is not cached: a rule answers at
    full confidence and would hide the doubt.
    """
    doubted = {
        id_map.get(f.transaction_id, f.transaction_id)
        for f in preview.findings
        if isinstance(f, LowConfidenceFinding)
    }
    have = {r.id for r in rules}
    out: list[Rule] = []
    for t in kept:
        if t.source is not Source.model or t.id in doubted:
            continue
        rule = _exact_rule(t)
        if rule.id not in have:
            have.add(rule.id)
            out.append(rule)
    return out


def _exact_rule(t: Transaction) -> Rule:
    """A substring rule when the descriptor is plain text, else an escaped /regex/.

    A scrubbed descriptor caches as a pattern whose placeholders match any
    identifier, and a descriptor shaped like `/x/` is escaped so it never
    compiles as the owner's regex.
    """
    plain = " ".join(t.descriptor.split())
    text = scrub(plain)
    match = plain.casefold()
    if text != plain or (len(match) >= 2 and match[0] == match[-1] == "/"):
        match = f"/{pattern(text)}/"
    try:
        from tally.classify.rules import rule_id
    except ImportError:
        rid = f"r-{_digest(match, t.category_id, '')[:12]}"
    else:
        rid = rule_id(match, t.category_id)
    return Rule(
        id=rid, match=match, category_id=t.category_id, merchant=t.merchant, created_from="model"
    )


def _rule_from(t: Transaction) -> Rule:
    try:
        from tally.classify.rules import rule_from_correction
    except ImportError:
        return Rule(
            id=f"r-{_digest(t.descriptor.casefold(), t.category_id)[:12]}",
            match=t.descriptor,
            category_id=t.category_id,
            merchant=t.merchant,
            created_from="correction",
        )
    return rule_from_correction(t, t.category_id)


def _stamp_transfers(
    ledger: Ledger,
    existing: list[Transaction],
    kept: list[Transaction],
    preview: ImportPreview,
    decisions: Decisions,
    id_map: Mapping[str, str],
) -> list[Transaction]:
    from tally.reconcile.transfers import apply as stamp

    rows = [*existing, *kept]
    by_id = {t.id: t for t in rows}
    groups: dict[str, list[TransferFinding]] = {}
    for f in preview.findings:
        if not isinstance(f, TransferFinding) or not _accepted_transfer(f, decisions):
            continue
        legs = (by_id.get(id_map.get(f.out_id, f.out_id)), by_id.get(id_map.get(f.in_id, f.in_id)))
        out, inn = legs
        if out is None or inn is None or out.account_id == inn.account_id:
            continue
        if out.transfer_id or inn.transfer_id:
            continue
        moved = f.model_copy(update={"out_id": out.id, "in_id": inn.id})
        groups.setdefault(_transfer_category(out, inn, ledger.categories), []).append(moved)
    for category_id, accepted in groups.items():
        rows = list(stamp(rows, accepted, category_id=category_id))
    return rows


def _accepted_transfer(f: TransferFinding, decisions: Decisions) -> bool:
    if f.id in decisions.dismiss_findings:
        return False
    return f.auto or f.id in decisions.accept_findings


def _transfer_category(out: Transaction, inn: Transaction, categories: Sequence[Category]) -> str:
    """Keep a transfer-flow category a rule already gave a leg; else a top-level transfer one."""
    tax = Taxonomy(categories)
    for leg in (out, inn):
        if leg.category_id in tax.by_id and tax.top(leg.category_id).flow is Flow.transfer:
            return leg.category_id
    return _transfer_root(categories)


def _transfer_root(categories: Sequence[Category]) -> str:
    roots = [c.id for c in categories if c.parent_id is None and c.flow is Flow.transfer]
    return TRANSFER if TRANSFER in {c.id for c in categories} or not roots else roots[0]


def _new_accounts(
    kept: Sequence[Transaction],
    holdings: Sequence[HoldingSnapshot],
    assertions: Sequence[BalanceAssertion],
    preview: ImportPreview,
    ledger: Ledger,
) -> list[Account]:
    """Accounts the import names but the ledger lacks, with the kind their file declared."""
    known = {a.id for a in ledger.accounts}
    files = {f.account_id: f for f in preview.files if f.account_id}
    investing = {h.account_id for h in holdings}
    first: dict[str, date] = {}
    for account_id, on in (
        *((t.account_id, t.date) for t in kept),
        *((h.account_id, h.date) for h in holdings),
        *((a.account_id, a.date) for a in assertions),
    ):
        if account_id not in known and not account_id.startswith(UNASSIGNED):
            first[account_id] = min(first.get(account_id, on), on)
    out: list[Account] = []
    for account_id, since in first.items():
        f = files.get(account_id)
        institution = (f.institution if f else None) or "Unknown"
        kind = f.account_kind if f and f.account_kind else None
        if kind is None:
            kind = AccountKind.investment if account_id in investing else AccountKind.chequing
        out.append(
            Account(
                id=account_id,
                name=f"{institution} account",
                institution=institution,
                kind=kind,
                since=since,
            )
        )
    return out


def _batches(
    ledger: Ledger, preview: ImportPreview, kept: Sequence[Transaction], now: datetime | None
) -> tuple[ImportBatch, ...]:
    batch_id = next(
        (t.batch_id for t in preview.new_transactions),
        f"b-{_digest(*sorted(f.name for f in preview.files))[:12]}",
    )
    if any(b.id == batch_id for b in ledger.batches):
        return ledger.batches
    batch = ImportBatch(
        id=batch_id,
        imported_at=now or datetime.now(UTC),
        files=len(preview.files),
        rows=len(kept),
    )
    return (*ledger.batches, batch)
