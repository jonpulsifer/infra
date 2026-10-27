from datetime import date
from decimal import Decimal

from tally import fx
from tally.model import Account, AccountKind, HoldingSnapshot, Ledger, Member
from tally.report import net_worth_series


def test_usd_converts_at_the_years_average_and_cad_is_untouched():
    assert fx.to_cad(Decimal("100"), "USD", date(2024, 6, 1)) == Decimal("136.98")
    assert fx.to_cad(Decimal("100"), "CAD", date(2024, 6, 1)) == Decimal("100")
    assert fx.usd_cad(date(2099, 1, 1)) == fx.USD_CAD[max(fx.USD_CAD)]
    assert fx.usd_cad(date(1999, 1, 1)) == fx.USD_CAD[min(fx.USD_CAD)]


def test_net_worth_counts_a_usd_plan_in_canadian_dollars():
    ledger = Ledger(
        id="l",
        members=(Member(login="o@example.com", role="owner"),),
        accounts=(
            Account(
                id="plan",
                name="Plan",
                institution="Shareworks",
                kind=AccountKind.investment,
                since=date(2024, 1, 1),
                currency="USD",
            ),
        ),
        categories=(),
        transactions=(),
        holdings=(
            HoldingSnapshot(
                account_id="plan",
                date=date(2024, 3, 31),
                positions=(),
                total=Decimal("1000"),
                origin="statement-pdf",
            ),
        ),
    )
    points = net_worth_series(ledger)
    assert points and points[-1].investments == Decimal("1370")  # js_round, as the web shows it
