"""Any OpenAI-compatible chat completions endpoint, with JSON-schema structured output."""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from types import TracebackType
from typing import Self

import httpx

from tally.classify.audit import Audit
from tally.classify.providers import (
    BATCH_SIZE,
    ModelProvider,
    ProviderError,
    ProviderUnavailableError,
    response_schema,
    system_prompt,
    user_prompt,
)
from tally.model import Category

DEFAULT_BASE_URL = "https://api.openai.com/v1"
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


class OpenAIProvider(ModelProvider[dict[str, object]]):
    name = "openai_api"

    def __init__(
        self,
        *,
        api_key: str | None,
        model: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        max_retries: int = 4,
        backoff: float = 1.0,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        batch_size: int = BATCH_SIZE,
        audit: Audit | None = None,
        dry_run: bool = False,
    ) -> None:
        super().__init__(model=model, batch_size=batch_size, audit=audit, dry_run=dry_run)
        if not api_key and not dry_run:
            raise ProviderUnavailableError("openai_api needs an API key")
        self.max_retries = max_retries
        self.backoff = backoff
        self._sleep = sleep
        self._client = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            timeout=timeout,
            transport=transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    def payload(self, strings: Sequence[str], taxonomy: Sequence[Category]) -> dict[str, object]:
        return {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt(taxonomy)},
                {"role": "user", "content": user_prompt(strings)},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "tally_labels",
                    "strict": True,
                    "schema": response_schema(taxonomy),
                },
            },
        }

    def send(self, payload: dict[str, object]) -> str:
        for attempt in range(self.max_retries + 1):
            last = attempt == self.max_retries
            try:
                resp = self._client.post("/chat/completions", json=payload)
            except httpx.TransportError as e:
                if last:
                    raise ProviderError(f"openai_api unreachable: {type(e).__name__}") from None
                self._sleep(self._delay(attempt, None))
                continue
            if resp.status_code in RETRY_STATUS and not last:
                self._sleep(self._delay(attempt, resp.headers.get("retry-after")))
                continue
            return _content(resp)
        raise AssertionError("unreachable")

    def _delay(self, attempt: int, retry_after: str | None) -> float:
        try:
            if retry_after is not None:
                return max(0.0, float(retry_after))
        except ValueError:
            pass
        return float(self.backoff * 2**attempt)


def _content(resp: httpx.Response) -> str:
    if resp.status_code in (401, 403):
        raise ProviderUnavailableError(f"openai_api refused the key ({resp.status_code})")
    if resp.status_code != 200:
        raise ProviderError(f"openai_api returned {resp.status_code}")
    try:
        message = resp.json()["choices"][0]["message"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise ProviderError("openai_api returned an unexpected body") from None
    if message.get("refusal"):
        raise ProviderError("the model refused the batch")
    content = message.get("content")
    if not isinstance(content, str):
        raise ProviderError("openai_api returned no content")
    return content
