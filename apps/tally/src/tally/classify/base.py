from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from tally.model import Category, Source


@dataclass(frozen=True)
class Request:
    """What a classifier may see. Nothing else is ever passed to one."""

    descriptor: str
    account_kind: str | None = None  # 'credit', 'chequing'...: a hint, not an identifier


@dataclass(frozen=True)
class Result:
    descriptor: str
    category_id: str
    merchant: str
    confidence: float
    source: Source
    layer: str = field(default="", metadata={"doc": "Which cascade layer answered."})


class Classifier(Protocol):
    name: str

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        """One result per request, None where this layer has no opinion.

        Implementations must be pure with respect to the ledger: they get
        strings and the taxonomy, nothing more. A provider that talks to a
        model batches requests and must raise, not guess, when the model's
        answer is not a category id in `taxonomy`.
        """
        ...


class Cascade:
    """Layers tried in order; the first confident answer wins.

    `threshold` is the confidence below which a result still fills the row but
    also raises a low-confidence finding for review. `audit` receives every
    descriptor string that leaves the process, for the audit trail.
    """

    def __init__(
        self,
        layers: Sequence[Classifier],
        *,
        threshold: float = 0.8,
        outbound_layers: Iterable[str] = (),
    ) -> None:
        self.layers = list(layers)
        self.threshold = threshold
        self.outbound_layers = set(outbound_layers)
        self.outbound: list[str] = []

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        pending: dict[int, Request] = dict(enumerate(requests))
        answers: list[Result | None] = [None] * len(requests)
        for layer in self.layers:
            if not pending:
                break
            idx = list(pending)
            batch = [pending[i] for i in idx]
            if layer.name in self.outbound_layers:
                self.outbound.extend(sorted({r.descriptor for r in batch}))
            got = layer.classify(batch, taxonomy)
            for i, res in zip(idx, got, strict=True):
                if res is not None:
                    answers[i] = Result(**{**res.__dict__, "layer": res.layer or layer.name})
                    del pending[i]
        return answers
