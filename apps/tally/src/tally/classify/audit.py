"""The outbound audit trail: every batch of descriptor strings that left the process."""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime


@dataclass(frozen=True)
class OutboundBatch:
    at: datetime
    provider: str
    model: str
    count: int
    sha256: str
    strings: tuple[str, ...]


def digest(strings: Sequence[str]) -> str:
    return hashlib.sha256("\n".join(strings).encode()).hexdigest()


class Audit:
    """Append-only and in memory. The store persists `to_rows()`."""

    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._clock = clock
        self._batches: list[OutboundBatch] = []

    def record(self, provider: str, model: str, strings: Sequence[str]) -> OutboundBatch:
        batch = OutboundBatch(
            at=self._clock(),
            provider=provider,
            model=model,
            count=len(strings),
            sha256=digest(strings),
            strings=tuple(strings),
        )
        self._batches.append(batch)
        return batch

    @property
    def batches(self) -> tuple[OutboundBatch, ...]:
        return tuple(self._batches)

    def strings(self) -> tuple[str, ...]:
        return tuple(s for b in self._batches for s in b.strings)

    def to_rows(self) -> list[dict[str, object]]:
        return [
            {
                "at": b.at.isoformat(),
                "provider": b.provider,
                "model": b.model,
                "count": b.count,
                "sha256": b.sha256,
                "strings": list(b.strings),
            }
            for b in self._batches
        ]
