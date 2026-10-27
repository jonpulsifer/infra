"""The engine: files plus a ledger in, a preview out; a preview plus decisions in, a ledger out.

Pure. No I/O beyond reading the files handed to `preview`. The CLI and the
server both call exactly these two functions.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from tally.classify.base import Classifier
from tally.model import ImportPreview, Ledger, ParsedFile


@dataclass(frozen=True)
class Decisions:
    """What the human said about a preview. Ids refer to findings and transactions in it."""

    accept_findings: frozenset[str] = frozenset()
    dismiss_findings: frozenset[str] = frozenset()
    account_for_file: dict[str, str] = field(default_factory=dict)  # file name -> account id
    recategorise: dict[str, str] = field(default_factory=dict)  # transaction id -> category id
    make_rules: frozenset[str] = frozenset()  # transaction ids whose correction becomes a rule
    withhold_strings: frozenset[str] = frozenset()  # descriptors that must not leave the lab


def preview(
    files: Sequence[Path | ParsedFile],
    ledger: Ledger,
    classifier: Classifier,
    *,
    dedupe_window_days: int = 3,
    transfer_window_days: int = 4,
    threshold: float = 0.8,
) -> ImportPreview:
    """Parse, dedupe against the ledger, pair transfers, check balances, classify.

    Implemented in `tally.engine_impl` by the integrator; this module holds
    the contract so every shell compiles against it.
    """
    from tally.engine_impl import preview as _preview

    return _preview(
        files,
        ledger,
        classifier,
        dedupe_window_days=dedupe_window_days,
        transfer_window_days=transfer_window_days,
        threshold=threshold,
    )


def apply(ledger: Ledger, preview: ImportPreview, decisions: Decisions) -> Ledger:
    """Fold an accepted preview into the ledger. Never resurrects a tombstoned row."""
    from tally.engine_impl import apply as _apply

    return _apply(ledger, preview, decisions)
