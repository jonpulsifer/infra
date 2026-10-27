import json

import httpx
import pytest

from tally.classify.base import Request
from tally.classify.cascade import CascadeConfig, build
from tally.classify.providers import ProviderUnavailableError
from tally.classify.providers.fake import FakeAnswer, FakeProvider
from tally.classify.taxonomy import SEED
from tally.model import Rule, Source

RULE = Rule(
    id="r-1",
    match="corner grocer",
    category_id="groceries",
    merchant="Corner Grocer",
    created_from="seed",
)


def reqs(*strings):
    return [Request(descriptor=s) for s in strings]


def fake_config(**kw):
    return CascadeConfig(provider="fake", **kw)


def test_rule_answers_before_the_provider_is_called():
    cascade = build(fake_config(), [RULE])
    got = cascade.classify(reqs("CORNER GROCER #9"), SEED)
    assert got[0] is not None
    assert (got[0].layer, got[0].source) == ("rules", Source.rule)
    assert isinstance(cascade.provider, FakeProvider)
    assert cascade.provider.calls == []
    assert cascade.outbound == []
    assert cascade.audit.batches == ()


def test_low_confidence_answer_is_still_returned():
    answers = {"tea spot": FakeAnswer("coffee", "Tea Spot", 0.3)}
    cascade = build(fake_config(threshold=0.8, fake_answers=answers))
    (got,) = cascade.classify(reqs("TEA SPOT 4"), SEED)
    assert got is not None
    assert (got.category_id, got.confidence, got.layer) == ("coffee", 0.3, "fake")
    assert got.confidence < cascade.threshold


def test_each_unique_descriptor_leaves_at_most_once():
    cascade = build(fake_config(), [RULE])
    batch = reqs("TEA SPOT 4", "PIXEL PLACE", "TEA SPOT 4", "CORNER GROCER 1")
    first = cascade.classify(batch, SEED)
    second = cascade.classify(reqs("PIXEL PLACE", "TEA SPOT 4"), SEED)
    assert all(first) and all(second)
    assert cascade.audit.strings() == ("TEA SPOT 4", "PIXEL PLACE")
    assert sorted(cascade.outbound) == ["PIXEL PLACE", "TEA SPOT 4"]
    assert {r.layer for r in second if r} == {"memory"}
    assert set(cascade.answers()) == {"TEA SPOT 4", "PIXEL PLACE"}


def test_outbound_layers_is_the_provider_name():
    assert build(fake_config()).outbound_layers == {"fake"}
    assert build(CascadeConfig()).outbound_layers == set()


def test_none_provider_leaves_the_rest_unanswered():
    cascade = build(CascadeConfig(), [RULE])
    got = cascade.classify(reqs("CORNER GROCER", "PIXEL PLACE"), SEED)
    assert got[0] is not None
    assert got[1] is None
    assert cascade.provider is None


def test_openai_provider_from_config_reports_its_name():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent = json.loads(body["messages"][1]["content"])
        items = [
            {"index": d["index"], "merchant": "", "category_id": "pets", "confidence": 0.9}
            for d in sent
        ]
        content = json.dumps({"items": items})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    config = CascadeConfig(provider="openai_api", api_key="k")
    cascade = build(config, transport=httpx.MockTransport(handler))
    (got,) = cascade.classify(reqs("PET PLACE"), SEED)
    assert got is not None
    assert (got.layer, got.category_id) == ("openai_api", "pets")
    assert cascade.outbound == ["PET PLACE"]


def test_dry_run_records_outbound_without_sending():
    cascade = build(fake_config(dry_run=True))
    assert cascade.classify(reqs("PIXEL PLACE"), SEED) == [None]
    assert cascade.outbound == ["PIXEL PLACE"]
    assert cascade.audit.batches == ()


def test_codex_without_home_is_unavailable():
    with pytest.raises(ProviderUnavailableError):
        build(CascadeConfig(provider="codex"))


def test_remembered_answers_never_leave():
    warm = build(fake_config())
    warm.classify(reqs("PIXEL PLACE"), SEED)
    cold = build(fake_config(), remembered=warm.answers().values())
    (got,) = cold.classify(reqs("PIXEL PLACE"), SEED)
    assert got is not None
    assert got.layer == "memory"
    assert cold.audit.batches == ()
