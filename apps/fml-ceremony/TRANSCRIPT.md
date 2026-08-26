# The FML ceremony transcript, v1

What the ceremony publishes, how it is serialised, and how a stranger checks it.

The transcript is **public by design**. It contains hashes, public keys,
thresholds and procedure, and nothing else. Publishing it is the point: a
ceremony nobody can audit is a story, and the whole reason this key tree exists
in a public repository is that the method should be checkable by people who have
no reason to trust the operator.

`SPEC.md` in this directory is normative for the derivation. This document is
normative for the transcript. The two are versioned independently: the schema
version below changes when the document shape changes, and that is explicitly
**not** a reason to bump any path version (`SPEC.md` section 4.2).

Implemented by `transcript/` in this module, written by the ceremony binary, and
checked by `apps/fml-attest`.

## 1. The rule for what belongs in it

The field list in section 5 will change. This rule is what decides the change,
and it is three questions in order. An operator applies it in the room, under
pressure, with people waiting.

**1. Could this value help anyone reconstruct a secret?**
If yes, it stays out. There is no "but it is only a digest" exemption: a digest
is publishable only when the thing digested has at least 128 bits of
min-entropy, which is the same floor `entropy.WitnessFloorBits` applies to a
source's contribution. Every digest in section 5 is over a full 256-bit secret;
that is not luck, it is the reason those are the only digests here.

**2. Does it name or locate a person or a place?**
If yes, it stays out. The roster is private (`.agent/plans/`), the method is
public. "Two witnesses" is a fact about the procedure. "Alice and Bob, at the
house on the hill" is a roster entry and a map to a safe.

There is exactly one named person in the schema: the **signer**. That is
deliberate and it is not an exception being smuggled — the signature exists to
put a name behind the claim, and a signature with no identity attached
adjudicates nothing. The signer is not a share holder. No field in this schema
can name a share holder, and `fml-attest` refuses any field it does not know, so
one cannot be added quietly.

**3. Can a stranger do something with it?**
Either *check* it — recompute a hash, verify a signature, parse a certificate —
or *act* on it — know which spec text, which commit, which image to fetch. If it
is neither checkable nor actionable, it is decoration and it stays out.

**The tiebreaker, for when the three questions do not settle it: leave it out.**
A field that turns out to be missing can be added in a superseding transcript,
signed again, at the cost of an afternoon. A secret that turns out to have been
published cannot be unpublished at any cost. The asymmetry is total, so the
default is out.

### What this rule excludes, worked

| Not in the transcript | Which question |
| --- | --- |
| The master seed, any branch secret, any leaf private key, any mnemonic | 1 |
| Any SLIP-39 share, or any word of one | 1 |
| The raw bytes any entropy source contributed | 1 |
| A digest of a low-entropy contribution, such as a short operator-typed string | 1 |
| Who holds which share, how many people are at which site, where a safe is | 2 |
| A per-entry wall-clock reading | 3 — the chain gives order, and an air-gapped RTC is not evidence |
| Subject, serial and validity restated beside a certificate | 3 — they are inside the DER, and a restatement is only something to disagree with |
| A digest of the wallet mnemonic | 3, then 1 — its branch already carries a check digest, so it adds only a way to confirm that a candidate wallet belongs to this estate |

### It never goes in `docs/`

`docs/` is the public Logseq wiki, and the repository rule is that nothing
decrypted goes there. Nothing in this schema is decrypted material, so the rule
is not what keeps the transcript out — but the transcript still does not live
there, for a different reason: it is a **byte-exact signed artifact**, and the
wiki is a renderer. A page that reformats a transcript by one byte has destroyed
the signature over it.

Transcripts live at `apps/fml-ceremony/transcripts/<ceremony>.json`, beside
`<ceremony>.json.sig` and the `allowed_signers` file that names the signing key.
A wiki page may link to that path. It may not contain it.

## 2. Serialisation

**RFC 8785 (JCS) canonical JSON**, implemented in `jcs/`.

A signature is over bytes, so the encoding must be byte-stable forever, which
plain JSON is not — member order, whitespace and escaping are all free
variables. CBOR has a deterministic profile and would also work, but the Go
standard library has no CBOR codec, and a transcript meant to be read by
strangers should not require them to install a decoder to see what it says.
`jcs/` passes the published RFC 8785 reference vectors, including the number
table in Appendix B and the UTF-16 property ordering that separates it from
naive byte sorting.

Two consequences worth stating out loud:

- **The file has no trailing newline.** The signature covers the file as it is,
  and canonical form ends at `}`. A newline an editor added is a signature that
  no longer verifies; `fml-attest` says so in those words when it sees one.
- **A canonical document cannot say two things at once.** `jcs.Canonical`
  refuses duplicate object keys and trailing data outright, and re-serialising a
  canonical document reproduces it exactly. So "the file equals its own
  canonical form" — `fml-attest`'s first check — rules out a document that shows
  one value to a human reader and another to a parser.

## 3. Hash-chained incrementally, signed once

**Every entry commits to the one before it, and the transcript is written to
disk after each entry. The signature is applied once, after the ceremony, off
the air gap.**

The chain: entry 0's `prev` is 64 zeros; entry *k*'s `prev` is the SHA-256 of
entry *k-1*'s canonical bytes. Since each entry contains its predecessor's
digest, the head commits transitively to everything.

Signing incrementally was the alternative, and it does not survive contact with
where the key lives. The signing key is the operator's SSH key in 1Password,
reached through `op-ssh-sign`, which does not exist on an air-gapped host and
must not be carried onto one — the threat model says that host may be
compromised, and a fleet-wide credential is the last thing to hand it. So the
only in-ceremony signature available would be from a key minted during the
ceremony, held by the operator, and destroyed after. Against the failure this is
supposed to resist — a ceremony abandoned midway, re-run, and only the
convenient run published — that signature buys nothing, because the party who
would hide the first run is the same party holding the ephemeral key.

What actually resists it costs no code at all. **The head digest is read aloud
after every entry, and the witnesses write it down.** A witness holding a digest
that appears in no published chain is holding a contradiction, and they hold it
independently of the operator, the binary and the key. That is the property
incremental signing was reaching for, and the hash chain is what makes the
digest meaningful — a head that does not commit to the entries before it can be
re-derived by a second run.

The chain also gives the smaller thing for free: a ceremony that stops halfway
leaves a short chain rather than no evidence. And it makes abandonment
*sayable* — the close entry's `outcome` is `complete` or `aborted`, so an
abandoned ceremony gets published as an abandoned ceremony, which is the only
way a reader can tell it apart from a ceremony that was never published at all.

## 4. Document shape

```json
{
  "schema": "fml-ceremony/transcript/v1",
  "ceremony": "<identifier, no location>",
  "entries": [ { "seq": 0, "step": "open", "prev": "00…00", "body": { … } }, … ]
}
```

Three top-level members and nothing else. Everything the ceremony records is an
entry, because anything outside the chain is unordered and uncommitted.

Entries appear in the order they happened: `open` first, `close` last, exactly
one of each. `fml-attest` rejects an unknown `step`, and rejects an unknown
field in any body, so nothing can ride along unreviewed.

## 5. The entries

### `open`

| Field | What it is |
| --- | --- |
| `notes` | The disclaimer, verbatim: a signature proves who vouches, not which binary ran. Inside the signed bytes so it cannot be stripped. |
| `spec_sha256` | SHA-256 of `SPEC.md`, naming the exact derivation text |
| `vcs_ref` | The pushed commit or tag the binary and image were built from |
| `platform`, `toolchain`, `build` | Enough to rebuild the binary and compare |
| `binary_sha256` | The ceremony binary's hash |
| `image_ref`, `image_sha256` | The boot image's flake reference and hash |
| `hardware` | The machine, as a sentence |
| `witnesses` | How many people watched. A count, never names. |
| `signer_identity`, `signer_ssh_fingerprint`, `signature_namespace`, `allowed_signers` | Everything `ssh-keygen -Y verify` needs |
| `pinned_time` | The single instant the ceremony declares |

`pinned_time` is the only timestamp in the whole document. Certificate
`notBefore` comes from it rather than from the clock, which is what makes a
certificate reproducible — mint it twice from the same seed, template and pinned
time and the DER is identical, because Ed25519 signatures are deterministic.
`fml-attest` checks each certificate's `notBefore` against it. An air-gapped host
has no NTP and its RTC is not evidence of anything, so nothing else here is a
clock reading.

### `entropy`

`mix` names the mixing construction and its version. `sources` is one object per
contribution: `label`, `bytes` contributed, `min_entropy_bits`, and
`witness_sha256` — a digest proving the source took part without publishing what
it contributed. The digest is **omitted** below the 128-bit floor, and
`fml-attest` fails a transcript that publishes one anyway. The dice source
additionally carries `tally`, the six face counts the operator compared against
their paper worksheet.

### `shards`

One entry per share set. Four in a v1 ceremony: `master` at 3-of-5, and each
minted branch at 2-of-3.

`secret` (`master`, or a branch path), `encoding`, `threshold`, `shares`,
`extendable`, `iteration_exponent`, `identifier`, `check_sha256`.

`identifier` is SLIP-39's 15-bit set id, which is printed on every share of the
set already — publishing it leaks nothing and lets a holder confirm the plate in
their hand belongs to this ceremony. `check_sha256` is
`SHA-256("fml-shard-check-v1" || secret)`: a quorum that has just reconstituted
a secret can confirm they rebuilt the right one *before* deriving anything from
it. It is a 2^256 target, and it is domain-separated from every other hash over
the same bytes so that a mistake elsewhere cannot produce a matching value.

**Thresholds only. No holder, ever.** There is no field for one.

### `leaf`

One entry per derived key, as its public half: `path`, `key_type`, and then
exactly one of `public` (32-byte hex, Ed25519), `recipient` (an `age1…` string),
or `words` (24, for a BIP-39 mnemonic — a mnemonic has no public half, and
nothing derived from it is published).

`path` must satisfy `SPEC.md` section 3 and must not be under a reserved branch:
material under `fml/kms` or `fml/ssh` would have no share set, which is the
precise failure the two-tier quorum exists to prevent.

### `certificate`

`role`, `key_path`, `sha256`, and `der` — the certificate itself, base64 DER.

The certificate travels **inside** the transcript rather than beside it. That is
what turns this section from an assertion into evidence: `fml-attest` parses the
DER, confirms it hashes to the declared fingerprint, confirms its public key is
one the transcript already declared as a derived leaf, and verifies the root's
self-signature and the intermediate's signature under it. Subject, serial and
validity are inside the DER and are not restated.

The certificate profile itself is not this document's business.

### `reserved`

`names`: the branch names deliberately not minted. Reading the transcript then
tells you what was left out on purpose, rather than leaving a reader to wonder
whether something was forgotten.

### `close`

`outcome` (`complete` or `aborted`) and `attestations`: the procedural claims the
signer is accountable for and **nobody can check** — that the host was
air-gapped, that the binary hash was computed on a second machine and read
aloud, that the shares were read back word by word before sealing. `fml-attest`
prints them under a heading that says exactly that.

## 6. Verifying one, from no context

You need: a clone of this repository, a Go toolchain, and `ssh-keygen`. You do
not need the operator, the hardware, or any secret.

**1. Check the transcript is internally sound.**

```
go -C apps/fml-attest run . ../fml-ceremony/transcripts/<ceremony>.json
```

It prints the checks it made, the claims it could only echo, and the SHA-256 of
the canonical bytes. It does not touch a key and cannot; that is why it is safe
to run.

**2. Check the signature.** `fml-attest` deliberately does not: the Go standard
library has no SSH support, and hand-rolling SSHSIG parsing inside the one
artifact whose value is being small would defeat the purpose. Use the tool you
already trust — `fml-attest` prints this line filled in:

```
ssh-keygen -Y verify -f apps/fml-ceremony/allowed_signers \
  -I <signer> -n fml-ceremony-transcript \
  -s <ceremony>.json.sig < <ceremony>.json
```

A good signature says a named identity vouches for these exact bytes. The
namespace matters: a transcript signature can never be replayed as a commit
signature or an SSH login.

**3. Rebuild the binary and compare.** From the `vcs_ref` the transcript names,
with the `build` command it names:

```
git checkout <vcs_ref>
CGO_ENABLED=0 go build -trimpath -buildvcs=false -o /tmp/fml-ceremony ./apps/fml-ceremony
sha256sum /tmp/fml-ceremony      # compare with binary_sha256
```

`-buildvcs=false` is not optional: Go otherwise stamps the commit and a dirty
flag into the binary, and a clean clone produces a different hash for a reason
that has nothing to do with tampering. There are no module dependencies, so the
toolchain version and the source are the only inputs.

**4. Rebuild the image and compare.** `nix build <image_ref> --rebuild`, or with
`--option substituters ""`. Without one of those you are handed the cached
artifact and have reproduced nothing.

**5. Replay the derivation.** Here is the honest part: **you cannot replay a
real ceremony's derivation, and neither can anyone else without a quorum.**
Derivation is a keyed function of the master seed; there is no public input to
replay from. What you can do instead, and what actually establishes the same
thing:

- Run `go -C apps/fml-ceremony test ./...`. The derivation is pinned against
  `SPEC.md`'s published test vectors, and `apps/fml-derive-rs` — written from
  the spec text alone by someone who was not allowed to read the Go — has to
  agree byte for byte.
- Check `spec_sha256` against `sha256sum apps/fml-ceremony/SPEC.md` at the
  `vcs_ref` the transcript names. That is what fixes which arithmetic was run.
- Verify the fixture in `testdata/transcript.example.json` with `fml-attest`.
  It is a rehearsal on `SPEC.md` vector A — the published all-zero master — so
  every public key in it can be checked against section 11 of the spec by hand,
  and the tool's own agreement can be confirmed against something you can
  recompute.

A holder of a branch's 2-of-3 can do better: reconstitute the branch secret,
confirm it against that set's `check_sha256`, and re-derive every leaf under it.
The public keys must match the transcript. That is a full replay of one subtree
without the master ever existing again.

## 7. What a fully successful verification does not prove

Read this before concluding anything.

It does **not** prove which binary produced the transcript. Nothing on the
ceremony host measured the running code, so every `*_sha256` field is an
operator assertion. A tampered binary would produce an internally perfect
transcript: `fml-attest` would report OK, the Rust implementation would agree,
and the published fingerprint would read as the honest one, because it is a
string the binary filled in. What stands against that is procedural — a second
machine, a second person, a second tool, and witnesses named in the count — and
it is written down here rather than dressed up as cryptography.

It does not prove the host was air-gapped, that the entropy inputs were as
described, that the shares were distributed as claimed, or that a ceremony
occurred at all. Those rest on the procedure and on the people in the room.

What it does prove: this document is internally consistent, these certificates
carry these declared keys and chain to this root, this share structure is what
it says, the named source builds reproducibly to the stated hash, and a named
person is accountable for the whole claim.
