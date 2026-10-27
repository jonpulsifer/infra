"""The engine: files plus a ledger in, a preview out; a preview plus decisions in, a ledger out.

Pure. No I/O beyond reading the files handed to `preview`. The CLI and the
server both call exactly these two functions.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from tally.classify.base import Classifier
from tally.model import ImportPreview, Ledger, ParsedFile


@dataclass(frozen=True)
class Decisions:
    """What the human said about a preview. Ids refer to findings and transactions in it.

    `withhold_strings` arrive after the preview asked its classifier, so they
    cannot stop a string leaving; apply drops the model's answer for them,
    leaves their rows uncategorised and caches no rule. `preview(withhold=...)`
    is what keeps a string in the lab.

    A duplicate finding in `replace_findings` is resolved the other way round
    from `accept_findings`: the incoming row stays and the ledger row it
    matched is retired, keeping that row's category, transfer and tags. A
    statement's row, dated as the institution posted it, replaces a hand-kept
    register's row that way, so the account sums to the statement's balances.

    A file in `authoritative_files` lists every posting of its account over
    its dates, as a bank statement does, so a ledger row in that account and
    span that no row of the file matched is retired too; a transfer partner
    it leaves behind is unpaired, not removed.
    """

    accept_findings: frozenset[str] = frozenset()
    dismiss_findings: frozenset[str] = frozenset()
    account_for_file: dict[str, str] = field(default_factory=dict)  # file name -> account id
    recategorise: dict[str, str] = field(default_factory=dict)  # transaction id -> category id
    make_rules: frozenset[str] = frozenset()  # transaction ids whose correction becomes a rule
    withhold_strings: frozenset[str] = frozenset()  # descriptors whose model answer is refused
    replace_findings: frozenset[str] = frozenset()  # duplicates where the ledger row gives way
    authoritative_files: frozenset[str] = frozenset()  # files that list every row of their span


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
    """Parse, dedupe against the ledger, pair transfers, check balances, classify.

    `withhold` names descriptors no classifier may see: they are decided here,
    at preview, because a provider has already been asked by apply time.
    `tombstones` are transaction ids the owner deleted; they never come back.
    """
    from tally.engine_impl import preview as _preview

    return _preview(
        files,
        ledger,
        classifier,
        dedupe_window_days=dedupe_window_days,
        transfer_window_days=transfer_window_days,
        threshold=threshold,
        account_for_file=account_for_file,
        withhold=withhold,
        tombstones=tombstones,
    )


def apply(
    ledger: Ledger,
    preview: ImportPreview,
    decisions: Decisions,
    *,
    tombstones: Collection[str] = (),
    now: datetime | None = None,
) -> Ledger:
    """Fold an accepted preview into the ledger. Never resurrects a tombstoned row."""
    from tally.engine_impl import apply as _apply

    return _apply(ledger, preview, decisions, tombstones=tombstones, now=now)
