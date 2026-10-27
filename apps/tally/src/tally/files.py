"""Which files under a directory tally may open, and how a zip is opened.

The identity exclusions in `tally.config` apply to every path, including a
member's name inside a zip. Any other archive is never opened: it may hold
anything, identity documents included.
"""

from __future__ import annotations

import hashlib
import os
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from tally import config

ARCHIVES = frozenset({".zip", ".7z", ".rar", ".tar", ".gz", ".tgz", ".bz2", ".xz"})
READABLE = frozenset({".csv", ".tsv", ".qfx", ".ofx", ".xlsx", ".pdf"})
MAX_MEMBER_BYTES = 64 * 1024 * 1024


def guarded(path: Path, settings: config.Settings) -> bool:
    return config.is_excluded(path, settings.exclude) or config.is_excluded(
        path.resolve(), settings.exclude
    )


def is_archive(path: Path | PurePosixPath) -> bool:
    return path.suffix.lower() in ARCHIVES


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def walk(root: Path, settings: config.Settings) -> tuple[list[Path], int, int]:
    """Files under `root` that may be opened, plus counts of the excluded and the hidden.

    Excluded directories are pruned before descent, so nothing inside one is listed.
    """
    keep: list[Path] = []
    excluded = hidden = 0
    for dirpath, dirnames, filenames in os.walk(root):
        here = Path(dirpath)
        for d in list(dirnames):
            if d.startswith("."):
                hidden += 1
                dirnames.remove(d)
            elif guarded(here / d, settings):
                excluded += 1
                dirnames.remove(d)
        for name in filenames:
            path = here / name
            if name.startswith("."):
                hidden += 1
            elif guarded(path, settings):
                excluded += 1
            else:
                keep.append(path)
    return sorted(keep), excluded, hidden


@dataclass(frozen=True)
class Unpacked:
    """A zip member written to disk, or the reason it was left in the zip."""

    shown: str
    path: Path | None = None
    reason: str | None = None


def _suffix(data: bytes, member: PurePosixPath) -> str | None:
    """The suffix the parsers sniff by, from the bytes first and the member's name second."""
    if data[:5] == b"%PDF-":
        return ".pdf"
    if member.suffix.lower() in READABLE - {".pdf"}:
        return member.suffix.lower()
    return None


def unpack(path: Path, settings: config.Settings, into: Path) -> Iterator[Unpacked]:
    """Each member of a zip, one level deep, written under `into` with a sniffed suffix.

    The written name carries the zip's stem so members of different zips that
    share a name stay apart. A member whose name is an identity name, an
    archive, or too large stays in the zip.
    """
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        yield Unpacked(path.name, reason="not a zip tally can open")
        return
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            member = PurePosixPath(info.filename)
            shown = f"{path.stem}__{member.name}"
            if guarded(path / Path(*member.parts), settings):
                yield Unpacked(shown, reason="excluded")
            elif is_archive(member):
                yield Unpacked(shown, reason="an archive inside an archive")
            elif info.file_size > MAX_MEMBER_BYTES:
                yield Unpacked(shown, reason="too large")
            else:
                data = archive.read(info)
                suffix = _suffix(data, member)
                if suffix is None:
                    yield Unpacked(shown, reason="not a file type tally reads")
                    continue
                out = into / (shown if shown.lower().endswith(suffix) else shown + suffix)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
                yield Unpacked(out.name, path=out)
