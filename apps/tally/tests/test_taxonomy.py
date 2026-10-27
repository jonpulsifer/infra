import pytest
from hypothesis import given
from hypothesis import strategies as st

from tally.classify.taxonomy import (
    SEED,
    YNAB_ROOT,
    TaxonomyError,
    assignable,
    from_ynab,
    merge,
    validate,
    ynab_category_id,
)
from tally.model import Category, Flow

WEB_IDS = {
    "income", "salary", "interest", "refunds", "housing", "mortgage-pay", "rent", "utilities",
    "home", "property-tax", "food", "groceries", "restaurants", "coffee", "transport", "fuel",
    "car", "transit", "living", "shopping", "subscriptions", "health", "kids", "pets", "fun",
    "travel", "entertainment", "hobbies", "gifts", "transfer", "cc-payment", "savings-xfer",
    "invest-xfer", "uncategorized",
}  # fmt: skip


def test_seed_matches_the_web_fixture_and_validates():
    assert {c.id for c in SEED} == WEB_IDS
    assert validate(SEED) == SEED


def test_assignable_is_the_leaves():
    ids = set(assignable(SEED))
    assert "groceries" in ids
    assert "uncategorized" in ids
    assert "food" not in ids


def test_validate_rejects_duplicates_missing_parents_and_flow_mismatch():
    dup = Category(id="food", name="Again", parent_id=None, flow=Flow.expense)
    with pytest.raises(TaxonomyError, match="duplicate"):
        validate([*SEED, dup])
    orphan = Category(id="x", name="X", parent_id="nope", flow=Flow.expense)
    with pytest.raises(TaxonomyError, match="missing parent"):
        validate([*SEED, orphan])
    wrong = Category(id="bonus", name="Bonus", parent_id="income", flow=Flow.expense)
    with pytest.raises(TaxonomyError, match="income"):
        validate([*SEED, wrong])


def test_validate_rejects_cycles():
    a = Category(id="a", name="A", parent_id="b", flow=Flow.expense)
    b = Category(id="b", name="B", parent_id="a", flow=Flow.expense)
    with pytest.raises(TaxonomyError, match="cycle"):
        validate([a, b])


def test_from_ynab_reuses_matching_names_and_nests_the_rest():
    pairs = [
        ("Everyday", "Groceries"),
        ("Food", "Takeout"),
        ("Inflow", "To be Budgeted"),
        ("Odd Group", "Widgets & Gadgets"),
        ("", "Loose"),
        ("", ""),
        ("Odd Group", "Widgets & Gadgets"),
    ]
    extra = {c.id: c for c in from_ynab(pairs)}
    assert ynab_category_id("Everyday", "Groceries") == "groceries"
    assert "groceries" not in extra
    takeout = extra[ynab_category_id("Food", "Takeout") or ""]
    assert takeout.parent_id == "food"
    assert takeout.flow is Flow.expense
    inflow = extra[ynab_category_id("Inflow", "To be Budgeted") or ""]
    assert inflow.parent_id == "income"
    assert inflow.flow is Flow.income
    widgets = extra[ynab_category_id("Odd Group", "Widgets & Gadgets") or ""]
    group = extra[widgets.parent_id or ""]
    assert group.parent_id == YNAB_ROOT
    assert extra[ynab_category_id("", "Loose") or ""].parent_id == YNAB_ROOT
    assert ynab_category_id("", "") is None
    assert len(merge(SEED, extra.values())) == len(SEED) + len(extra)


def test_merge_ignores_restated_seed_and_rejects_conflicts():
    assert merge(SEED, [SEED[0]]) == SEED
    changed = Category(id="food", name="Eats", parent_id=None, flow=Flow.expense)
    with pytest.raises(TaxonomyError, match="conflicts"):
        merge(SEED, [changed])


names = st.text(alphabet=st.characters(categories=("L", "N", "Zs", "P")), max_size=20)


@given(st.lists(st.tuples(names, names), max_size=30))
def test_from_ynab_always_yields_a_valid_tree(pairs):
    extra = from_ynab(pairs)
    tree = merge(SEED, extra)
    ids = {c.id for c in tree}
    for group, name in pairs:
        cid = ynab_category_id(group, name)
        assert cid is None or cid in ids
