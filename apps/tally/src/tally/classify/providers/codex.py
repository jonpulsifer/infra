"""The Codex CLI route: `codex exec --output-schema` on tally's own ChatGPT login.

tally signs in once with `CODEX_HOME=<codex_home> codex login --device-auth`
and never shares mate's token. Each batch runs in an empty temporary directory
that is also its HOME, with the shell, image and web tools turned off and a
read-only sandbox behind them. The descriptors in the prompt are payee text an
outsider can write, so the agent gets no tool that reads a file or reaches the
network, and no path to the owner's home beyond its own CODEX_HOME.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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

Runner = Callable[..., subprocess.CompletedProcess[str]]
_PASSTHROUGH_ENV = ("PATH", "LANG", "TZ", "SSL_CERT_FILE")
_NO_TOOLS = (
    "features.shell_tool=false",
    "features.unified_exec=false",
    "features.view_image=false",
    'web_search="disabled"',
)


@dataclass(frozen=True)
class CodexCall:
    prompt: str
    schema: dict[str, object]


class CodexProvider(ModelProvider[CodexCall]):
    name = "codex"

    def __init__(
        self,
        *,
        codex_home: Path,
        model: str,
        binary: str = "codex",
        timeout: float = 600.0,
        config_overrides: Sequence[str] = (),
        run: Runner = subprocess.run,
        which: Callable[[str], str | None] = shutil.which,
        batch_size: int = BATCH_SIZE,
        audit: Audit | None = None,
        dry_run: bool = False,
    ) -> None:
        super().__init__(model=model, batch_size=batch_size, audit=audit, dry_run=dry_run)
        self.codex_home = codex_home
        self.binary = binary
        self.timeout = timeout
        self.config_overrides = tuple(config_overrides)
        self._run = run
        self._which = which
        self._resolved: str | None = None

    def payload(self, strings: Sequence[str], taxonomy: Sequence[Category]) -> CodexCall:
        prompt = (
            system_prompt(taxonomy)
            + "\n\nDo not run commands or read files. Answer from the descriptors alone."
            + "\n\nDescriptors:\n"
            + user_prompt(strings)
        )
        return CodexCall(prompt=prompt, schema=response_schema(taxonomy))

    def send(self, payload: CodexCall) -> str:
        binary = self.ready()
        with tempfile.TemporaryDirectory(prefix="tally-codex-") as tmp:
            work = Path(tmp)
            schema, out = work / "schema.json", work / "answer.json"
            schema.write_text(json.dumps(payload.schema))
            argv = [
                binary,
                "exec",
                "--output-schema",
                str(schema),
                "-m",
                self.model,
                "--sandbox",
                "read-only",
                "--skip-git-repo-check",
                "--ephemeral",
                "--color",
                "never",
                "-C",
                str(work),
                "-o",
                str(out),
                *(a for o in (*_NO_TOOLS, *self.config_overrides) for a in ("-c", o)),
                "-",
            ]
            done = self._call(argv, stdin=payload.prompt, home=work, timeout=self.timeout)
            if done.returncode != 0:
                raise _failure(done)
            try:
                return out.read_text()
            except FileNotFoundError:
                raise ProviderError("codex exec wrote no answer") from None

    def ready(self) -> str:
        """The binary path once the login is confirmed; ProviderUnavailableError otherwise."""
        if self._resolved is not None:
            return self._resolved
        binary = self._which(self.binary)
        if binary is None:
            raise ProviderUnavailableError(
                f"the codex binary ({self.binary}) is not on PATH; install it or pick "
                "another provider"
            )
        if not self.codex_home.is_dir():
            raise ProviderUnavailableError(f"CODEX_HOME {self.codex_home} does not exist")
        with tempfile.TemporaryDirectory(prefix="tally-codex-") as tmp:
            status = self._call(
                [binary, "login", "status"], stdin=None, home=Path(tmp), timeout=30.0
            )
        if status.returncode != 0:
            raise ProviderUnavailableError(
                f"codex is not signed in under {self.codex_home}; run "
                f"`CODEX_HOME={self.codex_home} codex login --device-auth`"
            )
        self._resolved = binary
        return binary

    def _call(
        self, argv: list[str], *, stdin: str | None, home: Path, timeout: float
    ) -> subprocess.CompletedProcess[str]:
        env = {k: v for k in _PASSTHROUGH_ENV if (v := os.environ.get(k)) is not None}
        env["HOME"] = str(home)
        env["CODEX_HOME"] = str(self.codex_home)
        kwargs: dict[str, Any] = {
            "input": stdin,
            "capture_output": True,
            "text": True,
            "timeout": timeout,
            "env": env,
            "cwd": home,
            "check": False,
        }
        try:
            return self._run(argv, **kwargs)
        except subprocess.TimeoutExpired:
            raise ProviderError(f"codex timed out after {timeout:.0f}s") from None
        except OSError as e:
            raise ProviderUnavailableError(f"codex could not start: {e.strerror}") from None


def _failure(done: subprocess.CompletedProcess[str]) -> ProviderError:
    """Classify a failed run from stderr without quoting it: stderr echoes the prompt."""
    err = (done.stderr or "").casefold()
    if "usage limit" in err:
        return ProviderError("codex hit the ChatGPT usage limit; resume after the reset")
    if "401" in err or "unauthorized" in err or "log in" in err or "login" in err:
        return ProviderUnavailableError("codex refused the login; sign in again with --device-auth")
    return ProviderError(f"codex exec exited {done.returncode}")
