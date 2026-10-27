"""The category tree.

`SEED` mirrors CATEGORIES in apps/tally/web/src/fixtures/generate.ts; the two
move together. A child always shares its parent's flow.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence

from tally.model import Category, Flow


class TaxonomyError(ValueError):
    """The tree is malformed: a duplicate id, a dangling parent or a flow mismatch."""


def _c(id_: str, name: str, parent: str | None, flow: Flow) -> Category:
    return Category(id=id_, name=name, parent_id=parent, flow=flow)


_I, _E, _T = Flow.income, Flow.expense, Flow.transfer

SEED: tuple[Category, ...] = (
    _c("income", "Income", None, _I),
    _c("salary", "Salary", "income", _I),
    _c("interest", "Interest & dividends", "income", _I),
    _c("refunds", "Refunds", "income", _I),
    _c("housing", "Housing", None, _E),
    _c("mortgage-pay", "Mortgage", "housing", _E),
    _c("rent", "Rent", "housing", _E),
    _c("utilities", "Utilities", "housing", _E),
    _c("home", "Home & repairs", "housing", _E),
    _c("property-tax", "Property tax", "housing", _E),
    _c("food", "Food", None, _E),
    _c("groceries", "Groceries", "food", _E),
    _c("restaurants", "Restaurants", "food", _E),
    _c("coffee", "Coffee", "food", _E),
    _c("transport", "Transport", None, _E),
    _c("fuel", "Fuel", "transport", _E),
    _c("car", "Car & insurance", "transport", _E),
    _c("transit", "Transit & taxis", "transport", _E),
    _c("living", "Living", None, _E),
    _c("shopping", "Shopping", "living", _E),
    _c("subscriptions", "Subscriptions", "living", _E),
    _c("health", "Health", "living", _E),
    _c("kids", "Kids", "living", _E),
    _c("pets", "Pets", "living", _E),
    _c("fun", "Fun", None, _E),
    _c("travel", "Travel", "fun", _E),
    _c("entertainment", "Entertainment", "fun", _E),
    _c("hobbies", "Hobbies & homelab", "fun", _E),
    _c("gifts", "Gifts & giving", "fun", _E),
    _c("transfer", "Transfer", None, _T),
    _c("cc-payment", "Credit card payment", "transfer", _T),
    _c("savings-xfer", "To savings", "transfer", _T),
    _c("invest-xfer", "To investments", "transfer", _T),
    _c("uncategorized", "Uncategorized", None, _E),
)

YNAB_ROOT = "ynab"
_YNAB_INFLOW_GROUP = "inflow"


def validate(categories: Sequence[Category]) -> tuple[Category, ...]:
    by_id: dict[str, Category] = {}
    for c in categories:
        if c.id in by_id:
            raise TaxonomyError(f"duplicate category id {c.id!r}")
        by_id[c.id] = c
    for c in categories:
        if c.parent_id is None:
            continue
        parent = by_id.get(c.parent_id)
        if parent is None:
            raise TaxonomyError(f"{c.id!r} names a missing parent {c.parent_id!r}")
        if parent.flow != c.flow:
            raise TaxonomyError(f"{c.id!r} is {c.flow} under {parent.id!r}, which is {parent.flow}")
    for c in categories:
        seen: set[str] = set()
        node: Category | None = c
        while node is not None and node.parent_id is not None:
            if node.id in seen:
                raise TaxonomyError(f"{c.id!r} sits in a parent cycle")
            seen.add(node.id)
            node = by_id.get(node.parent_id)
    return tuple(categories)


def assignable(categories: Sequence[Category]) -> tuple[str, ...]:
    """Ids a transaction may carry: every category with no children."""
    parents = {c.parent_id for c in categories if c.parent_id is not None}
    return tuple(c.id for c in categories if c.id not in parents)


def merge(seed: Sequence[Category], extra: Iterable[Category]) -> tuple[Category, ...]:
    """Seed first, then each extra the seed lacks. Restating a seed category verbatim is a no-op."""
    out = list(seed)
    known = {c.id: c for c in seed}
    for c in extra:
        prior = known.get(c.id)
        if prior is None:
            out.append(c)
            known[c.id] = c
        elif prior != c:
            raise TaxonomyError(f"{c.id!r} conflicts with an existing category")
    return validate(out)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", _fold(text)).strip("-")


def _fold(text: str) -> str:
    return " ".join(text.replace("&", " and ").casefold().split())


def ynab_category_id(group: str, name: str, seed: Sequence[Category] = SEED) -> str | None:
    """Where one YNAB "Category Group"/"Category" pair lands, or None for an uncategorised row."""
    if not name.strip():
        return None
    by_name = {_fold(c.name): c.id for c in seed}
    if (hit := by_name.get(_fold(name))) is not None:
        return hit
    return "-".join(p for p in ("ynab", slug(group), slug(name)) if p)


def from_ynab(
    groups_and_categories: Iterable[tuple[str, str]], seed: Sequence[Category] = SEED
) -> list[Category]:
    """The categories a YNAB register needs beyond `seed`.

    A category whose name matches a seed category reuses it and adds nothing.
    Otherwise it goes under the seed top level whose name matches its group,
    under Income when the group is YNAB's Inflow, and under a "YNAB" top level
    (with one node per group) when nothing matches.
    """
    tops = {_fold(c.name): c for c in seed if c.parent_id is None}
    by_id = {c.id: c for c in seed}
    out: dict[str, Category] = {}

    def add(c: Category) -> None:
        if c.id not in by_id and c.id not in out:
            out[c.id] = c

    for group, name in groups_and_categories:
        cid = ynab_category_id(group, name, seed)
        if cid is None or cid in by_id:
            continue
        parent = _ynab_parent(group, tops)
        if parent is None:
            root = _c(YNAB_ROOT, "YNAB", None, Flow.expense)
            add(root)
            parent = root
            if slug(group):
                parent = _c(f"ynab-group-{slug(group)}", group.strip(), YNAB_ROOT, Flow.expense)
                add(parent)
        add(_c(cid, name.strip(), parent.id, parent.flow))
    validate([*seed, *out.values()])
    return list(out.values())


def _ynab_parent(group: str, tops: dict[str, Category]) -> Category | None:
    folded = _fold(group)
    if folded == _YNAB_INFLOW_GROUP:
        return next((c for c in tops.values() if c.flow is Flow.income), None)
    return tops.get(folded)
