"""ASGI guards that run before any route: a cap on the request body and a same-origin check.

The body cap counts bytes as they arrive, so an upload is refused before
Starlette spools all of it to disk. The origin check refuses a write a browser
marks as coming from another site: identity is a per-node header, not a
cookie, so any page open in a tailnet browser could otherwise post to tally.
A client that sends no Fetch Metadata, such as the CLI, is not a browser
page and passes.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
SAME_SITE = frozenset({"same-origin", "none"})
_TOO_LARGE = 413


class BodyLimit:
    def __init__(self, app: ASGIApp, limit: int) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = Headers(scope=scope).get("content-length", "")
        if length.isdigit() and int(length) > self.limit:
            await _refuse(_TOO_LARGE, "request is too large")(scope, receive, send)
            return
        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.limit:
                    raise HTTPException(_TOO_LARGE, "request is too large")
            return message

        await self.app(scope, counted, send)


class SameOrigin:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] not in SAFE_METHODS:
            site = Headers(scope=scope).get("sec-fetch-site")
            if site is not None and site not in SAME_SITE:
                await _refuse(403, "cross-site write refused")(scope, receive, send)
                return
        await self.app(scope, receive, send)


def _refuse(code: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, code)
