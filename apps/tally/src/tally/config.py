"""CLI settings: defaults, then ~/.config/tally/config.toml, then TALLY_* environment variables.

The identity exclusions are not settings. `exclude` in the file adds to them and
can never remove one, and `is_excluded` also refuses any path component whose
name carries an identity token, so an identity document is never opened.
"""

from __future__ import annotations

import os
import re
import subprocess
import tomllib
from collections.abc import Mapping
from pathlib import Path, PurePath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

ProviderName = Literal["none", "fake", "openai_api", "codex"]

IDENTITY_DIRS: tuple[str, ...] = (
    "CRA",
    "Investments/PWL/PWL Signed Documents",
    "Investments/PWL/PWL Transfer/ID",
    "Investments/PWL/PWL Transfer/Forms",
)
_IDENTITY_TOKENS = frozenset({"id", "sin"})
_IDENTITY_SUBSTRINGS = ("licence", "license", "passport")
_CAMEL = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z]+|[a-z]+|\d+")

_ENV: Mapping[str, str] = {
    "TALLY_SERVER_URL": "server_url",
    "TALLY_PROVIDER": "provider",
    "TALLY_MODEL": "model",
    "TALLY_CODEX_HOME": "codex_home",
    "TALLY_THRESHOLD": "threshold",
    "TALLY_IMPORT_ROOT": "import_root",
    "TALLY_DB": "db_path",
    "TALLY_TOKEN_COMMAND": "token_command",
}


def _config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def _data_home() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


def default_config_path() -> Path:
    return Path(os.environ.get("TALLY_CONFIG") or _config_home() / "tally" / "config.toml")


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    server_url: str = "http://127.0.0.1:8081"
    provider: ProviderName = "none"
    model: str = "gpt-6-luna"
    codex_home: Path = Field(default_factory=lambda: _config_home() / "tally" / "codex")
    threshold: float = Field(default=0.8, ge=0.0, le=1.0)
    # A card posts up to a week after the purchase a hand-kept register dates.
    dedupe_window_days: int = Field(default=7, ge=0)
    transfer_window_days: int = Field(default=4, ge=0)
    import_root: Path = Field(default_factory=lambda: Path.home() / "finance")
    db_path: Path = Field(default_factory=lambda: _data_home() / "tally" / "tally.db")
    exclude: tuple[str, ...] = IDENTITY_DIRS
    token_command: str | None = Field(
        default=None, description="A command whose stdout is the server bearer token."
    )

    @field_validator("codex_home", "import_root", "db_path")
    @classmethod
    def _expand(cls, v: Path) -> Path:
        return v.expanduser()

    @field_validator("exclude")
    @classmethod
    def _keep_identity(cls, v: tuple[str, ...]) -> tuple[str, ...]:
        extra = tuple(e.strip("/") for e in v if e.strip("/") not in IDENTITY_DIRS)
        return IDENTITY_DIRS + extra

    def token(self) -> str | None:
        """The bearer token for `tally push`: TALLY_TOKEN, else `token_command`'s output."""
        if tok := os.environ.get("TALLY_TOKEN"):
            return tok.strip()
        if not self.token_command:
            return None
        out = subprocess.run(
            self.token_command, shell=True, check=True, capture_output=True, text=True
        )
        return out.stdout.strip() or None


def load(path: Path | None = None, env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    path = path or default_config_path()
    values: dict[str, object] = {}
    if path.is_file():
        values.update(tomllib.loads(path.read_text()))
    for var, key in _ENV.items():
        if var in env:
            values[key] = env[var]
    return Settings.model_validate(values)


def _tokens(name: str) -> set[str]:
    parts = re.split(r"[^A-Za-z0-9]+", name)
    camel = [t for p in parts for t in _CAMEL.findall(p)]
    return {t.lower() for t in (*parts, *camel) if t}


def identity_name(name: str) -> bool:
    lowered = name.lower()
    if any(s in lowered for s in _IDENTITY_SUBSTRINGS):
        return True
    return bool(_tokens(PurePath(name).stem) & _IDENTITY_TOKENS)


def _contains(parts: tuple[str, ...], fragment: tuple[str, ...]) -> bool:
    n = len(fragment)
    return any(parts[i : i + n] == fragment for i in range(len(parts) - n + 1))


def is_excluded(path: Path, exclude: tuple[str, ...] = IDENTITY_DIRS) -> bool:
    """True when any component is an identity name or `path` sits under an excluded fragment.

    Fragments match a run of components anywhere in the path, so they hold
    whichever root the walk starts from.
    """
    parts = path.parts
    if any(identity_name(p) for p in parts if p not in (path.anchor, "..", ".")):
        return True
    fragments = {tuple(PurePath(f).parts) for f in (*IDENTITY_DIRS, *exclude)}
    return any(_contains(parts, f) for f in fragments if f)
