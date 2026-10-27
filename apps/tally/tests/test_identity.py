from datetime import date

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.reconcile.identity import (
    assign_ids,
    dedupe_key,
    normalise_descriptor,
    transaction_id,
)

D = date(2021, 3, 4)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  BEAN  BARN   ", "bean barn"),
        ("Bean Barn #0412", "bean barn"),
        ("BEAN BARN # 412 SPRINGFIELD", "bean barn springfield"),
        ("BEAN BARN 004412", "bean barn"),
        ("BEAN BARN 004412 03/04", "bean barn"),
        ("BEAN BARN 2021-03-04 14:05", "bean barn"),
        ("BEAN BARN C01234", "bean barn"),
        ("BEAN BARN REF 99881", "bean barn"),
        ("ACME HARDWARE XXXX4242", "acme hardware"),
        ("ACME HARDWARE **** 4242 ONLINE", "acme hardware online"),
        ("ACME 4111XXXXXXXX4242 HARDWARE", "acme hardware"),
        ("FRY'S PIES", "frys pies"),
        ("FRY\u2019S PIES", "frys pies"),
        ("7-ELEVEN STORE", "7 eleven store"),
        ("CINEMA 12", "cinema 12"),
        ("PETRO-CANADA", "petro canada"),
        ("\uff26\uff35\uff2c\uff2c WIDTH", "full width"),
        ("123456", "123456"),
        ("#4412", "4412"),
    ],
)
def test_normalise_descriptor(raw, expected):
    assert normalise_descriptor(raw) == expected


def test_normalise_is_idempotent_on_examples():
    for raw in ("Bean Barn #0412 03/04", "7-ELEVEN STORE 00123", "ACME XXXX4242"):
        once = normalise_descriptor(raw)
        assert normalise_descriptor(once) == once


@given(st.text(max_size=60))
def test_normalise_never_empties_a_meaningful_string(raw):
    out = normalise_descriptor(raw)
    assert out == out.strip()
    assert "  " not in out
    if any(c.isalnum() for c in raw):
        assert out


def test_dedupe_key_is_sha256_hex_and_field_sensitive():
    key = dedupe_key("acct-a", D, -450, "bean barn")
    assert len(key) == 64
    assert int(key, 16) >= 0
    assert key == dedupe_key("acct-a", D, -450, "bean barn")
    assert key != dedupe_key("acct-b", D, -450, "bean barn")
    assert key != dedupe_key("acct-a", date(2021, 3, 5), -450, "bean barn")
    assert key != dedupe_key("acct-a", D, -451, "bean barn")
    assert key != dedupe_key("acct-a", D, -450, "bean barns")


def test_dedupe_key_fields_cannot_bleed_into_each_other():
    assert dedupe_key("a", D, -1, "1 x") != dedupe_key("a", D, -11, " x")


def test_transaction_id_ignores_cosmetic_descriptor_changes():
    a = transaction_id("acct-a", D, -450, "BEAN BARN #0412")
    b = transaction_id("acct-a", D, -450, "Bean  Barn")
    assert a == b
    assert a.startswith("tx_")


def test_transaction_id_occurrence_separates_identical_rows():
    first = transaction_id("acct-a", D, -450, "BEAN BARN")
    second = transaction_id("acct-a", D, -450, "BEAN BARN", occurrence=1)
    assert first != second
    with pytest.raises(ValueError):
        transaction_id("acct-a", D, -450, "BEAN BARN", occurrence=-1)


def test_assign_ids_same_rows_from_two_files_get_the_same_ids():
    coffee = ("acct-a", D, -450, "BEAN BARN")
    lunch = ("acct-a", D, -1299, "NOODLE HOUSE")
    file_one = assign_ids([coffee, coffee, lunch])
    file_two = assign_ids([lunch, ("acct-a", D, -450, "Bean Barn #77"), coffee])
    assert len(set(file_one)) == 3
    assert set(file_one) == set(file_two)
