import pytest

from tally.parsers import ParseError
from tally.parsers.statements import Page, identify
from tally.parsers.statements.unparsed import PWL


def test_pwl_is_recognised_from_any_page():
    assert identify(["Quarterly report", "PWL Capital Inc."]) is PWL


@pytest.mark.parametrize("family", [PWL])
def test_recognised_families_refuse_to_parse_and_say_which(family):
    with pytest.raises(ParseError, match=f"{family.name} statement: recognised, not parsed"):
        family.parse([Page("anything")], "x.pdf")
