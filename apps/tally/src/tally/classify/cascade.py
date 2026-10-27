"""Build a Cascade from configuration: rules, then memory, then at most one provider.

The memory layer holds every provider answer for the cascade's lifetime, so a
descriptor leaves the process at most once however many times it is asked.
`answers()` hands those answers to the store to keep as rules.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Literal

import httpx

from tally.classify.audit import Audit
from tally.classify.base import Cascade, Classifier, Request, Result
from tally.classify.providers import BATCH_SIZE, ProviderUnavailableError
from tally.classify.providers.codex import CodexProvider
from tally.classify.providers.fake import FakeAnswer, FakeProvider
from tally.classify.providers.openai_api import DEFAULT_BASE_URL, OpenAIProvider
from tally.classify.rules import RulesClassifier
from tally.model import Category, Rule

ProviderName = Literal["openai_api", "codex", "fake", "none"]
DEFAULT_MODEL = "gpt-6-luna"


@dataclass(frozen=True)
class CascadeConfig:
    provider: ProviderName = "none"
    threshold: float = 0.8
    model: str = DEFAULT_MODEL
    batch_size: int = BATCH_SIZE
    dry_run: bool = False
    base_url: str = DEFAULT_BASE_URL
    api_key: str | None = field(default=None, repr=False)
    timeout: float = 60.0
    max_retries: int = 4
    codex_home: Path | None = None
    codex_binary: str = "codex"
    fake_answers: Mapping[str, FakeAnswer] = field(default_factory=dict)


class Memory:
    """Answers already bought this run. `recall` is a layer; `remember(p)` wraps a provider."""

    def __init__(self, seed: Iterable[Result] = ()) -> None:
        self._known: dict[str, Result] = {r.descriptor: r for r in seed}

    def answers(self) -> dict[str, Result]:
        return dict(self._known)

    @property
    def recall(self) -> Classifier:
        return _Recall(self._known)

    def remember(self, provider: Classifier) -> Classifier:
        return _Remember(provider, self._known)


class _Recall:
    name = "memory"

    def __init__(self, known: dict[str, Result]) -> None:
        self._known = known

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        hits = (self._known.get(r.descriptor) for r in requests)
        return [None if h is None else replace(h, layer=self.name) for h in hits]


class _Remember:
    def __init__(self, inner: Classifier, known: dict[str, Result]) -> None:
        self.inner = inner
        self.name = inner.name
        self._known = known

    def classify(
        self, requests: Sequence[Request], taxonomy: Sequence[Category]
    ) -> list[Result | None]:
        got = self.inner.classify(requests, taxonomy)
        for res in got:
            if res is not None:
                self._known.setdefault(res.descriptor, res)
        return got


class TallyCascade(Cascade):
    def __init__(
        self,
        layers: Sequence[Classifier],
        *,
        threshold: float,
        outbound_layers: Iterable[str],
        rules: RulesClassifier,
        memory: Memory,
        audit: Audit,
        provider: Classifier | None,
    ) -> None:
        super().__init__(layers, threshold=threshold, outbound_layers=outbound_layers)
        self.rules = rules
        self.memory = memory
        self.audit = audit
        self.provider = provider

    def answers(self) -> dict[str, Result]:
        return self.memory.answers()


def provider_for(
    config: CascadeConfig, audit: Audit, *, transport: httpx.BaseTransport | None = None
) -> Classifier | None:
    b, d = config.batch_size, config.dry_run
    match config.provider:
        case "none":
            return None
        case "fake":
            return FakeProvider(
                config.fake_answers, model=config.model, batch_size=b, audit=audit, dry_run=d
            )
        case "openai_api":
            return OpenAIProvider(
                api_key=config.api_key,
                model=config.model,
                base_url=config.base_url,
                timeout=config.timeout,
                max_retries=config.max_retries,
                transport=transport,
                batch_size=b,
                audit=audit,
                dry_run=d,
            )
        case "codex":
            if config.codex_home is None:
                raise ProviderUnavailableError("the codex provider needs codex_home")
            return CodexProvider(
                codex_home=config.codex_home,
                model=config.model,
                binary=config.codex_binary,
                timeout=config.timeout,
                batch_size=b,
                audit=audit,
                dry_run=d,
            )


def build(
    config: CascadeConfig,
    rules: Iterable[Rule] = (),
    *,
    audit: Audit | None = None,
    remembered: Iterable[Result] = (),
    provider: Classifier | None = None,
    transport: httpx.BaseTransport | None = None,
) -> TallyCascade:
    """`provider` overrides the configured one, for a shell that built its own."""
    audit = audit if audit is not None else Audit()
    rules_layer = RulesClassifier(rules)
    memory = Memory(remembered)
    chosen = provider if provider is not None else provider_for(config, audit, transport=transport)
    layers: list[Classifier] = [rules_layer, memory.recall]
    if chosen is not None:
        layers.append(memory.remember(chosen))
    return TallyCascade(
        layers,
        threshold=config.threshold,
        outbound_layers=() if chosen is None else (chosen.name,),
        rules=rules_layer,
        memory=memory,
        audit=audit,
        provider=chosen,
    )
