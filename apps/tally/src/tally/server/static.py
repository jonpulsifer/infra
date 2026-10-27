"""The built SPA at /, behind the API: a real file if one matches, else index.html."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.responses import FileResponse

log = logging.getLogger(__name__)

_IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
_REVALIDATE = {"Cache-Control": "no-cache"}


def mount_spa(app: FastAPI, dist: Path | None) -> bool:
    """Register the catch-all last, so every /api route and /healthz wins over it."""
    if dist is None or not (dist / "index.html").is_file():
        log.warning("no built web app at %s; serving the API only", dist)
        return False
    root = dist.resolve()
    index = root / "index.html"

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such route")
        if "\0" in path:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such file")
        candidate = (root / path).resolve()
        if path and candidate.is_relative_to(root) and candidate.is_file():
            hashed = candidate.parent.name == "assets"
            return FileResponse(candidate, headers=_IMMUTABLE if hashed else _REVALIDATE)
        if "." in Path(path).name:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no such file")
        return FileResponse(index, headers=_REVALIDATE)

    return True
