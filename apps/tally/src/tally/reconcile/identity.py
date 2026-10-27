"""Row identity: the normalised descriptor, the dedupe key and the transaction id.

The server derives its HMAC dedupe token from `normalise_descriptor`, so these
rules are a stored format. Changing any of them changes every key; bump
`NORMALISATION_VERSION` when you do, and re-key the ledger.

`normalise_descriptor` applies, in order:

1. Unicode NFKC, then casefold.
2. Apostrophes are deleted, so ``MCDONALD'S`` and ``MCDONALDS`` agree.
3. Masked card numbers are removed wherever they appear: a run of two or more
   ``x``, ``*`` or ``•`` followed by two to four digits (``xxxx1234``,
   ``**** 1234``), and the long form ``1234xxxxxxxx5678``.
4. Store and reference numbers written with a hash are removed wherever they
   appear: ``#1234``, ``# 1234``, ``no.1234``.
5. Trailing reference-like tokens are dropped one at a time while another token
   remains before them: a run of three or more digits, one letter followed by
   three or more digits (``c01234``), a date stamp (``01/15``, ``2017-01-15``),
   a time (``14:05``), or a bare ``ref``/``ref#``/``reference`` label. One and
   two digit tokens are kept, and leading digits are kept (``7-eleven``), since
   those distinguish merchants.
6. Every remaining character that is not a letter or a digit becomes a space,
   and whitespace collapses to single spaces with no ends.

The result is never empty for a non-blank input: if the steps above would
remove everything, the output of step 2 with step 6 applied is returned.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections import Counter
from collections.abc import Iterable
from datetime import date

NORMALISATION_VERSION = 1

_SEP = "\x1f"
_APOSTROPHES = re.compile(r"['\u2018\u2019`]")
_MASKED_CARD = re.compile(
    r"(?<![^\W_])(?:[x*\u2022]{2,}[\s-]?\d{2,4}|\d{4}[x*\u2022]{4,}\d{4})(?![^\W_])"
)
_HASH_REF = re.compile(r"(?:#|\bno\.)\s?\d+\b")
_TRAILING_REF = re.compile(
    r"^(?:\d{3,}|[a-z]\d{3,}|\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?|\d{1,2}:\d{2}(?::\d{2})?"
    r"|ref#?:?|reference:?)$"
)
_NON_WORD = re.compile(r"[\W_]+")


def _letters_and_digits(text: str) -> str:
    return " ".join(_NON_WORD.sub(" ", text).split())


def normalise_descriptor(descriptor: str) -> str:
    folded = _APOSTROPHES.sub("", unicodedata.normalize("NFKC", descriptor).casefold())
    stripped = _HASH_REF.sub(" ", _MASKED_CARD.sub(" ", folded))
    tokens = stripped.split()
    while len(tokens) > 1 and _TRAILING_REF.match(tokens[-1]):
        tokens.pop()
    return _letters_and_digits(" ".join(tokens)) or _letters_and_digits(folded)


def dedupe_key(account_id: str, on: date, cents: int, normalised_descriptor: str) -> str:
    """sha256 hex over the canonical fields. The descriptor must already be normalised."""
    canonical = _SEP.join(
        (f"v{NORMALISATION_VERSION}", account_id, on.isoformat(), str(cents), normalised_descriptor)
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def transaction_id(
    account_id: str, on: date, cents: int, descriptor: str, *, occurrence: int = 0
) -> str:
    """A ledger id that the same row gets from any file.

    `occurrence` is the row's ordinal among the rows of one file that share its
    dedupe key, so two identical coffees in one export get two ids and the same
    two coffees in an overlapping export get the same two ids. A FITID is not
    part of the id because a CSV of the same account carries none.
    """
    if occurrence < 0:
        raise ValueError("occurrence must be non-negative")
    key = dedupe_key(account_id, on, cents, normalise_descriptor(descriptor))
    digest = hashlib.sha256(f"{key}{_SEP}{occurrence}".encode()).hexdigest()
    return f"tx_{digest[:32]}"


def assign_ids(rows: Iterable[tuple[str, date, int, str]]) -> list[str]:
    """Ids for one file's rows, given as (account_id, date, cents, descriptor) in file order."""
    seen: Counter[str] = Counter()
    ids: list[str] = []
    for account_id, on, amount, descriptor in rows:
        key = dedupe_key(account_id, on, amount, normalise_descriptor(descriptor))
        ids.append(transaction_id(account_id, on, amount, descriptor, occurrence=seen[key]))
        seen[key] += 1
    return ids
