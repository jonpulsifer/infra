import pytest

from tally.parsers import ParseError
from tally.parsers.statements import Page, identify
from tally.parsers.statements.unparsed import PWL, SHAREWORKS


def test_shareworks_is_recognised_from_any_page():
    texts = ["Statement of Account", "Issued through Solium Capital"]
    assert identify(texts) is SHAREWORKS


def test_pwl_is_recognised():
    assert identify(["PWL Capital Inc. quarterly report"]) is PWL


@pytest.mark.parametrize("family", [SHAREWORKS, PWL])
def test_recognised_families_refuse_to_parse_and_say_which(family):
    with pytest.raises(ParseError, match=f"{family.name} statement: recognised, not parsed"):
        family.parse([Page("anything")], "x.pdf")
