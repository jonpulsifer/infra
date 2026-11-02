"""fleetd's boot policy profile as a Keylime measured-boot policy.

Keylime loads this module through `measured_boot_imports` and the verifier
names the policy with `measured_boot_policy_name = fleetd-profile`. The
reference state Keylime hands the policy is a profile from
apps/fleetd/attest/policy/ rendered to JSON by keylime-policy-render, with
`required_authorities` already set to the running node's list. The checks
and their wording follow `Policy.evaluate` in apps/fleetd/attest/policy.go,
so both verifiers answer a boot the same way, and testdata/cases.json holds
the verdicts both test suites assert.

The event log is the dict Keylime builds from `tpm2_eventlog
--eventlog-version=2`: a list under `events`, each with `PCRIndex`,
`EventType`, `Digests` and an `Event` body. Certificates are named by the
lowercase hex SHA-256 of their DER, which is how the profile names them.

Keylime, not this module, checks that the log replays to the quoted PCRs.
What fleetd's `coverage` adds, that a PCR the profile names and the log
omits must still be zero, is Keylime's PCR comparison too, since it asks the
quote for every PCR the policy says is relevant.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Iterable

POLICY_NAME = "fleetd-profile"

EV_SEPARATOR = "EV_SEPARATOR"
EV_VARIABLE_DRIVER_CONFIG = "EV_EFI_VARIABLE_DRIVER_CONFIG"
EV_VARIABLE_AUTHORITY = "EV_EFI_VARIABLE_AUTHORITY"
EV_BOOT_SERVICES_APPLICATION = "EV_EFI_BOOT_SERVICES_APPLICATION"

# EFI_CERT_X509_GUID and EFI_CERT_SHA256_GUID, each in the order tpm2-tools
# prints today and the byte-swapped order older releases printed.
X509_GUIDS = {"a5c059a1-94e4-4aa7-87b5-ab155c2bf072", "a159c0a5-e494-a74a-87b5-ab155c2bf072"}
SHA256_GUIDS = {"c1c41626-504c-4092-aca9-41f936934328", "2616c4c1-4c50-9240-aca9-41f936934328"}


class LogError(Exception):
    """The PCR 7 events do not describe a Secure Boot state."""


def fingerprint(der_hex: str) -> str:
    return hashlib.sha256(bytes.fromhex(der_hex)).hexdigest()


def _digest(event: dict[str, Any], alg: str = "sha256") -> str | None:
    for d in event.get("Digests") or []:
        if d.get("AlgorithmId") == alg:
            return str(d["Digest"]).lower()
    return None


def _keys(variable_data: Any) -> tuple[list[str], int]:
    """The certificate fingerprints and the hash count of an EFI signature
    database, as tpm2_eventlog renders EV_EFI_VARIABLE_DRIVER_CONFIG."""
    certs: list[str] = []
    hashes = 0
    for siglist in variable_data or []:
        kind = str(siglist.get("SignatureType", "")).lower()
        keys = siglist.get("Keys") or []
        if kind in X509_GUIDS:
            for k in keys:
                certs.append(fingerprint(k["SignatureData"]))
        elif kind in SHA256_GUIDS:
            hashes += len(keys)
        else:
            raise LogError(f"signature list of unknown type {kind}")
    return certs, hashes


def _authority(variable_data: Any) -> list[str]:
    """The certificate fingerprints an EV_EFI_VARIABLE_AUTHORITY event names.
    Firmware records the EFI_SIGNATURE_DATA that verified an image, whose
    data is the DER certificate."""
    out: list[str] = []
    entries = variable_data if isinstance(variable_data, list) else [variable_data]
    for e in entries:
        if not isinstance(e, dict) or "SignatureData" not in e:
            raise LogError("authority event carries no signature data")
        data = str(e["SignatureData"])
        if not data.startswith("30"):
            raise LogError("authority signature data is not a DER certificate")
        out.append(fingerprint(data))
    return out


class SecureBootState:
    enabled = False
    pk: list[str]
    pk_hashes = 0
    kek: list[str]
    kek_hashes = 0
    db: list[str]
    db_hashes = 0
    pre_separator_authorities: list[str]
    post_separator_authorities: list[str]

    def __init__(self) -> None:
        self.pk, self.kek, self.db = [], [], []
        self.pre_separator_authorities, self.post_separator_authorities = [], []


def parse_secureboot_state(events: Iterable[dict[str, Any]]) -> SecureBootState:
    sb = SecureBootState()
    separated = False
    seen_secureboot = False
    for e in events:
        if e.get("PCRIndex") != 7:
            continue
        kind = e.get("EventType")
        body = e.get("Event") or {}
        if kind == EV_SEPARATOR:
            separated = True
        elif kind == EV_VARIABLE_DRIVER_CONFIG:
            if separated:
                raise LogError("a variable is configured after the separator")
            name = body.get("UnicodeName")
            data = body.get("VariableData")
            if name == "SecureBoot":
                if seen_secureboot:
                    raise LogError("SecureBoot is measured twice")
                seen_secureboot = True
                sb.enabled = str((data or {}).get("Enabled", "")).lower() == "yes"
            elif name == "PK":
                sb.pk, sb.pk_hashes = _keys(data)
            elif name == "KEK":
                sb.kek, sb.kek_hashes = _keys(data)
            elif name == "db":
                sb.db, sb.db_hashes = _keys(data)
            elif name == "dbx":
                _keys(data)
        elif kind == EV_VARIABLE_AUTHORITY:
            fps = _authority(body.get("VariableData"))
            (sb.post_separator_authorities if separated else sb.pre_separator_authorities).extend(fps)
    if not seen_secureboot:
        raise LogError("no SecureBoot variable is measured")
    return sb


def boot_applications(events: Iterable[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    separated = False
    for e in events:
        if e.get("PCRIndex") != 4:
            continue
        if e.get("EventType") == EV_SEPARATOR:
            separated = True
        elif e.get("EventType") == EV_BOOT_SERVICES_APPLICATION and separated:
            d = _digest(e)
            if d is None:
                raise LogError("a boot application has no SHA-256 digest")
            out.append(d)
    return out


def evaluate_profile(profile: dict[str, Any], log: dict[str, Any]) -> list[str]:
    """Every way the boot breaks the profile, sorted and deduplicated, in
    fleetd's words. Empty means the boot passes."""
    events = log.get("events") or []
    names = profile.get("names") or {}

    def name(fp: str) -> str:
        return names.get(fp, fp)

    try:
        sb = parse_secureboot_state(events)
    except (LogError, KeyError, ValueError, TypeError) as err:
        return [f"PCR 7 does not parse as a Secure Boot log: {err}"]

    v: list[str] = []
    if profile.get("secure_boot") and not sb.enabled:
        v.append("Secure Boot is off")

    def only(what: str, got: list[str], allowed: list[str]) -> None:
        for fp in got:
            if fp not in allowed:
                v.append(f"{what} holds {name(fp)}, which the policy does not allow")

    def need(what: str, got: list[str], required: list[str]) -> None:
        for fp in required:
            if fp not in got:
                v.append(f"{what} lacks {name(fp)}")

    pk_allowed = list(profile.get("platform_keys") or [])
    if sb.pk_hashes:
        v.append("PK holds a hash")
    only("PK", sb.pk, pk_allowed)
    need("PK", sb.pk, pk_allowed)
    if sb.kek_hashes:
        v.append("KEK holds a hash")
    only("KEK", sb.kek, list(profile.get("key_exchange_keys") or []))
    db = profile.get("db") or {}
    required = list(db.get("required") or [])
    need("db", sb.db, required)
    only("db", sb.db, required + list(db.get("allowed") or []))
    if sb.db_hashes:
        v.append(f"db holds {sb.db_hashes} image hashes")
    authorities = list(profile.get("authorities") or [])
    only("A pre-separator authority", sb.pre_separator_authorities, list(profile.get("pre_separator_authorities") or []) + authorities)
    only("A boot authority", sb.post_separator_authorities, authorities)
    need("The boot path", sb.post_separator_authorities, list(profile.get("required_authorities") or []))

    pinned = list(profile.get("boot_applications") or [])
    if pinned:
        try:
            apps = boot_applications(events)
        except LogError as err:
            return [f"PCR 4 does not parse: {err}"]
        if not apps:
            v.append("PCR 4 records no boot application after its separator")
        for d in apps:
            if d not in pinned:
                v.append(f"PCR 4 records boot application {d}, which the policy does not list")

    return sorted(set(v))


try:  # Registration under Keylime; the evaluator above needs none of it.
    from keylime.mba.elchecking import policies, tests  # type: ignore

    class FleetdProfile(policies.Policy):  # type: ignore[misc]
        relevant_pcrs = frozenset(range(8))

        def get_relevant_pcrs(self):  # type: ignore[no-untyped-def]
            return self.relevant_pcrs

        def refstate_to_test(self, refstate):  # type: ignore[no-untyped-def]
            return tests.RejectAll("fleetd-profile evaluates the log directly")

        def evaluate(self, refstate, eventlog) -> str:  # type: ignore[no-untyped-def]
            if isinstance(refstate, str):
                refstate = json.loads(refstate)
            violations = evaluate_profile(refstate, eventlog)
            return "; ".join(violations)

    policies.register(POLICY_NAME, FleetdProfile())
except ImportError:
    pass
