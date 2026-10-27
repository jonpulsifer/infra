"""Model providers: the only code that sends anything off the machine.

A provider sees `Request.descriptor` and the taxonomy's ids and names. It
never reads another Request field, sends each unique descriptor once per
call, batches them, records each batch in the Audit before it leaves, and
raises rather than guesses when an answer is not a taxonomy id.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import batched

from tally.classify.audit import Audit
from tally.classify.base import Request, Result
from tally.classify.taxonomy import assignable
from tally.model import Category, Source

BATCH_SIZE = 75


class ProviderError(RuntimeError):
    """The provider failed or answered outside the contract. Messages name no descriptor."""


class ProviderUnavailableError(ProviderError):
    """The provider cannot run here: no binary, no login, no key."""


@dataclass(frozen=True)
class Answer:
    index: int
    merchant: str
    category_id: str
    confidence: float


def response_schema(taxonomy: Sequence[Category]) -> dict[str, object]:
    ids = list(assignable(taxonomy))
    if not ids:
        raise ProviderError("the taxonomy has no assignable category")
    item = {
        "type": "object",
        "properties": {
            "index": {"type": "integer"},
            "merchant": {"type": "string"},
            "category_id": {"type": "string", "enum": ids},
            "confidence": {"type": "number"},
        },
        "required": ["index", "merchant", "category_id", "confidence"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"items": {"type": "array", "items": item}},
        "required": ["items"],
        "additionalProperties": False,
    }


def _path(c: Category, by_id: dict[str, Category]) -> str:
    names = [c.name]
    while c.parent_id is not None and c.parent_id in by_id:
        c = by_id[c.parent_id]
        names.append(c.name)
    return " / ".join(reversed(names))


def system_prompt(taxonomy: Sequence[Category]) -> str:
    by_id = {c.id: c for c in taxonomy}
    lines = "\n".join(f"- {cid}: {_path(by_id[cid], by_id)}" for cid in assignable(taxonomy))
    return (
        "You label bank transaction descriptors for a household ledger in Canada. "
        "For each descriptor give the merchant's plain name, the one category id below "
        "that fits best, and your confidence from 0 to 1. Answer every index exactly once."
        "\n\nCategories:\n" + lines
    )


def user_prompt(strings: Sequence[str]) -> str:
    return json.dumps([{"index": i, "descriptor": s} for i, s in enumerate(strings)])


def parse_answers(raw: str, strings: Sequence[str], taxonomy: Sequence[Category]) -> list[Answer]:
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        raise ProviderError("the model's answer is not JSON") from None
    items = doc.get("items") if isinstance(doc, dict) else None
    if not isinstance(items, list):
        raise ProviderError("the model's answer has no items list")
    ids = set(assignable(taxonomy))
    out: dict[int, Answer] = {}
    for item in items:
        answer = _answer(item, ids, len(strings))
        if answer.index in out:
            raise ProviderError(f"the model answered index {answer.index} twice")
        out[answer.index] = answer
    if len(out) != len(strings):
        raise ProviderError(f"the model answered {len(out)} of {len(strings)} descriptors")
    return [out[i] for i in range(len(strings))]


def _answer(item: object, ids: set[str], n: int) -> Answer:
    if not isinstance(item, dict):
        raise ProviderError("an answer item is not an object")
    index, merchant = item.get("index"), item.get("merchant")
    category_id, confidence = item.get("category_id"), item.get("confidence")
    if not isinstance(index, int) or isinstance(index, bool) or not 0 <= index < n:
        raise ProviderError("an answer names an index that was not sent")
    if not isinstance(category_id, str) or category_id not in ids:
        raise ProviderError(f"index {index}: the model answered an id outside the taxonomy")
    if not isinstance(confidence, int | float) or isinstance(confidence, bool):
        raise ProviderError(f"index {index}: confidence is not a number")
    if not 0.0 <= confidence <= 1.0:
        raise ProviderError(f"index {index}: confidence is outside 0 to 1")
    return Answer(
        index, merchant.strip() if isinstance(merchant, str) else "", category_id, float(confidence)
    )


class ModelProvider[P](ABC):
    """Dedupe, batch, audit, send, validate. Subclasses build the payload and send it.

    With `dry_run`, nothing is sent: every payload is kept in `dry_runs` and
    every result is None.
    """

    name: str

    def __init__(
        self,
        *,
        model: str,
        batch_size: int = BATCH_SIZE,
        audit: Audit | None = None,
        dry_run: bool = False,
    ) -> None:
        if not 1 <= batch_size <= BATCH_SIZE:
            raise ValueError(f"batch_size must be 1 to {BATCH_SIZE}")
        self.model = model
        self.batch_size = batch_size
        self.audit = audit if audit is not None else Audit()
        self.dry_run = dry_run
        self.dry_runs: list[P] = []

    @abstractmethod
    def payload(self, strings: Sequence[str], taxonomy: Sequence[Category]) -> P: ...

    @abstractmethod
    def send(self, payload: P) -> str:
        """Deliver one payload and return the model's raw JSON text."""

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        unique = list(dict.fromkeys(r.descriptor for r in requests))
        known: dict[str, Result] = {}
        for chunk in batched(unique, self.batch_size, strict=False):
            payload = self.payload(chunk, taxonomy)
            if self.dry_run:
                self.dry_runs.append(payload)
                continue
            self.audit.record(self.name, self.model, chunk)
            for s, a in zip(chunk, parse_answers(self.send(payload), chunk, taxonomy), strict=True):
                known[s] = Result(
                    descriptor=s,
                    category_id=a.category_id,
                    merchant=a.merchant or s,
                    confidence=a.confidence,
                    source=Source.model,
                    layer=self.name,
                )
        return [known.get(r.descriptor) for r in requests]
