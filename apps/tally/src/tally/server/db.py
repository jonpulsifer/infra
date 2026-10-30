"""Storage: numbered SQL migrations, SQLAlchemy Core tables, and the LedgerRepository.

Plaintext columns are ids, batch ids, roles, server-event timestamps and HMAC
tokens. Every row the model defines is one sealed JSON payload, categories
included: no query needs a category name, sealing them keeps one code path,
and a category can name something sensitive. No column holds a transaction
date, not even a coarse one; dashboards aggregate in the app over a whole
decrypted ledger, cached per process and invalidated by the ledger's version
counter, which every write bumps under an optimistic check.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import threading
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

import sqlalchemy as sa
from pydantic import BaseModel
from sqlalchemy.pool import StaticPool

from tally.model import (
    Account,
    BalanceAssertion,
    Category,
    HoldingSnapshot,
    ImportBatch,
    ImportPreview,
    Ledger,
    Member,
    ParsedFile,
    Rule,
    Transaction,
    Valuation,
    cents,
)
from tally.server import crypto
from tally.server.crypto import Keyring, LedgerKeys, WrappedKeys

log = logging.getLogger(__name__)

Role = Literal["owner", "viewer"]
MIGRATIONS = Path(__file__).with_name("migrations")
_PG_MIGRATION_LOCK = 0x7A11


class LedgerNotFoundError(LookupError):
    pass


class ConflictError(Exception):
    """The ledger changed since it was read. Reload and try again."""


metadata = sa.MetaData()


def _sealed(name: str, *extra: sa.Column[Any]) -> sa.Table:
    return sa.Table(
        name,
        metadata,
        sa.Column("ledger_id", sa.Text, sa.ForeignKey("ledgers.id"), primary_key=True),
        sa.Column("id", sa.Text, primary_key=True),
        *extra,
        sa.Column("payload", sa.LargeBinary, nullable=False),
    )


ledgers = sa.Table(
    "ledgers",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("created", sa.Text, nullable=False),
    sa.Column("key_version", sa.Text, nullable=False),
    sa.Column("wrapped_data_key", sa.LargeBinary, nullable=False),
    sa.Column("wrapped_token_key", sa.LargeBinary, nullable=False),
    sa.Column("version", sa.Integer, nullable=False),
)
members = sa.Table(
    "members",
    metadata,
    sa.Column("ledger_id", sa.Text, sa.ForeignKey("ledgers.id"), primary_key=True),
    sa.Column("login", sa.Text, primary_key=True),
    sa.Column("role", sa.Text, nullable=False),
)
accounts = _sealed("accounts")
categories = _sealed("categories")
transactions = _sealed(
    "transactions",
    sa.Column("batch_id", sa.Text, nullable=False),
    sa.Column("dedupe_token", sa.LargeBinary, nullable=False),
    sa.Column("merchant_token", sa.Integer, nullable=False),
)
rules = _sealed("rules")
assertions = _sealed("assertions")
holdings = _sealed("holdings")
valuations = _sealed("valuations")
batches = _sealed("batches")
previews = _sealed("previews", sa.Column("created", sa.Text, nullable=False))
audit = _sealed("audit", sa.Column("created", sa.Text, nullable=False))
tombstones = sa.Table(
    "tombstones",
    metadata,
    sa.Column("ledger_id", sa.Text, sa.ForeignKey("ledgers.id"), primary_key=True),
    sa.Column("transaction_id", sa.Text, primary_key=True),
    sa.Column("dedupe_token", sa.LargeBinary, nullable=False),
    sa.Column("deleted_at", sa.Text, nullable=False),
)
api_tokens = sa.Table(
    "api_tokens",
    metadata,
    sa.Column("id", sa.Text, primary_key=True),
    sa.Column("ledger_id", sa.Text, sa.ForeignKey("ledgers.id"), nullable=False),
    sa.Column("login", sa.Text, nullable=False),
    sa.Column("token_hash", sa.LargeBinary, nullable=False),
    sa.Column("created", sa.Text, nullable=False),
)


def connect(url: str) -> sa.Engine:
    """An engine for a Postgres URL (psycopg) or a SQLite URL (tests and --synthetic)."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url.removeprefix(prefix)
    if not url.startswith("sqlite"):
        return sa.create_engine(url, pool_pre_ping=True)
    memory = url in ("sqlite://", "sqlite:///:memory:")
    engine = sa.create_engine(
        url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool if memory else None,
    )
    sa.event.listen(engine, "connect", _sqlite_pragmas)
    return engine


def _sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


def _statements(sql: str) -> list[str]:
    body = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    return [s.strip() for s in body.split(";") if s.strip()]


def migrate(engine: sa.Engine, directory: Path = MIGRATIONS) -> tuple[str, ...]:
    """Apply every numbered `NNNN_name.sql` not yet recorded, in one transaction."""
    files = sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.sql"))
    with engine.begin() as conn:
        if conn.dialect.name == "postgresql":
            conn.execute(sa.text("SELECT pg_advisory_xact_lock(:k)"), {"k": _PG_MIGRATION_LOCK})
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        done = {r[0] for r in conn.exec_driver_sql("SELECT version FROM schema_migrations")}
        applied: list[str] = []
        for path in files:
            number = int(path.name.split("_", 1)[0])
            if number in done:
                continue
            for statement in _statements(path.read_text()):
                conn.exec_driver_sql(statement)
            conn.execute(
                sa.text("INSERT INTO schema_migrations VALUES (:v, :n, :t)"),
                {"v": number, "n": path.name, "t": _now()},
            )
            applied.append(path.name)
    if applied:
        log.info("applied migrations: %s", ", ".join(applied))
    return tuple(applied)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _canonical(doc: object) -> bytes:
    return json.dumps(doc, sort_keys=True, separators=(",", ":")).encode()


@dataclass(frozen=True)
class _Collection:
    table: sa.Table
    attr: str
    model: type[BaseModel]
    content_keyed: bool = False

    def row_id(self, keys: LedgerKeys, row: BaseModel) -> str:
        if self.content_keyed:
            return crypto.content_id(keys, self.table.name, _canonical(row.model_dump(mode="json")))
        return str(getattr(row, "id"))  # noqa: B009


_COLLECTIONS = (
    _Collection(accounts, "accounts", Account),
    _Collection(categories, "categories", Category),
    _Collection(transactions, "transactions", Transaction),
    _Collection(rules, "rules", Rule),
    _Collection(batches, "batches", ImportBatch),
    _Collection(holdings, "holdings", HoldingSnapshot, content_keyed=True),
    _Collection(valuations, "valuations", Valuation, content_keyed=True),
    _Collection(assertions, "assertions", BalanceAssertion, content_keyed=True),
)


@dataclass(frozen=True)
class Membership:
    ledger_id: str
    role: Role


@dataclass(frozen=True)
class StoredPreview:
    id: str
    created: datetime
    created_by: str
    base_version: int
    files: tuple[ParsedFile, ...]
    preview: ImportPreview


@dataclass(frozen=True)
class AuditEntry:
    id: str
    created: datetime
    classifier: str
    strings: tuple[str, ...]


@dataclass(frozen=True)
class ApiToken:
    id: str
    ledger_id: str
    login: str
    created: datetime


def transaction_dedupe_token(keys: LedgerKeys, txn: Transaction) -> bytes:
    return crypto.dedupe_token(keys, txn.account_id, txn.date, cents(txn.amount), txn.descriptor)


def _hash_secret(secret: str) -> bytes:
    return hashlib.sha256(secret.encode()).digest()


class LedgerRepository:
    """Loads and saves whole ledgers, sealing every row on the way in."""

    def __init__(self, engine: sa.Engine, keyring: Keyring) -> None:
        self.engine = engine
        self.keyring = keyring
        self._keys: dict[str, LedgerKeys] = {}
        self._cache: dict[str, tuple[int, Ledger]] = {}
        self._lock = threading.Lock()

    def create_ledger(self, owner: str, ledger_id: str | None = None) -> str:
        lid = ledger_id or uuid.uuid4().hex
        keys = LedgerKeys.generate(lid)
        wrapped = crypto.wrap(keys, self.keyring)
        with self.engine.begin() as conn:
            conn.execute(
                ledgers.insert().values(
                    id=lid,
                    created=_now(),
                    key_version=wrapped.key_version,
                    wrapped_data_key=wrapped.data_key,
                    wrapped_token_key=wrapped.token_key,
                    version=0,
                )
            )
            conn.execute(members.insert().values(ledger_id=lid, login=owner, role="owner"))
        self._keys[lid] = keys
        log.info("created ledger %s", lid)
        return lid

    def keys(self, ledger_id: str) -> LedgerKeys:
        if found := self._keys.get(ledger_id):
            return found
        with self.engine.connect() as conn:
            row = conn.execute(sa.select(ledgers).where(ledgers.c.id == ledger_id)).one_or_none()
        if row is None:
            raise LedgerNotFoundError(ledger_id)
        keys = crypto.unwrap(
            WrappedKeys(row.id, row.key_version, row.wrapped_data_key, row.wrapped_token_key),
            self.keyring,
        )
        self._keys[ledger_id] = keys
        return keys

    def version(self, ledger_id: str) -> int:
        with self.engine.connect() as conn:
            found = conn.execute(
                sa.select(ledgers.c.version).where(ledgers.c.id == ledger_id)
            ).scalar_one_or_none()
        if found is None:
            raise LedgerNotFoundError(ledger_id)
        return int(found)

    def load(self, ledger_id: str) -> Ledger:
        return self.load_versioned(ledger_id)[1]

    def load_versioned(self, ledger_id: str) -> tuple[int, Ledger]:
        """The ledger and the version it was read at, for `save(expected_version=...)`.

        A ledger with no categories gets the seed tree the first time it is
        read: the engine files rows under `uncategorized` and transfers under
        `transfer`, so an empty tree is never what the owner meant.
        """
        version = self.version(ledger_id)
        cached = self._cache.get(ledger_id)
        if cached and cached[0] == version:
            return cached
        keys = self.keys(ledger_id)
        with self.engine.connect() as conn:
            fields: dict[str, Any] = {c.attr: self._read(conn, keys, c) for c in _COLLECTIONS}
            fields["members"] = self._members(conn, ledger_id)
        ledger = Ledger(id=ledger_id, **fields)
        if not ledger.categories:
            ledger = self._seed_categories(ledger, keys)
            version = self.version(ledger_id)
        self._cache[ledger_id] = (version, ledger)
        return version, ledger

    def _seed_categories(self, ledger: Ledger, keys: LedgerKeys) -> Ledger:
        from tally.classify.taxonomy import SEED

        seeded = ledger.model_copy(update={"categories": SEED})
        column = next(c for c in _COLLECTIONS if c.attr == "categories")
        try:
            with self.engine.begin() as conn:
                self._write(conn, keys, column, ledger, seeded)
                self._bump(conn, ledger.id)
        except sa.exc.IntegrityError:
            # Another reader seeded first; take what it wrote.
            with self.engine.connect() as conn:
                return ledger.model_copy(update={"categories": self._read(conn, keys, column)})
        return seeded

    def _read(self, conn: sa.Connection, keys: LedgerKeys, c: _Collection) -> tuple[Any, ...]:
        rows = conn.execute(
            sa.select(c.table.c.id, c.table.c.payload).where(c.table.c.ledger_id == keys.ledger_id)
        )
        decoded: list[tuple[int, str, BaseModel]] = []
        for row in rows:
            rid = str(row.id)
            doc = json.loads(crypto.open_(keys, c.table.name, "payload", rid, row.payload))
            decoded.append((int(doc["ord"]), rid, c.model.model_validate(doc["row"])))
        decoded.sort(key=lambda d: (d[0], d[1]))
        return tuple(d[2] for d in decoded)

    def _members(self, conn: sa.Connection, ledger_id: str) -> tuple[Member, ...]:
        rows = conn.execute(
            sa.select(members.c.login, members.c.role).where(members.c.ledger_id == ledger_id)
        ).all()
        found = [Member(login=r.login, role=cast(Role, r.role)) for r in rows]
        return tuple(sorted(found, key=lambda m: (m.role != "owner", m.login)))

    def save(self, ledger: Ledger, *, expected_version: int | None = None) -> Ledger:
        """Write the difference between the stored ledger and `ledger`. Members are not saved here.

        A transaction that disappears is tombstoned, so no later import brings it back.
        `expected_version` is the version `ledger` was loaded at: a newer stored
        version raises ConflictError rather than deleting and tombstoning rows
        the caller never saw. None writes over whatever is stored.
        """
        with self._lock:
            base_version, current = self.load_versioned(ledger.id)
            if expected_version is not None and expected_version != base_version:
                raise ConflictError(ledger.id)
            keys = self.keys(ledger.id)
            updates: dict[str, tuple[Any, ...]] = {}
            with self.engine.begin() as conn:
                bumped = conn.execute(
                    ledgers.update()
                    .where(ledgers.c.id == ledger.id, ledgers.c.version == base_version)
                    .values(version=ledgers.c.version + 1)
                )
                if bumped.rowcount != 1:
                    raise ConflictError(ledger.id)
                for c in _COLLECTIONS:
                    updates[c.attr] = self._write(conn, keys, c, current, ledger)
            saved = current.model_copy(update=updates)
            self._cache[ledger.id] = (base_version + 1, saved)
            return saved

    def _write(
        self,
        conn: sa.Connection,
        keys: LedgerKeys,
        c: _Collection,
        current: Ledger,
        target: Ledger,
    ) -> tuple[Any, ...]:
        before = self._indexed(keys, c, getattr(current, c.attr))
        after = self._indexed(keys, c, getattr(target, c.attr))
        if c.table is transactions:
            self._tombstone(conn, keys, [before[r][1] for r in before.keys() - after.keys()])
        for rid in before.keys() - after.keys():
            conn.execute(
                c.table.delete().where(c.table.c.ledger_id == keys.ledger_id, c.table.c.id == rid)
            )
        for rid, (ord_, row) in after.items():
            if before.get(rid) == (ord_, row):
                continue
            values = self._values(keys, c, rid, ord_, row)
            if rid in before:
                conn.execute(
                    c.table.update()
                    .where(c.table.c.ledger_id == keys.ledger_id, c.table.c.id == rid)
                    .values(**values)
                )
            else:
                conn.execute(c.table.insert().values(ledger_id=keys.ledger_id, id=rid, **values))
        return tuple(row for _, row in sorted(after.values(), key=lambda v: v[0]))

    def _indexed(
        self, keys: LedgerKeys, c: _Collection, rows: Sequence[BaseModel]
    ) -> dict[str, tuple[int, BaseModel]]:
        out: dict[str, tuple[int, BaseModel]] = {}
        for ord_, row in enumerate(rows):
            rid = c.row_id(keys, row)
            if rid in out:
                if c.content_keyed:
                    continue
                raise ValueError(f"{c.attr}: duplicate id {rid}")
            out[rid] = (ord_, row)
        return out

    def _values(
        self, keys: LedgerKeys, c: _Collection, rid: str, ord_: int, row: BaseModel
    ) -> dict[str, Any]:
        doc = _canonical({"ord": ord_, "row": row.model_dump(mode="json")})
        values: dict[str, Any] = {"payload": crypto.seal(keys, c.table.name, "payload", rid, doc)}
        if isinstance(row, Transaction):
            values["batch_id"] = row.batch_id
            values["dedupe_token"] = transaction_dedupe_token(keys, row)
            values["merchant_token"] = crypto.merchant_token(keys, row.merchant)
        return values

    def _tombstone(self, conn: sa.Connection, keys: LedgerKeys, gone: Sequence[BaseModel]) -> None:
        for txn in cast(Sequence[Transaction], gone):
            conn.execute(
                tombstones.delete().where(
                    tombstones.c.ledger_id == keys.ledger_id,
                    tombstones.c.transaction_id == txn.id,
                )
            )
            conn.execute(
                tombstones.insert().values(
                    ledger_id=keys.ledger_id,
                    transaction_id=txn.id,
                    dedupe_token=transaction_dedupe_token(keys, txn),
                    deleted_at=_now(),
                )
            )

    def drop_tombstoned(self, base: Ledger, candidate: Ledger) -> tuple[Ledger, int]:
        """Remove from `candidate` every new transaction the owner deleted before."""
        keys = self.keys(base.id)
        with self.engine.connect() as conn:
            rows = conn.execute(
                sa.select(tombstones.c.transaction_id, tombstones.c.dedupe_token).where(
                    tombstones.c.ledger_id == base.id
                )
            ).all()
        dead_ids = {r.transaction_id for r in rows}
        dead_tokens = {bytes(r.dedupe_token) for r in rows}
        known = {t.id for t in base.transactions}

        def buried(t: Transaction) -> bool:
            if t.id in known:
                return False
            return t.id in dead_ids or transaction_dedupe_token(keys, t) in dead_tokens

        kept = tuple(t for t in candidate.transactions if not buried(t))
        dropped = len(candidate.transactions) - len(kept)
        return candidate.model_copy(update={"transactions": kept}), dropped

    def memberships(self, login: str) -> tuple[Membership, ...]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                sa.select(members.c.ledger_id, members.c.role).where(members.c.login == login)
            ).all()
        found = [Membership(r.ledger_id, r.role) for r in rows]
        return tuple(sorted(found, key=lambda m: (m.role != "owner", m.ledger_id)))

    def add_member(self, ledger_id: str, login: str, role: Role) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                members.delete().where(members.c.ledger_id == ledger_id, members.c.login == login)
            )
            conn.execute(members.insert().values(ledger_id=ledger_id, login=login, role=role))
            self._bump(conn, ledger_id)

    def remove_member(self, ledger_id: str, login: str) -> bool:
        with self.engine.begin() as conn:
            gone = conn.execute(
                members.delete().where(
                    members.c.ledger_id == ledger_id,
                    members.c.login == login,
                    members.c.role != "owner",
                )
            )
            conn.execute(
                api_tokens.delete().where(
                    api_tokens.c.ledger_id == ledger_id, api_tokens.c.login == login
                )
            )
            self._bump(conn, ledger_id)
        return bool(gone.rowcount)

    def _bump(self, conn: sa.Connection, ledger_id: str) -> None:
        conn.execute(
            ledgers.update().where(ledgers.c.id == ledger_id).values(version=ledgers.c.version + 1)
        )

    def put_preview(
        self,
        ledger_id: str,
        created_by: str,
        base_version: int,
        files: Sequence[ParsedFile],
        preview: ImportPreview,
    ) -> StoredPreview:
        stored = StoredPreview(
            id=uuid.uuid4().hex,
            created=datetime.now(UTC),
            created_by=created_by,
            base_version=base_version,
            files=tuple(files),
            preview=preview,
        )
        doc = _canonical(
            {
                "by": created_by,
                "base": base_version,
                "files": [f.model_dump(mode="json") for f in stored.files],
                "preview": preview.model_dump(mode="json"),
            }
        )
        self._put_event(previews, ledger_id, stored.id, stored.created, doc)
        return stored

    def get_preview(self, ledger_id: str, preview_id: str) -> StoredPreview | None:
        found = self._get_event(previews, ledger_id, preview_id)
        if found is None:
            return None
        created, doc = found
        return StoredPreview(
            id=preview_id,
            created=created,
            created_by=doc["by"],
            base_version=doc["base"],
            files=tuple(ParsedFile.model_validate(f) for f in doc["files"]),
            preview=ImportPreview.model_validate(doc["preview"]),
        )

    def drop_preview(self, ledger_id: str, preview_id: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                previews.delete().where(
                    previews.c.ledger_id == ledger_id, previews.c.id == preview_id
                )
            )

    def record_audit(self, ledger_id: str, classifier: str, strings: Sequence[str]) -> AuditEntry:
        entry = AuditEntry(uuid.uuid4().hex, datetime.now(UTC), classifier, tuple(strings))
        doc = _canonical({"classifier": classifier, "strings": list(entry.strings)})
        self._put_event(audit, ledger_id, entry.id, entry.created, doc)
        return entry

    def audit_log(self, ledger_id: str) -> tuple[AuditEntry, ...]:
        keys = self.keys(ledger_id)
        with self.engine.connect() as conn:
            rows = conn.execute(sa.select(audit).where(audit.c.ledger_id == ledger_id)).all()
        entries = []
        for r in rows:
            doc = json.loads(crypto.open_(keys, "audit", "payload", r.id, r.payload))
            entries.append(
                AuditEntry(
                    r.id,
                    datetime.fromisoformat(r.created),
                    doc["classifier"],
                    tuple(doc["strings"]),
                )
            )
        return tuple(sorted(entries, key=lambda e: e.created, reverse=True))

    def _put_event(
        self, table: sa.Table, ledger_id: str, rid: str, created: datetime, doc: bytes
    ) -> None:
        payload = crypto.seal(self.keys(ledger_id), table.name, "payload", rid, doc)
        with self.engine.begin() as conn:
            conn.execute(
                table.insert().values(
                    ledger_id=ledger_id, id=rid, created=created.isoformat(), payload=payload
                )
            )

    def _get_event(
        self, table: sa.Table, ledger_id: str, rid: str
    ) -> tuple[datetime, dict[str, Any]] | None:
        with self.engine.connect() as conn:
            row = conn.execute(
                sa.select(table).where(table.c.ledger_id == ledger_id, table.c.id == rid)
            ).one_or_none()
        if row is None:
            return None
        plain = crypto.open_(self.keys(ledger_id), table.name, "payload", rid, row.payload)
        return datetime.fromisoformat(row.created), json.loads(plain)

    def mint_token(self, ledger_id: str, login: str) -> tuple[ApiToken, str]:
        """A bearer secret for the CLI. Only its SHA-256 is stored; the secret is shown once."""
        secret = "tally_" + secrets.token_urlsafe(32)
        token = ApiToken(uuid.uuid4().hex, ledger_id, login, datetime.now(UTC))
        with self.engine.begin() as conn:
            conn.execute(
                api_tokens.insert().values(
                    id=token.id,
                    ledger_id=ledger_id,
                    login=login,
                    token_hash=_hash_secret(secret),
                    created=token.created.isoformat(),
                )
            )
        return token, secret

    def resolve_token(self, secret: str) -> ApiToken | None:
        with self.engine.connect() as conn:
            row = conn.execute(
                sa.select(api_tokens).where(api_tokens.c.token_hash == _hash_secret(secret))
            ).one_or_none()
        if row is None:
            return None
        return ApiToken(row.id, row.ledger_id, row.login, datetime.fromisoformat(row.created))

    def tokens(self, ledger_id: str) -> tuple[ApiToken, ...]:
        with self.engine.connect() as conn:
            rows = conn.execute(
                sa.select(api_tokens).where(api_tokens.c.ledger_id == ledger_id)
            ).all()
        return tuple(
            ApiToken(r.id, r.ledger_id, r.login, datetime.fromisoformat(r.created)) for r in rows
        )

    def revoke_token(self, ledger_id: str, token_id: str) -> bool:
        with self.engine.begin() as conn:
            gone = conn.execute(
                api_tokens.delete().where(
                    api_tokens.c.ledger_id == ledger_id, api_tokens.c.id == token_id
                )
            )
        return bool(gone.rowcount)

    def rotate(self, new_master: str) -> int:
        """Rewrap every ledger's keys under `new_master`. Sealed rows are untouched."""
        self.keyring.master(new_master)
        changed = 0
        with self.engine.begin() as conn:
            rows = conn.execute(sa.select(ledgers).where(ledgers.c.key_version != new_master))
            for r in rows.all():
                old = WrappedKeys(r.id, r.key_version, r.wrapped_data_key, r.wrapped_token_key)
                new = crypto.rewrap(old, self.keyring, new_master)
                conn.execute(
                    ledgers.update()
                    .where(ledgers.c.id == r.id)
                    .values(
                        key_version=new.key_version,
                        wrapped_data_key=new.data_key,
                        wrapped_token_key=new.token_key,
                    )
                )
                changed += 1
        self.keyring = self.keyring.with_active(new_master)
        return changed
