import re

from hypothesis import given
from hypothesis import strategies as st

from tally.classify.egress import PLACEHOLDER, pattern, scrub
from tally.classify.rules import normalise


def test_number_shaped_identifiers_are_replaced():
    assert scrub("ACME CAFE ref 998877") == f"ACME CAFE ref {PLACEHOLDER}"
    assert scrub("PAYMENT ****1234 THANKS") == f"PAYMENT {PLACEHOLDER} THANKS"
    assert scrub("CARD 4500xxxxxxxx9012 GAS") == f"CARD {PLACEHOLDER} GAS"
    assert scrub("4500 1234 5678 9012 SHOP") == f"{PLACEHOLDER} SHOP"
    assert scrub("ACCT 12345 67890123") == f"ACCT 12345 {PLACEHOLDER}"


def test_short_numbers_that_name_a_merchant_stay():
    assert scrub("7-ELEVEN 42  HALIFAX") == "7-ELEVEN 42 HALIFAX"
    assert scrub("STORE #0042") == "STORE #0042"


@given(st.from_regex(r"[A-Z ]{0,12}\d{6,14}[A-Z ]{0,12}", fullmatch=True))
def test_no_long_number_survives(descriptor):
    assert not re.search(r"\d{6,}", scrub(descriptor))


@given(st.from_regex(r"[A-Za-z .()*+?]{1,10} \d{6,12}( [A-Za-z]{1,8})?", fullmatch=True))
def test_the_pattern_matches_the_descriptor_it_came_from(descriptor):
    assert re.search(pattern(scrub(descriptor)), normalise(descriptor), re.IGNORECASE)
