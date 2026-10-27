import base64
import json
from dataclasses import replace
from datetime import date

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.server import crypto
from tally.server.crypto import Keyring, KeyringError, LedgerKeys, TamperedError

MASTER = bytes(range(32))
KEYRING = Keyring(active="v1", keys={"v1": MASTER})
KEYS = LedgerKeys(ledger_id="ledger-a", data=bytes(32), token=bytes(range(1, 33)))


def keyring_json(active: str, **keys: bytes) -> str:
    return json.dumps(
        {"active": active, "keys": {v: base64.b64encode(k).decode() for v, k in keys.items()}}
    )


def test_keyring_reads_json():
    ring = Keyring.from_json(keyring_json("v2", v1=MASTER, v2=bytes(32)))
    assert ring.active == "v2"
    assert ring.master("v1") == MASTER


def test_keyring_reads_a_mounted_file(tmp_path):
    path = tmp_path / "keyring.json"
    path.write_text(keyring_json("v1", v1=MASTER))
    assert Keyring.from_env({"TALLY_KEYRING_FILE": str(path)}).master("v1") == MASTER


def test_keyring_env_beats_file(tmp_path):
    env = {"TALLY_KEYRING": keyring_json("v9", v9=MASTER), "TALLY_KEYRING_FILE": "/nonexistent"}
    assert Keyring.from_env(env).active == "v9"


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        json.dumps({"keys": {}}),
        json.dumps({"active": "v1", "keys": {"v1": "!!!"}}),
        keyring_json("v1", v1=b"short"),
        keyring_json("v2", v1=MASTER),
    ],
)
def test_bad_keyrings_are_refused_without_echoing_keys(text):
    with pytest.raises(KeyringError) as err:
        Keyring.from_json(text)
    assert base64.b64encode(MASTER).decode() not in str(err.value)


def test_no_keyring_is_an_error():
    with pytest.raises(KeyringError):
        Keyring.from_env({})


def test_keys_do_not_appear_in_repr():
    assert MASTER.hex() not in repr(KEYRING)
    assert str(MASTER) not in repr(KEYRING)
    assert str(KEYS.data) not in repr(KEYS)


@given(st.binary(max_size=4096))
def test_seal_round_trips(plaintext):
    blob = crypto.seal(KEYS, "transactions", "payload", "t1", plaintext)
    assert crypto.open_(KEYS, "transactions", "payload", "t1", blob) == plaintext


@given(st.text(max_size=200))
def test_sealed_text_holds_no_plaintext(text):
    raw = text.encode()
    blob = crypto.seal(KEYS, "transactions", "payload", "t1", raw)
    assert len(raw) < 4 or raw not in blob


def test_two_seals_of_one_value_differ():
    one = crypto.seal(KEYS, "accounts", "payload", "a", b"same")
    two = crypto.seal(KEYS, "accounts", "payload", "a", b"same")
    assert one != two


@pytest.mark.parametrize(
    ("ledger", "table", "column", "row"),
    [
        ("ledger-b", "transactions", "payload", "t1"),
        ("ledger-a", "accounts", "payload", "t1"),
        ("ledger-a", "transactions", "other", "t1"),
        ("ledger-a", "transactions", "payload", "t2"),
    ],
)
def test_wrong_associated_data_fails(ledger, table, column, row):
    blob = crypto.seal(KEYS, "transactions", "payload", "t1", b"secret")
    with pytest.raises(TamperedError):
        crypto.open_(replace(KEYS, ledger_id=ledger), table, column, row, blob)


def test_flipped_byte_fails():
    blob = bytearray(crypto.seal(KEYS, "transactions", "payload", "t1", b"secret"))
    blob[-1] ^= 1
    with pytest.raises(TamperedError):
        crypto.open_(KEYS, "transactions", "payload", "t1", bytes(blob))


def test_unknown_format_fails():
    blob = crypto.seal(KEYS, "transactions", "payload", "t1", b"secret")
    with pytest.raises(TamperedError):
        crypto.open_(KEYS, "transactions", "payload", "t1", b"\x02" + blob[1:])


def test_wrong_data_key_fails():
    blob = crypto.seal(KEYS, "transactions", "payload", "t1", b"secret")
    other = replace(KEYS, data=bytes(range(32, 64)))
    with pytest.raises(TamperedError):
        crypto.open_(other, "transactions", "payload", "t1", blob)


def test_wrap_round_trips():
    keys = LedgerKeys.generate("ledger-a")
    assert crypto.unwrap(crypto.wrap(keys, KEYRING), KEYRING) == keys


def test_wrapped_keys_are_bound_to_their_ledger():
    wrapped = crypto.wrap(LedgerKeys.generate("ledger-a"), KEYRING)
    with pytest.raises(TamperedError):
        crypto.unwrap(replace(wrapped, ledger_id="ledger-b"), KEYRING)


def test_wrapped_keys_are_bound_to_their_purpose():
    wrapped = crypto.wrap(LedgerKeys.generate("ledger-a"), KEYRING)
    swapped = replace(wrapped, data_key=wrapped.token_key, token_key=wrapped.data_key)
    with pytest.raises(TamperedError):
        crypto.unwrap(swapped, KEYRING)


def test_wrapped_keys_are_bound_to_their_master_version():
    ring = Keyring(active="v1", keys={"v1": MASTER, "v2": MASTER})
    wrapped = crypto.wrap(LedgerKeys.generate("ledger-a"), ring)
    with pytest.raises(TamperedError):
        crypto.unwrap(replace(wrapped, key_version="v2"), ring)


def test_rewrap_keeps_sealed_rows_readable_after_the_old_master_is_gone():
    keys = LedgerKeys.generate("ledger-a")
    blob = crypto.seal(keys, "transactions", "payload", "t1", b"kept")
    both = Keyring(active="v1", keys={"v1": MASTER, "v2": bytes(range(100, 132))})
    rotated = crypto.rewrap(crypto.wrap(keys, both), both, "v2")
    assert rotated.key_version == "v2"
    only_new = Keyring(active="v2", keys={"v2": both.master("v2")})
    reopened = crypto.unwrap(rotated, only_new)
    assert crypto.open_(reopened, "transactions", "payload", "t1", blob) == b"kept"


def test_unwrap_needs_the_version_the_row_names():
    wrapped = crypto.wrap(LedgerKeys.generate("ledger-a"), KEYRING)
    with pytest.raises(KeyringError):
        crypto.unwrap(wrapped, Keyring(active="v2", keys={"v2": MASTER}))


def test_dedupe_token_is_stable_and_normalised():
    one = crypto.dedupe_token(KEYS, "acct", date(2031, 5, 6), -1234, "Invented  Store 7")
    two = crypto.dedupe_token(KEYS, "acct", date(2031, 5, 6), -1234, "INVENTED STORE 7")
    assert one == two
    assert len(one) == 32


@pytest.mark.parametrize(
    "change",
    [
        {"account_id": "other"},
        {"on": date(2031, 5, 7)},
        {"cents": -1235},
        {"descriptor": "Another Store"},
    ],
)
def test_dedupe_token_changes_with_any_field(change):
    base = {"account_id": "acct", "on": date(2031, 5, 6), "cents": -1234, "descriptor": "Store"}
    assert crypto.dedupe_token(KEYS, **base) != crypto.dedupe_token(KEYS, **{**base, **change})


def test_tokens_differ_between_ledgers():
    other = LedgerKeys.generate("ledger-b")
    args = ("acct", date(2031, 5, 6), -1234, "Store")
    assert crypto.dedupe_token(KEYS, *args) != crypto.dedupe_token(other, *args)


@given(st.text(min_size=1, max_size=80))
def test_merchant_token_is_twelve_bits(merchant):
    token = crypto.merchant_token(KEYS, merchant)
    assert 0 <= token < 2**crypto.MERCHANT_TOKEN_BITS


def test_merchant_token_coincides_on_purpose():
    tokens = {crypto.merchant_token(KEYS, f"invented merchant {i}") for i in range(10_000)}
    assert len(tokens) <= 2**crypto.MERCHANT_TOKEN_BITS
    assert crypto.merchant_token(KEYS, "Café Nowhere") == crypto.merchant_token(
        KEYS, "café  nowhere"
    )
