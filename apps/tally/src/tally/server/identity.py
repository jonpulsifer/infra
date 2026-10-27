"""Who is asking, and which ledger they act on.

Identity comes from the Tailscale identity headers the tailnet proxy sets,
or from a bearer token the ledger owner minted for the CLI. The headers are
trusted only because the app is reachable through that proxy alone; a direct
route to the pod would let anyone claim any login. Tagged nodes carry no user
and are refused. With neither, `TALLY_DEV_LOGIN` stands in for local dev.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, status

from tally.server.context import Services, services
from tally.server.db import Membership, Role

LOGIN_HEADER = "Tailscale-User-Login"
NAME_HEADER = "Tailscale-User-Name"
LEDGER_HEADER = "X-Tally-Ledger"
TAGGED = "tagged-devices"

Via = Literal["tailscale", "bearer", "dev"]


@dataclass(frozen=True)
class Principal:
    login: str
    name: str | None
    via: Via
    ledger_id: str
    role: Role
    memberships: tuple[Membership, ...]

    @property
    def is_owner(self) -> bool:
        return self.role == "owner"


def _refuse(code: int, detail: str) -> HTTPException:
    headers = {"WWW-Authenticate": "Bearer"} if code == status.HTTP_401_UNAUTHORIZED else None
    return HTTPException(status_code=code, detail=detail, headers=headers)


def is_tagged(login: str) -> bool:
    return login == TAGGED or login.endswith(".ts.net")


def _bearer(request: Request) -> str | None:
    scheme, _, secret = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer":
        return None
    return secret.strip() or None


def _choose(memberships: tuple[Membership, ...], wanted: str | None) -> Membership:
    if wanted:
        for m in memberships:
            if m.ledger_id == wanted:
                return m
        raise _refuse(status.HTTP_403_FORBIDDEN, "not a member of that ledger")
    return memberships[0]


def _from_bearer(svc: Services, secret: str) -> Principal:
    token = svc.repo.resolve_token(secret)
    if token is None:
        raise _refuse(status.HTTP_401_UNAUTHORIZED, "unknown token")
    for m in svc.repo.memberships(token.login):
        if m.ledger_id == token.ledger_id:
            return Principal(token.login, None, "bearer", m.ledger_id, m.role, (m,))
    raise _refuse(status.HTTP_401_UNAUTHORIZED, "token's login is no longer a member")


def _login(request: Request, svc: Services) -> tuple[str, Via]:
    login = request.headers.get(LOGIN_HEADER, "").strip()
    if login:
        return login, "tailscale"
    if svc.settings.dev_login:
        return svc.settings.dev_login, "dev"
    raise _refuse(status.HTTP_401_UNAUTHORIZED, "no tailnet identity")


def principal(request: Request, svc: Annotated[Services, Depends(services)]) -> Principal:
    if secret := _bearer(request):
        return _from_bearer(svc, secret)
    login, via = _login(request, svc)
    if is_tagged(login):
        raise _refuse(status.HTTP_403_FORBIDDEN, "tagged nodes have no user identity")
    memberships = svc.repo.memberships(login)
    if login in svc.settings.owners and not any(m.role == "owner" for m in memberships):
        svc.repo.create_ledger(login)
        memberships = svc.repo.memberships(login)
    if not memberships:
        raise _refuse(status.HTTP_403_FORBIDDEN, "no ledger for this login")
    chosen = _choose(memberships, request.headers.get(LEDGER_HEADER))
    name = request.headers.get(NAME_HEADER) if via == "tailscale" else None
    return Principal(login, name, via, chosen.ledger_id, chosen.role, memberships)


def owner(who: Annotated[Principal, Depends(principal)]) -> Principal:
    if not who.is_owner:
        raise _refuse(status.HTTP_403_FORBIDDEN, "only the ledger owner may do this")
    return who


def interactive_owner(who: Annotated[Principal, Depends(owner)]) -> Principal:
    """An owner at a browser: a bearer token cannot mint tokens or change membership."""
    if who.via == "bearer":
        raise _refuse(status.HTTP_403_FORBIDDEN, "not with a bearer token")
    return who


Reader = Annotated[Principal, Depends(principal)]
Owner = Annotated[Principal, Depends(owner)]
InteractiveOwner = Annotated[Principal, Depends(interactive_owner)]
