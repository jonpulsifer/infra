from decimal import Decimal

from tally.model import cents


def test_cents_rounds_half_up():
    assert cents(Decimal("12.345")) == 1235
    assert cents(Decimal("-0.005")) == -1
    assert cents(Decimal("100")) == 10000
