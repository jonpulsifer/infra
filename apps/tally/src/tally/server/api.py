"""The /api routes. Every handler loads the whole ledger and works on it in memory."""

from __future__ import annotations

import re
import tempfile
import uuid
from datetime import date
from pathlib import Path
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from pydantic import TypeAdapter, ValidationError

from tally import report
from tally.classify.audit import Audit
from tally.classify.base import Classifier
from tally.classify.rules import RuleError, RulesClassifier, rule_from_correction, rule_id
from tally.engine import Decisions
from tally.model import (
    Account,
    AccountKind,
    BalanceAssertion,
    HoldingSnapshot,
    ImportPreview,
    Ledger,
    ParsedFile,
    Rule,
    Source,
    Transaction,
    Valuation,
)
from tally.parsers import ParseError
from tally.server import schemas as s
from tally.server.context import Services, services
from tally.server.identity import InteractiveOwner, Owner, Reader, is_tagged

router = APIRouter(prefix="/api")
Svc = Annotated[Services, Depends(services)]
_SLUG = re.compile(r"[^a-z0-9]+")
_SUFFIX = re.compile(r"\.[a-z0-9]{1,8}")


def _not_found(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"no such {what}")


def _invalid(detail: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail)


def _matcher(rule: Rule) -> RulesClassifier:
    try:
        return RulesClassifier([rule])
    except RuleError as err:
        raise _invalid(str(err)) from None


def _with_rule(rules: tuple[Rule, ...], rule: Rule) -> tuple[Rule, ...]:
    return (*(r for r in rules if r.id != rule.id), rule)


def _transaction(ledger: Ledger, txn_id: str) -> Transaction:
    for t in ledger.transactions:
        if t.id == txn_id:
            return t
    raise _not_found("transaction")


def _account(ledger: Ledger, account_id: str) -> Account:
    for a in ledger.accounts:
        if a.id == account_id:
            return a
    raise _not_found("account")


def _require_category(ledger: Ledger, category_id: str) -> None:
    if all(c.id != category_id for c in ledger.categories):
        raise _invalid(f"no category {category_id!r} in this ledger")


@router.get("/me")
def me(who: Reader) -> s.MeOut:
    return s.MeOut(
        login=who.login,
        name=who.name,
        via=who.via,
        ledger_id=who.ledger_id,
        role=who.role,
        memberships=tuple(s.MembershipOut.from_membership(m) for m in who.memberships),
    )


@router.get("/ledger")
def get_ledger(who: Reader, svc: Svc) -> s.LedgerOut:
    return s.LedgerOut.from_ledger(svc.repo.load(who.ledger_id))


@router.get("/report/{name}")
def get_report(
    name: str,
    who: Reader,
    svc: Svc,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: Annotated[date | None, Query()] = None,
) -> Any:
    fn = svc.settings.reports.get(name)
    if fn is None:
        raise _not_found("report")
    return report.to_json(fn(svc.repo.load(who.ledger_id), from_, to))


@router.get("/transactions")
def search(
    who: Reader,
    svc: Svc,
    text: str | None = None,
    account: str | None = None,
    category: str | None = None,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: Annotated[date | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=10_000)] = 500,
) -> list[s.TransactionOut]:
    found = report.search_transactions(
        svc.repo.load(who.ledger_id),
        text=text,
        account_id=account,
        category_id=category,
        start=from_,
        end=to,
        limit=limit,
    )
    return [s.TransactionOut.of(t) for t in found]


@router.delete("/transactions/{txn_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transaction(txn_id: str, who: Owner, svc: Svc) -> Response:
    version, ledger = svc.repo.load_versioned(who.ledger_id)
    _transaction(ledger, txn_id)
    kept = tuple(t for t in ledger.transactions if t.id != txn_id)
    svc.repo.save(ledger.model_copy(update={"transactions": kept}), expected_version=version)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/transactions/{txn_id}/category")
def recategorise(txn_id: str, body: s.RecategoriseIn, who: Owner, svc: Svc) -> s.RecategoriseOut:
    version, ledger = svc.repo.load_versioned(who.ledger_id)
    txn = _transaction(ledger, txn_id)
    _require_category(ledger, body.category_id)
    changed = {txn.id: _filed(txn, body.category_id, Source.manual)}
    rule: Rule | None = None
    if body.always:
        rule = rule_from_correction(txn, body.category_id)
        if body.match:
            match = body.match.strip()
            rule = rule.model_copy(update={"match": match, "id": rule_id(match, rule.category_id)})
        matcher = _matcher(rule)
        for t in ledger.transactions:
            if (
                t.id != txn.id
                and t.source is not Source.manual
                and t.category_id != body.category_id
                and matcher.match(t.descriptor, t.account_id)
            ):
                changed[t.id] = _filed(t, body.category_id, Source.rule)
        rule = rule.model_copy(update={"hits": len(changed)})
    rows = tuple(changed.get(t.id, t) for t in ledger.transactions)
    update: dict[str, object] = {"transactions": rows}
    if rule:
        update["rules"] = _with_rule(ledger.rules, rule)
    svc.repo.save(ledger.model_copy(update=update), expected_version=version)
    return s.RecategoriseOut(
        transaction=s.TransactionOut.of(changed[txn.id]),
        rule=s.RuleOut.of(rule) if rule else None,
        moved=len(changed) - 1,
    )


def _filed(t: Transaction, category_id: str, source: Source) -> Transaction:
    return t.model_copy(update={"category_id": category_id, "source": source, "confidence": None})


def _upload_name(filename: str | None, n: int) -> tuple[str, str]:
    """The name the owner sees, and the generic one the parser reads, which keeps it out of errors.

    The suffix survives because the parsers sniff by it.
    """
    shown = Path(filename or "").name
    suffix = Path(shown).suffix.lower()
    generic = f"file-{n}{suffix if _SUFFIX.fullmatch(suffix) else ''}"
    return (generic if shown in ("", ".", "..") else shown), generic


def _read_uploads(uploads: list[UploadFile], limit: int, into: Path) -> list[tuple[str, Path]]:
    paths: list[tuple[str, Path]] = []
    for i, upload in enumerate(uploads):
        data = upload.file.read(limit + 1)
        if len(data) > limit:
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "file is too large")
        shown, generic = _upload_name(upload.filename, i + 1)
        path = into / generic
        path.write_bytes(data)
        paths.append((shown, path))
    return paths


def _record_outbound(svc: Services, ledger_id: str, c: Classifier, p: ImportPreview) -> None:
    """Persist what left the process: the provider's own batches, else what the engine reports."""
    trail = getattr(c, "audit", None)
    if isinstance(trail, Audit) and trail.batches:
        for b in trail.batches:
            svc.repo.record_audit(ledger_id, f"{b.provider}:{b.model}", b.strings)
    elif p.model_calls and p.outbound_strings:
        svc.repo.record_audit(ledger_id, c.name, p.outbound_strings)


def _json_form[T](raw: str | None, shape: type[T], what: str) -> T | None:
    """A JSON form field beside the uploads, or None when the field was not sent."""
    if raw is None or not raw.strip():
        return None
    try:
        parsed = TypeAdapter(shape).validate_json(raw)
    except ValidationError:
        raise _invalid(f"{what} is not JSON of the expected shape") from None
    return parsed


@router.post("/import/preview", status_code=status.HTTP_201_CREATED)
def import_preview(
    files: Annotated[list[UploadFile], File()],
    who: Owner,
    svc: Svc,
    account_for_file: Annotated[
        str | None, Form(description="JSON object: upload name to ledger account id.")
    ] = None,
    withhold: Annotated[
        str | None, Form(description="JSON list of descriptors no classifier may see.")
    ] = None,
    dedupe_window_days: Annotated[
        int | None, Form(ge=0, le=31, description="Days apart two rows may be and match.")
    ] = None,
) -> s.StoredPreviewOut:
    """Parse the uploads, preview them against the ledger, and keep the preview sealed.

    The uploaded bytes live only in a temporary directory for the parse; the
    stored preview holds the parsed shapes. A parse error names the upload by
    its position (`file-2.csv`), never by the name it was uploaded under.
    """
    if not files:
        raise _invalid("no files")
    if len(files) > svc.settings.max_upload_files:
        raise _invalid(f"at most {svc.settings.max_upload_files} files at once")
    chosen = _json_form(account_for_file, dict[str, str], "account_for_file") or {}
    held = _json_form(withhold, list[str], "withhold") or []
    with tempfile.TemporaryDirectory(prefix="tally-upload-") as tmp:
        uploads = _read_uploads(files, svc.settings.max_upload_bytes, Path(tmp))
        try:
            parsed: list[ParsedFile] = [
                svc.settings.parse(path).model_copy(update={"name": shown})
                for shown, path in uploads
            ]
        except ParseError as err:
            raise _invalid(str(err)) from None
    base_version, ledger = svc.repo.load_versioned(who.ledger_id)
    classifier = svc.settings.classifier_for(ledger)
    try:
        result = svc.settings.engine.preview(
            parsed,
            ledger,
            classifier,
            account_for_file=chosen,
            withhold=frozenset(held),
            dedupe_window_days=dedupe_window_days,
        )
    except ValueError as err:
        raise _invalid(str(err)) from None
    _record_outbound(svc, who.ledger_id, classifier, result)
    stored = svc.repo.put_preview(who.ledger_id, who.login, base_version, parsed, result)
    return s.StoredPreviewOut.from_stored(stored)


@router.get("/import/preview/{preview_id}")
def get_preview(preview_id: str, who: Owner, svc: Svc) -> s.StoredPreviewOut:
    stored = svc.repo.get_preview(who.ledger_id, preview_id)
    if stored is None:
        raise _not_found("preview")
    return s.StoredPreviewOut.from_stored(stored)


@router.post("/import/preview/{preview_id}/apply")
def apply_preview(
    preview_id: str, who: Owner, svc: Svc, body: s.DecisionsIn | None = None
) -> s.ApplyOut:
    stored = svc.repo.get_preview(who.ledger_id, preview_id)
    if stored is None:
        raise _not_found("preview")
    version, base = svc.repo.load_versioned(who.ledger_id)
    if version != stored.base_version:
        raise HTTPException(status.HTTP_409_CONFLICT, "the ledger changed; preview again")
    d = body or s.DecisionsIn()
    decisions = Decisions(
        accept_findings=d.accept_findings,
        dismiss_findings=d.dismiss_findings,
        account_for_file=dict(d.account_for_file),
        recategorise=dict(d.recategorise),
        make_rules=d.make_rules,
        withhold_strings=d.withhold_strings,
    )
    try:
        candidate = svc.settings.engine.apply(base, stored.preview, decisions)
    except ValueError as err:
        raise _invalid(str(err)) from None
    if candidate.id != base.id:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "engine changed ledger id")
    candidate, skipped = svc.repo.drop_tombstoned(base, candidate)
    saved = svc.repo.save(candidate, expected_version=stored.base_version)
    svc.repo.drop_preview(who.ledger_id, preview_id)
    known = {t.id for t in base.transactions}
    return s.ApplyOut(
        added=sum(1 for t in saved.transactions if t.id not in known),
        skipped_tombstoned=skipped,
        version=svc.repo.version(who.ledger_id),
    )


@router.get("/rules")
def list_rules(who: Reader, svc: Svc) -> list[s.RuleOut]:
    return [s.RuleOut.of(r) for r in svc.repo.load(who.ledger_id).rules]


@router.post("/rules", status_code=status.HTTP_201_CREATED)
def make_rule(body: s.RuleIn, who: Owner, svc: Svc) -> s.RuleOut:
    version, ledger = svc.repo.load_versioned(who.ledger_id)
    _require_category(ledger, body.category_id)
    if body.account_id:
        _account(ledger, body.account_id)
    rule = Rule(
        id=rule_id(body.match, body.category_id, body.account_id),
        match=body.match,
        category_id=body.category_id,
        merchant=body.merchant,
        created_from="correction",
        account_id=body.account_id,
    )
    _matcher(rule)
    svc.repo.save(
        ledger.model_copy(update={"rules": _with_rule(ledger.rules, rule)}),
        expected_version=version,
    )
    return s.RuleOut.of(rule)


@router.get("/accounts/{account_id}")
def account_detail(account_id: str, who: Reader, svc: Svc) -> s.AccountDetailOut:
    ledger = svc.repo.load(who.ledger_id)
    acct = _account(ledger, account_id)

    def mine(row: HoldingSnapshot | Valuation | BalanceAssertion) -> bool:
        return row.account_id == acct.id

    return s.AccountDetailOut(
        account=s.AccountOut.of(acct),
        balance=report.account_balance(ledger, acct.id),
        transactions=sum(1 for t in ledger.transactions if t.account_id == acct.id),
        holdings=tuple(
            s.HoldingSnapshotOut.of(h) for h in ledger.holdings if h.account_id == acct.id
        ),
        valuations=tuple(
            s.ValuationOut.of(v) for v in ledger.valuations if v.account_id == acct.id
        ),
        assertions=tuple(
            s.BalanceAssertionOut.of(a) for a in ledger.assertions if a.account_id == acct.id
        ),
    )


@router.post("/accounts", status_code=status.HTTP_201_CREATED)
def make_account(body: s.AccountIn, who: Owner, svc: Svc) -> s.AccountOut:
    version, ledger = svc.repo.load_versioned(who.ledger_id)
    slug = _SLUG.sub("-", body.name.casefold()).strip("-")[:40] or "account"
    account_id = body.id or f"{slug}-{uuid.uuid4().hex[:6]}"
    if any(a.id == account_id for a in ledger.accounts):
        raise HTTPException(status.HTTP_409_CONFLICT, "an account with that id exists")
    acct = Account(
        id=account_id,
        name=body.name,
        institution=body.institution,
        kind=body.kind,
        since=body.since,
    )
    svc.repo.save(
        ledger.model_copy(update={"accounts": (*ledger.accounts, acct)}), expected_version=version
    )
    return s.AccountOut.of(acct)


@router.post("/accounts/{account_id}/valuations", status_code=status.HTTP_201_CREATED)
def add_valuation(account_id: str, body: s.ValuationIn, who: Owner, svc: Svc) -> s.ValuationOut:
    version, ledger = svc.repo.load_versioned(who.ledger_id)
    acct = _account(ledger, account_id)
    if acct.kind is not AccountKind.asset:
        raise _invalid("valuations are for manual asset accounts")
    val = Valuation(account_id=acct.id, date=body.date, value=body.value, source=body.source)
    svc.repo.save(
        ledger.model_copy(update={"valuations": (*ledger.valuations, val)}),
        expected_version=version,
    )
    return s.ValuationOut.of(val)


@router.get("/audit")
def audit_log(who: Owner, svc: Svc) -> list[s.AuditEntryOut]:
    return [s.AuditEntryOut.from_entry(e) for e in svc.repo.audit_log(who.ledger_id)]


@router.post("/members", status_code=status.HTTP_201_CREATED)
def invite(body: s.MemberIn, who: InteractiveOwner, svc: Svc) -> list[s.MemberOut]:
    login = body.login.strip()
    if is_tagged(login):
        raise _invalid("a tagged node cannot be a member")
    if login == who.login:
        raise _invalid("the owner is already a member")
    svc.repo.add_member(who.ledger_id, login, body.role)
    return [s.MemberOut.of(m) for m in svc.repo.load(who.ledger_id).members]


@router.delete("/members/{login}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(login: str, who: InteractiveOwner, svc: Svc) -> Response:
    if not svc.repo.remove_member(who.ledger_id, login):
        raise _not_found("viewer")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/tokens")
def list_tokens(who: InteractiveOwner, svc: Svc) -> list[s.TokenOut]:
    return [s.TokenOut.from_token(t) for t in svc.repo.tokens(who.ledger_id)]


@router.post("/tokens", status_code=status.HTTP_201_CREATED)
def mint_token(who: InteractiveOwner, svc: Svc) -> s.TokenOut:
    token, secret = svc.repo.mint_token(who.ledger_id, who.login)
    return s.TokenOut.from_token(token, secret)


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(token_id: str, who: InteractiveOwner, svc: Svc) -> Response:
    if not svc.repo.revoke_token(who.ledger_id, token_id):
        raise _not_found("token")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
