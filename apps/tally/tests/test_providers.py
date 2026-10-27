import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from tally.classify.audit import Audit, digest
from tally.classify.base import Request
from tally.classify.providers import (
    ProviderError,
    ProviderUnavailableError,
    parse_answers,
    response_schema,
)
from tally.classify.providers.codex import CodexProvider
from tally.classify.providers.fake import FakeAnswer, FakeProvider
from tally.classify.providers.openai_api import OpenAIProvider
from tally.classify.rules import ScopedRequest
from tally.classify.taxonomy import SEED, assignable
from tally.model import Source

DESCRIPTORS = ["CORNER GROCER #12", "TEA SPOT 4", "PIXEL PLACE"]


def requests(strings=DESCRIPTORS):
    return [Request(descriptor=s, account_kind="credit") for s in strings]


def answer_body(strings, category_id="groceries", confidence=0.9):
    items = [
        {"index": i, "merchant": s.title(), "category_id": category_id, "confidence": confidence}
        for i, s in enumerate(strings)
    ]
    return json.dumps({"items": items})


class FakeAPI:
    """An OpenAI-compatible transport that answers every descriptor it is sent."""

    def __init__(self, statuses=(), category_id="groceries"):
        self.statuses = list(statuses)
        self.category_id = category_id
        self.bodies: list[dict] = []
        self.headers: list[httpx.Headers] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.bodies.append(body)
        self.headers.append(request.headers)
        if self.statuses:
            status = self.statuses.pop(0)
            return httpx.Response(status, headers={"retry-after": "0"})
        sent = [d["descriptor"] for d in json.loads(body["messages"][1]["content"])]
        content = answer_body(sent, self.category_id)
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def openai(api, **kw):
    sleeps: list[float] = []
    p = OpenAIProvider(
        api_key="sk-test",
        model="m",
        transport=httpx.MockTransport(api),
        sleep=sleeps.append,
        **kw,
    )
    return p, sleeps


def strings_in(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from strings_in(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings_in(v)


def test_openai_body_carries_descriptors_and_taxonomy_only():
    api = FakeAPI()
    p, _ = openai(api)
    scoped = [
        ScopedRequest(descriptor=s, account_kind="credit", account_id="acct-secret-123")
        for s in DESCRIPTORS
    ]
    got = p.classify(scoped, SEED)
    assert [r.category_id for r in got if r] == ["groceries"] * 3
    assert all(r is not None and r.source is Source.model for r in got)
    (body,) = api.bodies
    flat = json.dumps(body)
    for leaked in ("acct-secret-123", "credit"):
        assert leaked not in flat
    sent = [d["descriptor"] for d in json.loads(body["messages"][1]["content"])]
    assert sent == DESCRIPTORS
    allowed_ids = {c.id for c in SEED} | {c.name for c in SEED}
    schema_ids = body["response_format"]["json_schema"]["schema"]["properties"]["items"]["items"][
        "properties"
    ]["category_id"]["enum"]
    assert set(schema_ids) == set(assignable(SEED))
    assert set(schema_ids) <= allowed_ids
    structural = {
        "model", "messages", "role", "system", "user", "content", "response_format", "type",
        "json_schema", "name", "tally_labels", "strict", "schema", "object", "properties",
        "items", "array", "index", "integer", "merchant", "string", "category_id", "enum",
        "confidence", "number", "required", "additionalProperties", "m",
    }  # fmt: skip
    leaves = set(strings_in(body)) - structural - set(schema_ids)
    prompts = {body["messages"][0]["content"], body["messages"][1]["content"]}
    assert leaves == prompts
    system = body["messages"][0]["content"]
    for c in SEED:
        system = system.replace(c.name, "").replace(c.id, "")
    for d in DESCRIPTORS:
        assert d not in system
    assert api.headers[0]["authorization"] == "Bearer sk-test"


def test_openai_batches_at_75_and_sends_each_unique_string_once():
    api = FakeAPI()
    p, _ = openai(api)
    strings = [f"SHOP {i}" for i in range(160)]
    got = p.classify(requests(strings + strings[:10]), SEED)
    assert len(got) == 170
    assert all(got)
    sizes = [len(json.loads(b["messages"][1]["content"])) for b in api.bodies]
    assert sizes == [75, 75, 10]
    assert [b.count for b in p.audit.batches] == [75, 75, 10]
    assert sorted(p.audit.strings()) == sorted(strings)


def test_openai_retries_429_and_5xx_with_backoff():
    api = FakeAPI(statuses=[429, 503])
    p, sleeps = openai(api)
    assert all(p.classify(requests(), SEED))
    assert len(api.bodies) == 3
    assert sleeps == [0.0, 0.0]


def test_openai_backoff_doubles_without_retry_after():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(500)

    sleeps: list[float] = []
    p = OpenAIProvider(
        api_key="k",
        model="m",
        transport=httpx.MockTransport(handler),
        sleep=sleeps.append,
        max_retries=3,
        backoff=0.5,
    )
    with pytest.raises(ProviderError, match="500"):
        p.classify(requests(), SEED)
    assert sleeps == [0.5, 1.0, 2.0]
    assert len(calls) == 4


def test_openai_retries_timeouts_then_gives_up():
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    p = OpenAIProvider(
        api_key="k", model="m", transport=httpx.MockTransport(handler), sleep=lambda _: None
    )
    with pytest.raises(ProviderError, match="ReadTimeout"):
        p.classify(requests(), SEED)


def test_openai_rejects_off_taxonomy_answers():
    p, _ = openai(FakeAPI(category_id="not-a-category"))
    with pytest.raises(ProviderError, match="outside the taxonomy"):
        p.classify(requests(), SEED)


def test_openai_refused_key_is_unavailable():
    p = OpenAIProvider(
        api_key="k", model="m", transport=httpx.MockTransport(lambda r: httpx.Response(401))
    )
    with pytest.raises(ProviderUnavailableError):
        p.classify(requests(), SEED)


def test_openai_needs_a_key_unless_dry_run():
    with pytest.raises(ProviderUnavailableError):
        OpenAIProvider(api_key=None, model="m")
    OpenAIProvider(api_key=None, model="m", dry_run=True)


def test_dry_run_sends_nothing_and_records_the_payload():
    api = FakeAPI()
    p, _ = openai(api, dry_run=True)
    assert p.classify(requests(), SEED) == [None, None, None]
    assert api.bodies == []
    assert p.audit.batches == ()
    (payload,) = p.dry_runs
    sent = [d["descriptor"] for d in json.loads(payload["messages"][1]["content"])]
    assert sent == DESCRIPTORS


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("not json", "not JSON"),
        ("{}", "no items"),
        (json.dumps({"items": [{"index": 0}]}), "outside the taxonomy"),
        (answer_body(["a"]), "1 of 2"),
        (answer_body(["a", "b"], confidence=1.5), "outside 0 to 1"),
    ],
)
def test_parse_answers_rejects(raw, message):
    with pytest.raises(ProviderError, match=message):
        parse_answers(raw, ["a", "b"], SEED)


def test_parse_answers_rejects_duplicate_and_unknown_indexes():
    dup = {"items": [{"index": 0, "merchant": "", "category_id": "pets", "confidence": 1}] * 2}
    with pytest.raises(ProviderError, match="twice"):
        parse_answers(json.dumps(dup), ["a", "b"], SEED)
    far = {"items": [{"index": 9, "merchant": "", "category_id": "pets", "confidence": 1}]}
    with pytest.raises(ProviderError, match="not sent"):
        parse_answers(json.dumps(far), ["a"], SEED)


def test_response_schema_is_strict():
    schema = response_schema(SEED)
    assert schema["additionalProperties"] is False


def test_fake_is_deterministic_and_audited():
    answers = {"grocer": FakeAnswer("groceries", "Corner Grocer", 0.95)}
    a, b = FakeProvider(answers), FakeProvider(answers)
    ra, rb = a.classify(requests(), SEED), b.classify(requests(), SEED)
    assert ra == rb
    assert ra[0] is not None
    assert (ra[0].category_id, ra[0].merchant, ra[0].confidence) == (
        "groceries",
        "Corner Grocer",
        0.95,
    )
    assert all(r is not None and r.confidence == 0.4 for r in ra[1:])
    assert a.calls == [tuple(DESCRIPTORS)]
    assert a.audit.strings() == tuple(DESCRIPTORS)


def test_audit_rows():
    at = datetime(2020, 1, 2, tzinfo=UTC)
    audit = Audit(clock=lambda: at)
    audit.record("fake", "m", ["x", "y"])
    (row,) = audit.to_rows()
    assert row == {
        "at": at.isoformat(),
        "provider": "fake",
        "model": "m",
        "count": 2,
        "sha256": digest(["x", "y"]),
        "strings": ["x", "y"],
    }


class FakeCodex:
    def __init__(self, *, logged_in=True, exit_code=0, stderr="", category_id="groceries"):
        self.logged_in = logged_in
        self.exit_code = exit_code
        self.stderr = stderr
        self.category_id = category_id
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, argv, **kw):
        self.calls.append((argv, kw))
        if argv[1:3] == ["login", "status"]:
            return subprocess.CompletedProcess(argv, 0 if self.logged_in else 1, "", "")
        schema = json.loads(Path(argv[argv.index("--output-schema") + 1]).read_text())
        assert schema == response_schema(SEED)
        prompt = kw["input"]
        sent = [d["descriptor"] for d in json.loads(prompt.rsplit("Descriptors:\n", 1)[1])]
        if self.exit_code == 0:
            out = Path(argv[argv.index("-o") + 1])
            out.write_text(answer_body(sent, self.category_id))
        return subprocess.CompletedProcess(argv, self.exit_code, "", self.stderr)


def codex(tmp_path, runner, which=lambda b: f"/bin/{b}", **kw):
    return CodexProvider(codex_home=tmp_path, model="gpt-x", run=runner, which=which, **kw)


def test_codex_runs_exec_with_schema_model_and_private_home(tmp_path):
    runner = FakeCodex()
    p = codex(tmp_path, runner)
    got = p.classify(requests(DESCRIPTORS * 2), SEED)
    assert [r.category_id for r in got if r] == ["groceries"] * 6
    (status, _), (argv, kw) = runner.calls
    assert status == ["/bin/codex", "login", "status"]
    assert argv[:2] == ["/bin/codex", "exec"]
    assert argv[argv.index("-m") + 1] == "gpt-x"
    assert argv[argv.index("--sandbox") + 1] == "read-only"
    assert argv[-1] == "-"
    assert kw["env"]["CODEX_HOME"] == str(tmp_path)
    assert "OPENAI_API_KEY" not in kw["env"]
    assert kw["cwd"] != Path.cwd()
    assert p.audit.strings() == tuple(DESCRIPTORS)


def test_codex_never_sees_the_real_home_and_has_no_tools(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", "/home/owner-real")
    runner = FakeCodex()
    codex(tmp_path, runner).classify(requests(DESCRIPTORS), SEED)
    for _, kw in runner.calls:
        assert kw["env"]["HOME"] != "/home/owner-real"
        assert "/home/owner-real" not in kw["env"].values()
        assert kw["env"]["HOME"] == str(kw["cwd"])
    _, (argv, kw) = runner.calls
    assert argv[argv.index("-C") + 1] == kw["env"]["HOME"]
    overrides = {argv[i + 1] for i, a in enumerate(argv) if a == "-c"}
    assert {"features.shell_tool=false", 'web_search="disabled"'} <= overrides


def test_codex_checks_login_once(tmp_path):
    runner = FakeCodex()
    p = codex(tmp_path, runner, batch_size=1)
    p.classify(requests(), SEED)
    assert sum(argv[1] == "login" for argv, _ in runner.calls) == 1


def test_codex_missing_binary_is_a_clear_error(tmp_path):
    p = codex(tmp_path, FakeCodex(), which=lambda b: None)
    with pytest.raises(ProviderUnavailableError, match="not on PATH"):
        p.classify(requests(), SEED)


def test_codex_missing_login_names_the_fix(tmp_path):
    p = codex(tmp_path, FakeCodex(logged_in=False))
    with pytest.raises(ProviderUnavailableError, match="login --device-auth"):
        p.classify(requests(), SEED)


def test_codex_missing_home_is_unavailable(tmp_path):
    p = CodexProvider(
        codex_home=tmp_path / "nope", model="m", run=FakeCodex(), which=lambda b: "/bin/codex"
    )
    with pytest.raises(ProviderUnavailableError, match="does not exist"):
        p.classify(requests(), SEED)


def test_codex_failure_never_quotes_stderr(tmp_path):
    p = codex(tmp_path, FakeCodex(exit_code=2, stderr="CORNER GROCER #12 boom"))
    with pytest.raises(ProviderError) as info:
        p.classify(requests(), SEED)
    assert "CORNER" not in str(info.value)
    assert "exited 2" in str(info.value)


def test_codex_usage_limit(tmp_path):
    p = codex(tmp_path, FakeCodex(exit_code=1, stderr="You have hit your usage limit"))
    with pytest.raises(ProviderError, match="usage limit"):
        p.classify(requests(), SEED)


def test_codex_validates_answers(tmp_path):
    p = codex(tmp_path, FakeCodex(category_id="bogus"))
    with pytest.raises(ProviderError, match="outside the taxonomy"):
        p.classify(requests(), SEED)


def test_codex_timeout(tmp_path):
    def runner(argv, **kw):
        if argv[1] == "login":
            return subprocess.CompletedProcess(argv, 0, "", "")
        raise subprocess.TimeoutExpired(argv, kw["timeout"])

    p = codex(tmp_path, runner, timeout=5)
    with pytest.raises(ProviderError, match="timed out"):
        p.classify(requests(), SEED)


def test_codex_dry_run_needs_no_binary(tmp_path):
    p = codex(tmp_path, FakeCodex(), which=lambda b: None, dry_run=True)
    assert p.classify(requests(), SEED) == [None, None, None]
    assert len(p.dry_runs) == 1
