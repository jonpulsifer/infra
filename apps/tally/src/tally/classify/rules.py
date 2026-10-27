"""Layer 1: the owner's rules. Local, exact, confidence 1.0."""

from __future__ import annotations

import hashlib
import re
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from tally.classify.base import Request, Result
from tally.model import Category, Rule, Source, Transaction

_REFERENCE = re.compile(r"[#\d]")
_TRAILING = " *-/.,:;#"
_YNAB_SYNTHETIC = frozenset(
    {"starting balance", "reconciliation balance adjustment", "manual balance adjustment"}
)
MIN_MATCH = 3


class RuleError(ValueError):
    """A rule cannot be compiled. The message names the rule id, never a descriptor."""


@dataclass(frozen=True)
class ScopedRequest(Request):
    """A Request with the account it came from. Only the rules layer reads `account_id`."""

    account_id: str | None = None


def normalise(descriptor: str) -> str:
    return " ".join(descriptor.casefold().split())


def is_regex(match: str) -> bool:
    return len(match) >= 2 and match.startswith("/") and match.endswith("/")


@dataclass(frozen=True)
class _Compiled:
    rule: Rule
    pattern: re.Pattern[str] | None
    needle: str

    def hit(self, text: str) -> bool:
        if self.pattern is not None:
            return self.pattern.search(text) is not None
        return self.needle in text

    @property
    def rank(self) -> tuple[int, int, bool]:
        return (len(self.needle), self.rule.hits, self.rule.account_id is not None)


def _compile(rule: Rule) -> _Compiled:
    if is_regex(rule.match):
        body = rule.match[1:-1]
        try:
            return _Compiled(rule, re.compile(body, re.IGNORECASE), body)
        except re.error as e:
            raise RuleError(f"rule {rule.id}: bad regex ({e.msg})") from None
    needle = normalise(rule.match)
    if not needle:
        raise RuleError(f"rule {rule.id}: empty match")
    return _Compiled(rule, None, needle)


class RulesClassifier:
    """Substring or /regex/ over the normalised descriptor. Longest match wins, then most hits.

    A rule with an `account_id` applies only to a ScopedRequest from that account.
    `hits` counts what this instance matched, by rule id, for the store to add.
    """

    name = "rules"

    def __init__(self, rules: Iterable[Rule]) -> None:
        self._rules = [_compile(r) for r in rules]
        self.hits: Counter[str] = Counter()

    def match(self, descriptor: str, account_id: str | None = None) -> Rule | None:
        text = normalise(descriptor)
        live = [
            c
            for c in self._rules
            if (c.rule.account_id is None or c.rule.account_id == account_id) and c.hit(text)
        ]
        return max(live, key=lambda c: c.rank).rule if live else None

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        known = {c.id for c in taxonomy}
        out: list[Result | None] = []
        for req in requests:
            rule = self.match(req.descriptor, getattr(req, "account_id", None))
            if rule is None or rule.category_id not in known:
                out.append(None)
                continue
            self.hits[rule.id] += 1
            out.append(
                Result(
                    descriptor=req.descriptor,
                    category_id=rule.category_id,
                    merchant=rule.merchant,
                    confidence=1.0,
                    source=Source.rule,
                    layer=self.name,
                )
            )
        return out


def rule_id(match: str, category_id: str, account_id: str | None = None) -> str:
    key = "\x1f".join((match, category_id, account_id or ""))
    return "r-" + hashlib.sha256(key.encode()).hexdigest()[:12]


def propose_match(descriptor: str) -> str:
    """The descriptor's leading words, cut before the first token carrying a digit or '#'.

    `SHOP NAME #0042 CITY` gives `shop name`; `VENDOR*REF12` gives `vendor`. When that
    leaves nothing (the descriptor starts with a reference), the first word is kept.
    """
    text = normalise(descriptor)
    cut = len(text)
    for token in re.finditer(r"\S+", text):
        word = token.group()
        if not _REFERENCE.search(word):
            continue
        head, star, _ = word.partition("*")
        cut = token.start() + len(head) if star and not _REFERENCE.search(head) else token.start()
        break
    proposed = text[:cut].rstrip(_TRAILING)
    return proposed or (text.split()[0] if text else "")


def rule_from_correction(
    transaction: Transaction, category_id: str, *, scope_to_account: bool = False
) -> Rule:
    match = propose_match(transaction.descriptor)
    account = transaction.account_id if scope_to_account else None
    return Rule(
        id=rule_id(match, category_id, account),
        match=match,
        category_id=category_id,
        merchant=transaction.merchant or match.title(),
        created_from="correction",
        account_id=account,
    )


def seed_from_ynab(
    rows: Mapping[tuple[str, str], int] | Iterable[tuple[str, str]],
    *,
    min_share: float = 0.8,
) -> list[Rule]:
    """One rule per payee whose category holds at least `min_share` of its rows.

    `rows` is either (payee, category_id) pairs, one per register row, or a
    mapping of those pairs to counts. Transfers, YNAB's balance adjustments,
    blank categories and payees shorter than MIN_MATCH make no rule.
    """
    counts: Counter[tuple[str, str]] = Counter(rows)
    by_payee: dict[str, Counter[str]] = defaultdict(Counter)
    spelling: dict[str, Counter[str]] = defaultdict(Counter)
    for (payee, category_id), n in counts.items():
        key = normalise(payee)
        if _seedable(key, category_id):
            by_payee[key][category_id] += n
            spelling[key][payee.strip()] += n
    out: list[Rule] = []
    for key in sorted(by_payee):
        cats = by_payee[key]
        (category_id, n), total = cats.most_common(1)[0], sum(cats.values())
        if n / total < min_share:
            continue
        out.append(
            Rule(
                id=rule_id(key, category_id),
                match=key,
                category_id=category_id,
                merchant=spelling[key].most_common(1)[0][0],
                created_from="seed",
                hits=n,
            )
        )
    return out


def _seedable(key: str, category_id: str) -> bool:
    return (
        bool(category_id.strip())
        and len(key) >= MIN_MATCH
        and not key.startswith("transfer :")
        and key not in _YNAB_SYNTHETIC
        and not is_regex(key)
    )
