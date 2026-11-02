"""The fleetd-profile policy gives riptide's boot the verdicts fleetd gives.

`python3 -m unittest discover -s apps/keylime-policy` from the repository
root, or `mise run keylime:test`. The shared cases live in
testdata/cases.json; the Go side is apps/fleetd/attest/keylime_test.go.
"""

from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import lolwtf_mb_policy as policy  # noqa: E402

REPO = HERE.parent.parent
RENDERED = REPO / "clusters/folly/apps/keylime/policies/talos.json"


def load(path: pathlib.Path) -> dict:
    with path.open() as f:
        return json.load(f)


class ParityCases(unittest.TestCase):
    """Every case in testdata/cases.json, against the committed render of
    the talos profile."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.log = load(HERE / "testdata/riptide-eventlog.json")
        cls.profile = load(RENDERED)
        cls.cases = load(HERE / "testdata/cases.json")["cases"]

    def test_cases(self) -> None:
        for case in self.cases:
            with self.subTest(case["name"]):
                profile = copy.deepcopy(self.profile)
                profile.update(case["override"])
                self.assertEqual(policy.evaluate_profile(profile, self.log), case["expect"])


class LogShapes(unittest.TestCase):
    """What the Go side cannot express as a profile change: a log that says
    something else."""

    def setUp(self) -> None:
        self.log = load(HERE / "testdata/riptide-eventlog.json")
        self.profile = load(RENDERED)

    def events(self, kind: str, name: str | None = None) -> list[dict]:
        return [
            e
            for e in self.log["events"]
            if e["EventType"] == kind and (name is None or e["Event"].get("UnicodeName") == name)
        ]

    def test_secure_boot_off(self) -> None:
        self.events(policy.EV_VARIABLE_DRIVER_CONFIG, "SecureBoot")[0]["Event"]["VariableData"]["Enabled"] = "No"
        self.assertEqual(policy.evaluate_profile(self.profile, self.log), ["Secure Boot is off"])

    def test_a_hash_in_db_is_counted(self) -> None:
        db = self.events(policy.EV_VARIABLE_DRIVER_CONFIG, "db")[0]["Event"]["VariableData"]
        db.append(
            {
                "SignatureType": "c1c41626-504c-4092-aca9-41f936934328",
                "Keys": [{"SignatureOwner": "00000000-0000-0000-0000-000000000000", "SignatureData": "00" * 32}],
            }
        )
        self.assertEqual(policy.evaluate_profile(self.profile, self.log), ["db holds 1 image hashes"])

    def test_an_authority_before_the_separator_is_bounded(self) -> None:
        events = self.log["events"]
        authority = copy.deepcopy(self.events(policy.EV_VARIABLE_AUTHORITY)[0])
        authority["Event"]["VariableData"][0]["SignatureData"] = "3082" + "00" * 30
        separator = next(i for i, e in enumerate(events) if e["PCRIndex"] == 7 and e["EventType"] == policy.EV_SEPARATOR)
        events.insert(separator, authority)
        got = policy.evaluate_profile(self.profile, self.log)
        self.assertEqual(len(got), 1)
        self.assertTrue(got[0].startswith("A pre-separator authority holds "), got)

    def test_no_secure_boot_variable_is_not_a_secure_boot_log(self) -> None:
        self.log["events"] = [e for e in self.log["events"] if e["PCRIndex"] != 7]
        got = policy.evaluate_profile(self.profile, self.log)
        self.assertEqual(got, ["PCR 7 does not parse as a Secure Boot log: no SecureBoot variable is measured"])

    def test_pinned_applications_need_one_after_the_separator(self) -> None:
        self.profile["boot_applications"] = ["a7aaadd78bbcd9bf1af39ca49fceebba1c386a2e74f652f303fb3c412dcfab4d"]
        self.log["events"] = [e for e in self.log["events"] if e["PCRIndex"] != 4]
        self.assertEqual(
            policy.evaluate_profile(self.profile, self.log),
            ["PCR 4 records no boot application after its separator"],
        )


class Fingerprints(unittest.TestCase):
    def test_fingerprint_is_sha256_of_der(self) -> None:
        import hashlib

        self.assertEqual(policy.fingerprint("3000"), hashlib.sha256(b"\x30\x00").hexdigest())


if __name__ == "__main__":
    unittest.main()
