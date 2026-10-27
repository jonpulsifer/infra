"""Sealed rows: AES-256-GCM under a per-ledger data key wrapped by a versioned master key.

The design is .agent/wayfinder/tally/assets/06-encryption-on-cnpg.md. Every
blob starts with a format byte. A row's associated data binds the ledger,
table, column and row id, so a ciphertext cannot be moved between rows or
columns. A wrapped key's associated data binds the ledger, the key's purpose
and the master key version, so a key cannot be moved between ledgers or
relabelled with another version.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import unicodedata
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date
from functools import cached_property
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

FORMAT = 1
KEY_BYTES = 32
NONCE_BYTES = 12
MERCHANT_TOKEN_BITS = 12


class KeyringError(Exception):
    """The keyring is missing or malformed. The message never holds key material."""


class TamperedError(Exception):
    """A blob did not open: wrong key, wrong associated data, or altered bytes."""


@dataclass(frozen=True)
class Keyring:
    active: str
    keys: Mapping[str, bytes] = field(repr=False)

    def __post_init__(self) -> None:
        if self.active not in self.keys:
            raise KeyringError(f"active master key {self.active!r} is not in the keyring")
        for version, key in self.keys.items():
            if len(key) != KEY_BYTES:
                raise KeyringError(f"master key {version!r} is not {KEY_BYTES} bytes")

    def master(self, version: str) -> bytes:
        try:
            return self.keys[version]
        except KeyError:
            raise KeyringError(f"master key {version!r} is not in the keyring") from None

    def with_active(self, version: str) -> Keyring:
        return Keyring(active=version, keys=self.keys)

    @classmethod
    def from_json(cls, text: str) -> Keyring:
        try:
            doc = json.loads(text)
            keys = {str(v): base64.b64decode(k, validate=True) for v, k in doc["keys"].items()}
            return cls(active=str(doc["active"]), keys=keys)
        except (ValueError, KeyError, TypeError, AttributeError, binascii.Error) as err:
            raise KeyringError(
                'keyring must be {"active": "<version>", "keys": {"<version>": "<base64>"}}'
            ) from err

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> Keyring:
        if text := environ.get("TALLY_KEYRING"):
            return cls.from_json(text)
        if path := environ.get("TALLY_KEYRING_FILE"):
            try:
                return cls.from_json(Path(path).read_text())
            except OSError as err:
                raise KeyringError(f"cannot read TALLY_KEYRING_FILE: {err.strerror}") from err
        raise KeyringError("set TALLY_KEYRING or TALLY_KEYRING_FILE")

    @classmethod
    def generate(cls, version: str = "v1") -> Keyring:
        return cls(active=version, keys={version: os.urandom(KEY_BYTES)})


@dataclass(frozen=True)
class LedgerKeys:
    """A ledger's unwrapped keys. Lives in process memory only."""

    ledger_id: str
    data: bytes = field(repr=False)
    token: bytes = field(repr=False)

    @cached_property
    def dedupe(self) -> bytes:
        return _derive(self.token, b"tally dedupe v1")

    @cached_property
    def merchant(self) -> bytes:
        return _derive(self.token, b"tally merchant v1")

    @cached_property
    def content(self) -> bytes:
        return _derive(self.token, b"tally content-id v1")

    @classmethod
    def generate(cls, ledger_id: str) -> LedgerKeys:
        return cls(ledger_id=ledger_id, data=os.urandom(KEY_BYTES), token=os.urandom(KEY_BYTES))


@dataclass(frozen=True)
class WrappedKeys:
    """A ledger's keys as the ledgers table stores them."""

    ledger_id: str
    key_version: str
    data_key: bytes
    token_key: bytes


def _derive(key: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=KEY_BYTES, salt=None, info=info).derive(key)


def _encrypt(key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    nonce = os.urandom(NONCE_BYTES)
    return bytes([FORMAT]) + nonce + AESGCM(key).encrypt(nonce, plaintext, aad)


def _decrypt(key: bytes, blob: bytes, aad: bytes) -> bytes:
    if len(blob) < 1 + NONCE_BYTES + 16 or blob[0] != FORMAT:
        raise TamperedError("blob has an unknown format")
    nonce, body = blob[1 : 1 + NONCE_BYTES], blob[1 + NONCE_BYTES :]
    try:
        return AESGCM(key).decrypt(nonce, body, aad)
    except InvalidTag:
        raise TamperedError("blob does not open under this key and associated data") from None


def _wrap_aad(ledger_id: str, purpose: str, version: str) -> bytes:
    return json.dumps(["tally/wrap", FORMAT, ledger_id, purpose, version]).encode()


def _row_aad(ledger_id: str, table: str, column: str, row_id: str) -> bytes:
    return json.dumps(["tally/row", FORMAT, ledger_id, table, column, row_id]).encode()


def wrap(keys: LedgerKeys, keyring: Keyring) -> WrappedKeys:
    version = keyring.active
    master = keyring.master(version)
    return WrappedKeys(
        ledger_id=keys.ledger_id,
        key_version=version,
        data_key=_encrypt(master, keys.data, _wrap_aad(keys.ledger_id, "data", version)),
        token_key=_encrypt(master, keys.token, _wrap_aad(keys.ledger_id, "token", version)),
    )


def unwrap(wrapped: WrappedKeys, keyring: Keyring) -> LedgerKeys:
    version = wrapped.key_version
    master = keyring.master(version)
    lid = wrapped.ledger_id
    return LedgerKeys(
        ledger_id=lid,
        data=_decrypt(master, wrapped.data_key, _wrap_aad(lid, "data", version)),
        token=_decrypt(master, wrapped.token_key, _wrap_aad(lid, "token", version)),
    )


def rewrap(wrapped: WrappedKeys, keyring: Keyring, new_master: str | None = None) -> WrappedKeys:
    """Unwrap under the version the row names, wrap under `new_master` (default: active).

    No sealed row changes: rows are sealed under the data key, which survives.
    """
    target = keyring.with_active(new_master) if new_master else keyring
    return wrap(unwrap(wrapped, keyring), target)


def seal(keys: LedgerKeys, table: str, column: str, row_id: str, plaintext: bytes) -> bytes:
    return _encrypt(keys.data, plaintext, _row_aad(keys.ledger_id, table, column, row_id))


def open_(keys: LedgerKeys, table: str, column: str, row_id: str, blob: bytes) -> bytes:
    return _decrypt(keys.data, blob, _row_aad(keys.ledger_id, table, column, row_id))


def _fallback_normalise(descriptor: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", descriptor).casefold().split())


def _normaliser() -> Callable[[str], str]:
    try:
        from tally.reconcile.identity import normalise_descriptor
    except ImportError:
        return _fallback_normalise
    return normalise_descriptor


def dedupe_token(keys: LedgerKeys, account_id: str, on: date, cents: int, descriptor: str) -> bytes:
    """Full-width HMAC: equal only for the same account, day, cents and normalised descriptor."""
    message = json.dumps([account_id, on.isoformat(), cents, _normaliser()(descriptor)])
    return hmac.new(keys.dedupe, message.encode(), hashlib.sha256).digest()


def merchant_token(keys: LedgerKeys, merchant: str) -> int:
    """A deliberately coincident 12-bit blind index over the normalised merchant."""
    digest = hmac.new(keys.merchant, _normaliser()(merchant).encode(), hashlib.sha256).digest()
    return int.from_bytes(digest[:2], "big") >> (16 - MERCHANT_TOKEN_BITS)


def content_id(keys: LedgerKeys, table: str, canonical: bytes) -> str:
    """A stable row id for rows the model gives no id (holdings, valuations, assertions)."""
    return hmac.new(keys.content, table.encode() + b"\0" + canonical, hashlib.sha256).hexdigest()[
        :32
    ]
