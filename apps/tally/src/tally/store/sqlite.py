"""The CLI's local cache: rules, model answers, the outbound audit, seen files, ledger snapshots.

Migrations are numbered SQL strings applied in order; `PRAGMA user_version`
records how many have run. Nothing here talks to a network.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Self

from tally.classify.base import Result
from tally.model import Ledger, Rule, Source

FileAction = Literal["previewed", "pushed"]

MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE rules (
        id TEXT PRIMARY KEY,
        match TEXT NOT NULL,
        category_id TEXT NOT NULL,
        merchant TEXT NOT NULL,
        created_from TEXT NOT NULL,
        account_id TEXT,
        hits INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE answers (
        descriptor TEXT PRIMARY KEY,
        category_id TEXT NOT NULL,
        merchant TEXT NOT NULL,
        confidence REAL NOT NULL,
        provider TEXT NOT NULL,
        answered_at TEXT NOT NULL
    );
    CREATE TABLE outbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        strings TEXT NOT NULL
    );
    CREATE TABLE files (
        sha256 TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('previewed', 'pushed')),
        at TEXT NOT NULL,
        preview_id TEXT,
        PRIMARY KEY (sha256, action)
    );
    CREATE TABLE snapshots (
        ledger_id TEXT PRIMARY KEY,
        taken_at TEXT NOT NULL,
        body TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE account_map (
        key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        decided_at TEXT NOT NULL
    );
    """,
    """
    CREATE TABLE ocr (
        sha256 TEXT PRIMARY KEY,
        pages TEXT NOT NULL,
        read_at TEXT NOT NULL
    );
    """,
)


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class Answer:
    descriptor: str
    category_id: str
    merchant: str
    confidence: float
    provider: str
    answered_at: datetime

    @classmethod
    def of(cls, result: Result, provider: str, at: datetime | None = None) -> Answer:
        return cls(
            result.descriptor,
            result.category_id,
            result.merchant,
            result.confidence,
            provider,
            at or _now(),
        )

    def result(self) -> Result:
        """A remembered answer replays as a rule: it is not sent again."""
        return Result(
            self.descriptor, self.category_id, self.merchant, self.confidence, Source.rule, "store"
        )


@dataclass(frozen=True)
class OutboundBatch:
    id: int
    sent_at: datetime
    provider: str
    model: str
    strings: tuple[str, ...]


class Store:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.migrate()

    @classmethod
    def open(cls, path: Path) -> Self:
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
        return cls(sqlite3.connect(path))

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def version(self) -> int:
        row = self.conn.execute("PRAGMA user_version").fetchone()
        return int(row[0])

    def migrate(self) -> None:
        for n, sql in enumerate(MIGRATIONS[self.version :], start=self.version + 1):
            self.conn.executescript(f"BEGIN; {sql}; PRAGMA user_version = {n}; COMMIT;")

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self.conn:
            yield self.conn

    def rules(self) -> list[Rule]:
        rows = self.conn.execute(
            "SELECT id, match, category_id, merchant, created_from, account_id, hits"
            " FROM rules ORDER BY id"
        )
        keys = ("id", "match", "category_id", "merchant", "created_from", "account_id", "hits")
        return [Rule.model_validate(dict(zip(keys, r, strict=True))) for r in rows]

    def put_rules(self, rules: Iterable[Rule]) -> int:
        rows = [
            (r.id, r.match, r.category_id, r.merchant, r.created_from, r.account_id, r.hits)
            for r in rules
        ]
        with self._tx() as c:
            c.executemany("INSERT OR REPLACE INTO rules VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
        return len(rows)

    def answers(self) -> dict[str, Answer]:
        rows = self.conn.execute(
            "SELECT descriptor, category_id, merchant, confidence, provider, answered_at"
            " FROM answers ORDER BY descriptor"
        )
        return {
            d: Answer(d, c, m, float(conf), p, datetime.fromisoformat(at))
            for d, c, m, conf, p, at in rows
        }

    def remembered(self) -> list[Result]:
        return [a.result() for a in self.answers().values()]

    def put_answers(self, answers: Iterable[Answer]) -> int:
        rows = [
            (
                a.descriptor,
                a.category_id,
                a.merchant,
                a.confidence,
                a.provider,
                a.answered_at.isoformat(),
            )
            for a in answers
        ]
        with self._tx() as c:
            c.executemany("INSERT OR REPLACE INTO answers VALUES (?, ?, ?, ?, ?, ?)", rows)
        return len(rows)

    def record_outbound(self, provider: str, model: str, strings: Sequence[str]) -> int:
        """Log a batch that left the machine. Descriptor strings only, by construction."""
        with self._tx() as c:
            cur = c.execute(
                "INSERT INTO outbound (sent_at, provider, model, strings) VALUES (?, ?, ?, ?)",
                (_now().isoformat(), provider, model, json.dumps(list(strings))),
            )
        return int(cur.lastrowid or 0)

    def outbound(self) -> list[OutboundBatch]:
        rows = self.conn.execute(
            "SELECT id, sent_at, provider, model, strings FROM outbound ORDER BY id"
        )
        return [
            OutboundBatch(i, datetime.fromisoformat(at), p, m, tuple(json.loads(s)))
            for i, at, p, m, s in rows
        ]

    def mark_file(self, sha256: str, action: FileAction, preview_id: str | None = None) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?)",
                (sha256, action, _now().isoformat(), preview_id),
            )

    def seen(self, sha256: str, action: FileAction) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM files WHERE sha256 = ? AND action = ?", (sha256, action)
        ).fetchone()
        return row is not None

    def account_map(self) -> dict[str, str]:
        """Which ledger account a source resolves to, by `tally.load` key, as decided earlier."""
        rows = self.conn.execute("SELECT key, account_id FROM account_map ORDER BY key")
        return {k: a for k, a in rows}

    def remember_account(self, key: str, account_id: str) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO account_map VALUES (?, ?, ?)",
                (key, account_id, _now().isoformat()),
            )

    def ocr_pages(self, sha256: str) -> list[str] | None:
        """The page texts OCR read from a scan, by the scan's hash, so a scan is read once."""
        row = self.conn.execute("SELECT pages FROM ocr WHERE sha256 = ?", (sha256,)).fetchone()
        return None if row is None else [str(p) for p in json.loads(row[0])]

    def put_ocr_pages(self, sha256: str, pages: Sequence[str]) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO ocr VALUES (?, ?, ?)",
                (sha256, json.dumps(list(pages)), _now().isoformat()),
            )

    def save_snapshot(self, ledger: Ledger) -> None:
        with self._tx() as c:
            c.execute(
                "INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?)",
                (ledger.id, _now().isoformat(), ledger.model_dump_json()),
            )

    def snapshot(self, ledger_id: str | None = None) -> Ledger | None:
        sql = "SELECT body FROM snapshots"
        args: tuple[str, ...] = ()
        if ledger_id is not None:
            sql, args = f"{sql} WHERE ledger_id = ?", (ledger_id,)
        row = self.conn.execute(f"{sql} ORDER BY taken_at DESC LIMIT 1", args).fetchone()
        return None if row is None else Ledger.model_validate_json(row[0])
