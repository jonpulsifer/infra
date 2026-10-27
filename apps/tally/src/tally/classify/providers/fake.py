"""A deterministic in-memory provider for tests and the demo. Nothing leaves the process."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from tally.classify.audit import Audit
from tally.classify.providers import BATCH_SIZE, ModelProvider
from tally.classify.taxonomy import assignable
from tally.model import Category


@dataclass(frozen=True)
class FakeAnswer:
    category_id: str
    merchant: str = ""
    confidence: float = 0.9


@dataclass(frozen=True)
class FakeCall:
    strings: tuple[str, ...]
    ids: tuple[str, ...]


class FakeProvider(ModelProvider[FakeCall]):
    """Answers from `answers`, keyed by descriptor or by a lower-case keyword it contains.

    An unknown descriptor gets a category picked by hash at `fallback_confidence`,
    the same on every run. `calls` holds each batch in order.
    """

    name = "fake"

    def __init__(
        self,
        answers: Mapping[str, FakeAnswer] | None = None,
        *,
        model: str = "fake-1",
        fallback_confidence: float = 0.4,
        batch_size: int = BATCH_SIZE,
        audit: Audit | None = None,
        dry_run: bool = False,
    ) -> None:
        super().__init__(model=model, batch_size=batch_size, audit=audit, dry_run=dry_run)
        self.answers = dict(answers or {})
        self.fallback_confidence = fallback_confidence
        self.calls: list[tuple[str, ...]] = []

    def payload(self, strings: Sequence[str], taxonomy: Sequence[Category]) -> FakeCall:
        return FakeCall(tuple(strings), assignable(taxonomy))

    def send(self, payload: FakeCall) -> str:
        self.calls.append(payload.strings)
        items = [
            {"index": i, **self._answer(s, payload.ids)} for i, s in enumerate(payload.strings)
        ]
        return json.dumps({"items": items})

    def _answer(self, descriptor: str, ids: tuple[str, ...]) -> dict[str, object]:
        hit = self.answers.get(descriptor) or next(
            (a for k, a in self.answers.items() if k.casefold() in descriptor.casefold()), None
        )
        if hit is not None:
            return {
                "merchant": hit.merchant,
                "category_id": hit.category_id,
                "confidence": hit.confidence,
            }
        pick = int(hashlib.sha256(descriptor.encode()).hexdigest(), 16) % len(ids)
        return {
            "merchant": descriptor.split(" #")[0].title(),
            "category_id": ids[pick],
            "confidence": self.fallback_confidence,
        }
