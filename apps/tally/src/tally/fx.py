"""Foreign exchange for the few accounts that are not in Canadian dollars.

A rough rate is the owner's call: a US-dollar holding converts at the Bank of
Canada's annual average for its year, and a year the table lacks takes the
nearest it has. The ledger stores every amount in its account's currency;
only the reports convert, so a better rate later changes no stored row.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from tally.model import Currency

# Bank of Canada annual average, Canadian dollars per US dollar.
USD_CAD: dict[int, Decimal] = {
    2015: Decimal("1.2787"),
    2016: Decimal("1.3248"),
    2017: Decimal("1.2986"),
    2018: Decimal("1.2957"),
    2019: Decimal("1.3269"),
    2020: Decimal("1.3415"),
    2021: Decimal("1.2535"),
    2022: Decimal("1.3013"),
    2023: Decimal("1.3497"),
    2024: Decimal("1.3698"),
    2025: Decimal("1.3977"),
}


def usd_cad(on: date) -> Decimal:
    """Canadian dollars per US dollar for the year of `on`, or the nearest year known."""
    if on.year in USD_CAD:
        return USD_CAD[on.year]
    nearest = min(USD_CAD, key=lambda y: (abs(y - on.year), -y))
    return USD_CAD[nearest]


def to_cad(amount: Decimal, currency: Currency, on: date) -> Decimal:
    if currency == "CAD":
        return amount
    return (amount * usd_cad(on)).quantize(Decimal("0.01"))
