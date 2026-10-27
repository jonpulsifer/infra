from datetime import date
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.classify.base import Request
from tally.classify.rules import (
    RuleError,
    RulesClassifier,
    ScopedRequest,
    normalise,
    propose_match,
    rule_from_correction,
    seed_from_ynab,
)
from tally.classify.taxonomy import SEED
from tally.model import Rule, Source, Transaction


def rule(match, category_id="groceries", *, hits=0, account_id=None, id_=None):
    return Rule(
        id=id_ or f"r-{match}-{category_id}",
        match=match,
        category_id=category_id,
        merchant=match.strip("/").title(),
        created_from="seed",
        account_id=account_id,
        hits=hits,
    )


def one(classifier, descriptor, **kw):
    req = ScopedRequest(descriptor=descriptor, **kw) if kw else Request(descriptor=descriptor)
    return classifier.classify([req], SEED)[0]


def test_substring_is_case_insensitive_over_normalised_text():
    c = RulesClassifier([rule("Corner   Grocer")])
    got = one(c, "CORNER GROCER #12 SOMEWHERE")
    assert got is not None
    assert (got.category_id, got.confidence, got.source, got.layer) == (
        "groceries",
        1.0,
        Source.rule,
        "rules",
    )
    assert one(c, "ANOTHER SHOP") is None


def test_regex_when_wrapped_in_slashes():
    c = RulesClassifier([rule(r"/^gas\s?bar \d+/", "fuel")])
    hit = one(c, "Gas Bar 42 TOWN")
    assert hit is not None
    assert hit.category_id == "fuel"
    assert one(c, "THE GAS BAR 42") is None


def test_bad_regex_raises_naming_the_rule():
    with pytest.raises(RuleError, match="r-bad"):
        RulesClassifier([rule("/([/", id_="r-bad")])


def test_longest_match_wins_then_most_hits():
    c = RulesClassifier(
        [
            rule("market", "shopping", hits=50),
            rule("fresh market", "groceries", hits=1),
            rule("fresh", "restaurants", hits=9),
        ]
    )
    got = one(c, "FRESH MARKET 7")
    assert got is not None
    assert got.category_id == "groceries"
    tie = RulesClassifier([rule("abc", "coffee", hits=1), rule("xyz", "pets", hits=3)])
    got = one(tie, "abc xyz")
    assert got is not None
    assert got.category_id == "pets"


def test_account_scoped_rules_apply_only_to_their_account():
    c = RulesClassifier([rule("transfer out", "savings-xfer", account_id="acct-a")])
    assert one(c, "TRANSFER OUT 9") is None
    assert one(c, "TRANSFER OUT 9", account_id="acct-b") is None
    got = one(c, "TRANSFER OUT 9", account_id="acct-a")
    assert got is not None
    assert got.category_id == "savings-xfer"


def test_rules_naming_a_missing_category_answer_nothing():
    assert one(RulesClassifier([rule("shop", "gone")]), "shop") is None


def test_hits_are_counted_per_rule():
    r = rule("tea house", "coffee")
    c = RulesClassifier([r])
    c.classify([Request("TEA HOUSE 1"), Request("tea house 2"), Request("nope")], SEED)
    assert c.hits[r.id] == 2


@pytest.mark.parametrize(
    ("descriptor", "expected"),
    [
        ("CORNER GROCER #0042 SMALLTOWN NS", "corner grocer"),
        ("WIDGET CO*AB12CD", "widget co"),
        ("PIXEL PLACE 12345 CITY", "pixel place"),
        ("BIG SHOP.COM", "big shop.com"),
        ("7-STAR #9", "7-star"),
        ("  ", ""),
    ],
)
def test_propose_match(descriptor, expected):
    assert propose_match(descriptor) == expected


@given(st.text(max_size=60))
def test_proposed_match_is_found_in_its_own_descriptor(descriptor):
    proposed = propose_match(descriptor)
    assert proposed in normalise(descriptor)
    if normalise(descriptor):
        assert proposed


def test_rule_from_correction_matches_the_transaction_again():
    t = Transaction(
        id="t1",
        account_id="acct-a",
        date=date(2020, 1, 1),
        amount=Decimal("-1.00"),
        descriptor="CORNER GROCER #0042 SMALLTOWN NS",
        merchant="Corner Grocer",
        category_id="uncategorized",
        batch_id="b1",
    )
    r = rule_from_correction(t, "groceries")
    assert (r.match, r.category_id, r.merchant, r.created_from, r.account_id) == (
        "corner grocer",
        "groceries",
        "Corner Grocer",
        "correction",
        None,
    )
    assert rule_from_correction(t, "groceries", scope_to_account=True).account_id == "acct-a"
    assert RulesClassifier([r]).match(t.descriptor) == r


def test_seed_from_ynab_keeps_consistent_payees_only():
    rows = {
        ("Corner Grocer", "groceries"): 9,
        ("corner grocer", "restaurants"): 1,
        ("Split Shop", "shopping"): 5,
        ("Split Shop", "gifts"): 5,
        ("Transfer : Savings", "savings-xfer"): 40,
        ("Starting Balance", "salary"): 1,
        ("No Category", ""): 3,
        ("Ab", "coffee"): 4,
    }
    rules = seed_from_ynab(rows)
    assert [(r.match, r.category_id, r.hits, r.created_from) for r in rules] == [
        ("corner grocer", "groceries", 9, "seed")
    ]
    assert rules[0].merchant == "Corner Grocer"


def test_seed_from_ynab_counts_plain_pairs():
    pairs = [("Tea Spot", "coffee")] * 4 + [("Tea Spot", "restaurants")]
    assert [r.category_id for r in seed_from_ynab(pairs)] == ["coffee"]
    assert seed_from_ynab(pairs, min_share=0.9) == []
