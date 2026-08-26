# FML derivation spec, v1

How the Folly Mountain Laboratories key tree is derived from one 256-bit master
seed. This document is normative: it defines byte-exact outputs, and any two
implementations that follow it MUST agree on every test vector in section 11.

It is deliberately plain Markdown rather than a wiki page, because the notation
here has to survive verbatim and a renderer is one more thing that can change
under it. It lives in a public repository at `apps/fml-ceremony/SPEC.md`, is
versioned in git, and the ceremony transcript records this file's SHA-256 so a
transcript names the exact text it ran under. The method is public; only who
holds which share is not.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted
as in RFC 2119.

## 1. Scope

In scope: the labelled derivation tree, from master seed to key material, and
the mapping from derived bytes to each key type.

Out of scope, specified elsewhere: how a secret is split into shares and
recorded physically; the certificate profile the derived Ed25519 keys are minted
into; the ceremony transcript; the cutover ordering.

Vocabulary used throughout:

| Term | Meaning |
| --- | --- |
| **master seed** | The single 256-bit secret that survives the ceremony. Root of everything. Has no label. |
| **branch secret** | A 256-bit secret derived from the master under a branch path. Sharded, held at sites. |
| **leaf key** | Key material derived from a branch secret under a leaf path. Never sharded; regenerated on demand. |
| **path** | The `/`-joined label naming a branch or a leaf. |
| **OKM** | HKDF-Expand output keying material. |
| **PRK** | HKDF-Extract pseudorandom key. |

The tree is exactly three levels deep — master, branch, leaf — and this spec
does not define a fourth. A leaf key is a terminal; nothing is derived from it.

## 2. The master seed

The master seed is **exactly 32 octets (256 bits)**. It is an opaque octet
string. It has no internal structure, no checksum, no version field, and no
label. Its only representations are:

- **In memory and in test vectors:** 32 octets, written as 64 lowercase hex
  characters.
- **At rest, off the ceremony host:** a SLIP-39 share set, 3-of-5, with an
  **empty passphrase**. Section 8 states the interface; the encoding itself is
  specified separately.

The master seed is never written to disk in plaintext, never appears in the
transcript, and is never transmitted. It exists in RAM during the ceremony and
in the heads and hands of five people afterwards.

A master seed of any length other than 32 octets is invalid. See section 9.

The master is not versioned. If the master must be replaced, that is a new
ceremony producing a new, unrelated tree — not a version bump. Nothing in this
spec provides a path from one master to another.

## 3. Paths and labels

### 3.1 Syntax

A **path** is one or more **components** joined by the separator `/` (U+002F,
one octet, `0x2F`).

A component MUST match:

```
component  = lowercase-letter *( lowercase-letter / digit / "-" )
```

That is: ASCII `a`–`z` for the first octet, then ASCII `a`–`z`, `0`–`9` or `-`
(`0x2D`) for the rest. A component is never empty.

A **version component** is a component that additionally matches:

```
version    = "v" nonzero-digit *digit
```

`v1`, `v2`, `v17` are versions. `v0`, `v01`, `v1.0`, `V1`, `v` are not.

A path MUST additionally satisfy all of:

- Its first component is `fml`.
- It has no leading or trailing `/`, and no empty component (no `//`).
- Its last component is a version component.
- It is at most 128 octets long and has at most 16 components.

A **branch path** has exactly 3 components: `fml` / *branch-name* / *version*.

A **leaf path** is a branch path followed by at least two more components, the
last of which is a version component. The minimum leaf path therefore has 5
components.

The `info` and `salt` values fed to HKDF are the ASCII octets of these strings,
with **no NUL terminator and no length prefix**. ASCII and UTF-8 coincide over
this charset, so there is no encoding choice to get wrong.

### 3.2 Why domain separation is airtight

`/` is not in the component charset. The map from a component list to its joined
string is therefore **injective**: splitting the string on `/` recovers exactly
the component list it was built from, always. Two distinct paths consequently
have distinct `info` octet strings, and HKDF-Expand outputs under distinct
`info` for the same PRK are computationally independent.

That one paragraph is the entire domain-separation argument, and it holds *only*
while the charset rule holds. A component permitted to contain `/` would let
`["a/b", "c"]` and `["a", "b/c"]` join to the same string and derive the same
key — the classic separator-injection bug. This is why section 9 makes the
charset a MUST-reject rather than a convention.

### 3.3 Rejection, not sanitisation

An implementation given a path that fails section 3.1 MUST **abort**. It MUST
NOT normalise, lowercase, percent-encode, URL-escape, collapse repeated
separators, strip whitespace, resolve `.` or `..`, or substitute a default.

Sanitising silently maps two distinct operator intents onto one key, and the
operator learns about it years later when a key they expected to be distinct is
not. Rejecting turns a typo into a stopped ceremony, which is the correct
failure for a procedure that runs twice a decade with five people in the room.

### 3.4 A leaf must descend from the branch deriving it

`DeriveLeaf` (section 5) takes both the branch secret and the branch path,
because a 32-octet branch secret carries no evidence of which branch it is. An
implementation MUST verify that the leaf path has *branchPath* + `"/"` as a
prefix, and MUST abort otherwise.

Without that check, a holder of the `fml/wallet/v1` secret who passes an
`fml/infra/...` leaf path gets a perfectly well-formed key that no one else will
ever reproduce — silently, with no error, and discovered only when the key is
needed.

## 4. Versioning

**Versions are per-node, not global.** Every branch and every leaf carries its
own version component, and they move independently:
`fml/infra/v1/pki/root/v2` is a normal, expected path.

The justification is one line: rotating one leaf must not force every sibling
and cousin to change, and a single global spec version would re-mint the entire
estate to replace one key.

### 4.1 What obliges a bump

| Event | Bump |
| --- | --- |
| A leaf's private key must change — compromise, suspicion, or policy | that leaf's version |
| A leaf changes key type or output length (see 4.3) | that leaf's version |
| A branch secret is compromised, or its share set is rebuilt from scratch | that branch's version |
| The master must change | none — new ceremony, new tree |

A branch bump changes the branch's path, which is part of every descendant
leaf's `info`, so **every leaf under that branch changes too**. A branch bump is
an estate-wide event for that branch and is not a routine operation.

### 4.2 What does not oblige a bump

Reissuing a certificate for the same key. Adding a new sibling leaf. Changing
who holds the shares, or how many people hold them. Changing the physical share
medium. Changing the transcript schema, the ceremony binary, or the Go
toolchain. Choosing a different key type for a *new* leaf.

### 4.3 Output length is not bound into `info`

RFC 5869 does not mix the requested length `L` into the expansion input, so
HKDF-Expand at `L = 32` returns exactly the first 32 octets of the same call at
`L = 64`. Two leaves at the same path with different lengths would therefore be
prefix-related rather than independent.

This spec closes that by fixing a leaf's key type — and therefore its `L` — as
part of the tree declaration in section 6. Changing a declared leaf's key type
requires a version bump precisely because of this.

### 4.4 Old versions stay derivable

Derivation is a pure function of the master seed and a path. Nothing is
consumed, deleted or ratcheted. `v1` remains computable forever after `v2`
exists, which is exactly what makes an overlap window possible: the old key can
keep verifying while the new one is rolled out.

### 4.5 Adding a branch later

This is the entire reason the master survives the ceremony, so it is worth
confirming that it works rather than assuming it.

Level 1 needs only the master seed and the new branch path. To add a branch:
reconstitute the master from 3-of-5, derive the new branch secret, split it
2-of-3, distribute, destroy the master copy. Existing branches and their leaves
are untouched and are never re-derived, because a pure function of unchanged
inputs returns unchanged outputs. **No existing branch holder needs to be
present.**

Adding a *leaf* under an existing branch is smaller still: it needs only that
branch's 2-of-3, not the master and not a ceremony.

## 5. Derivation

The hash is **SHA-256** at every level. HKDF is RFC 5869.

Two fixed salt strings, ASCII, no version component in either:

```
saltMaster = "fml-derive-master"
saltBranch = "fml-derive-branch"
```

The two levels already differ in their IKM, so the salts are not load-bearing
for separation. They are there so that an implementation which confuses the
levels produces visibly different bytes instead of a plausible-looking wrong
answer.

### 5.1 Level 1 — master to branch secret

```
PRK_master    = HKDF-Extract(hash = SHA-256, salt = saltMaster, IKM = masterSeed)
branchSecret  = HKDF-Expand(hash = SHA-256, PRK = PRK_master, info = branchPath, L = 32)
```

`branchSecret` is always 32 octets, whatever the branch is for. It is a
sharding input, never a key.

### 5.2 Level 2 — branch secret to leaf key material

```
PRK_branch = HKDF-Extract(hash = SHA-256, salt = saltBranch, IKM = branchSecret)
OKM        = HKDF-Expand(hash = SHA-256, PRK = PRK_branch, info = leafPath, L = <by key type>)
```

`L` MUST satisfy `1 <= L <= 255 x HashLen`, which for SHA-256 is 8160 octets.
The upper bound is RFC 5869's own limit on HKDF-Expand. The lower bound is
stated here because RFC 5869 does not state it and an `L` of zero expands to
the empty string, which is not key material: two implementations read the
silence differently and disagreed on exactly that input.

`info` at **both** levels is the **full absolute path** from the root of the
tree, not a relative suffix. Level 1 uses `fml/infra/v1`; level 2 uses
`fml/infra/v1/pki/root/v1`, including the branch prefix that already selected
the branch secret. Binding the branch into the leaf's `info` as well costs
nothing and means a leaf name reused under two branches cannot collide even
under an implementation bug at level 1.

Chaining is what lets a branch-secret holder work alone: given `branchSecret`
and the branch path, every leaf under that branch is computable **without the
master seed**. That is the two-tier quorum expressed in arithmetic.

### 5.3 Notes for implementers

`crypto/hkdf` in the Go standard library exposes three functions, and this spec
uses them as follows:

```go
prk, err := hkdf.Extract(sha256.New, masterSeed, []byte(saltMaster))
okm, err := hkdf.Expand(sha256.New, prk, branchPath, 32)
```

**Go's `Extract` takes `(secret, salt)` — the reverse of RFC 5869's
`HKDF-Extract(salt, IKM)` prose ordering.** Swapping them yields a well-formed
wrong answer with no error. This is the single most likely place for two
implementations to disagree, which is why the test vectors publish every PRK.

`hkdf.Key(h, secret, salt, info, L)` is exactly `Expand(Extract(...))` and an
implementation MAY use it in place of the two calls at either level. This spec
names Extract and Expand separately only so the intermediate PRKs can be pinned
in section 11 and a mismatch localised to a level.

A Rust or other reimplementation gets no such convenience and must follow RFC
5869 directly: `PRK = HMAC-SHA256(key = salt, data = IKM)`, then
`T(i) = HMAC-SHA256(key = PRK, data = T(i-1) || info || byte(i))` with `T(0)`
empty, `OKM` the first `L` octets of `T(1) || T(2) || ...`.

## 6. The v1 tree

### 6.1 Branches

| Branch path | Status | Quorum | Held by |
| --- | --- | --- | --- |
| `fml/infra/v1` | minted | 2-of-3 | sites |
| `fml/wallet/v1` | minted | 2-of-3 | sites |
| `fml/kms` | **reserved name only** | none | nobody |
| `fml/ssh` | **reserved name only** | none | nobody |

The master seed itself is 3-of-5, held by people. Each minted branch is its own
separate SLIP-39 secret at 2-of-3 — four distinct secrets and four distinct
share sets in total, not four groups of one secret.

**Reserving a name mints nothing.** `fml/kms` and `fml/ssh` have no version
component here because no version of them exists. No secret is derived under
them, no share set is created, no key material is generated, and the transcript
records only that the names are spoken for. The reservation exists so a future
branch cannot be given a name that already means something to somebody, and so
that reading this table tells you what was deliberately not built.

The ceremony MUST refuse to derive under a reserved branch. Material derived
there would have no share set, so losing the master would lose it — which is the
precise failure the two-tier quorum exists to prevent.

### 6.2 Leaves

| Leaf path | Key type | L | Purpose |
| --- | --- | --- | --- |
| `fml/infra/v1/pki/root/v1` | Ed25519 | 32 | FML Root CA signing key |
| `fml/infra/v1/pki/intermediate/v1` | Ed25519 | 32 | FML Intermediate CA signing key |
| `fml/infra/v1/age/operator/v1` | X25519 (age) | 32 | age recipient for SOPS-encrypted material |
| `fml/wallet/v1/cold/v1` | BIP-39 | 32 | 24-word mnemonic, handed to wallet software |

Four leaves, three key types, two branches. That is the whole of v1.

The age leaf is an **additional** SOPS recipient, added alongside the operator
key already in `.sops.yaml`; it does not replace it as part of minting, and
minting it changes no encrypted plaintext. The Ed25519 leaves replace the
existing FML Root and Intermediate private keys, which is a re-birth and has
consequences the cutover plan owns.

Leaves are **never sharded**. A leaf key is regenerated from its branch secret
whenever it is needed, so there is nothing to lose and nothing to store.

## 7. Key-type mappings

Every mapping below starts from the level-2 OKM of section 5.2 and is
deterministic: same OKM, same key, forever.

### 7.1 Ed25519

`L = 32`. The OKM **is** the Ed25519 seed.

```
seed = OKM                          (32 octets)
priv = ed25519.NewKeyFromSeed(seed) (RFC 8032 §5.1.5)
pub  = priv[32:64]
```

Every 32-octet string is a valid Ed25519 seed — RFC 8032 hashes the seed to
produce the scalar, so there is no rejection sampling, no retry loop, and no
invalid seed. The `L = 32` OKM maps onto the key space with no conditioning at
all.

RFC 8032 signatures are deterministic, so a certificate minted twice from the
same seed, the same template and the same timestamps is bit-identical. That
property is why the anchors are Ed25519 and not ECDSA.

### 7.2 X25519, as an age identity

`L = 32`. Verified against the age specification (C2SP `age.md`), which states
that an X25519 identity is `read(CSPRNG, 32)` encoded as Bech32 with HRP
`AGE-SECRET-KEY-`, and the recipient is `X25519(identity, basepoint)` encoded as
Bech32 with HRP `age`.

```
identity  = OKM                                  (32 octets, used verbatim)
recipient = X25519(identity, basepoint)          (RFC 7748 §5, basepoint from §4.1)
```

The identity octets are stored **unclamped**. RFC 7748's `X25519` clamps the
scalar internally as part of `decodeScalar25519`; the identity string carries
the pre-clamp bytes, exactly as age itself does.

Encoding:

```
identityString  = ToUpper( Bech32( "AGE-SECRET-KEY-", convertbits(identity,  8, 5, pad=true) ) )
recipientString =          Bech32( "age",             convertbits(recipient, 8, 5, pad=true) )
```

- Bech32 is **BIP-173** (checksum constant `1`), not Bech32m. The age spec
  removes BIP-173's 90-character limit; nothing here reaches it regardless.
- Bech32 strings are all-uppercase or all-lowercase, and the **checksum is
  always computed over the lowercase form**. The identity is produced by
  building the lowercase string and uppercasing the whole result — including the
  data and checksum characters, which come from the lowercase charset
  `qpzry9x8gf2tvdw0s3jn54khce6mua7l`.
- The HRP `AGE-SECRET-KEY-` already ends in `-`; Bech32's own separator `1`
  follows it, giving strings that begin `AGE-SECRET-KEY-1`.

Bech32 is not in the Go standard library and must be implemented in-repo. It is
about forty lines, and section 11 pins it against the age specification's own
published example pair.

If `X25519(identity, basepoint)` is the all-zero output, the implementation MUST
abort rather than emit the identity — see section 9. Write the check out; do not
assume a library performs it. RFC 7748's clamping makes the all-zero output
unreachable for *basepoint* multiplication — the clamped scalar is `2^254 + 8k`,
and no multiple of the group order in that range is divisible by 8 — and Go's
`crypto/ecdh` accepts an all-zero private key without complaint. The MUST stands
because the reasoning above is about this one multiplication and not about
X25519 generally.

### 7.3 BIP-39 mnemonic

`L = 32`. Verified against BIP-39 itself.

```
ENT      = 256 bits                        (the OKM, 32 octets)
CS       = ENT / 32 = 8 bits               (the first octet of SHA-256(ENT))
bits     = ENT || CS                       (264 bits)
indices  = bits split into 24 groups of 11, most-significant bit first
mnemonic = wordlist[indices] joined by a single ASCII space (0x20)
```

- The wordlist is the BIP-39 **English** list, 2048 words, one per line. Pin it
  by content, not by URL:
  `SHA-256 = 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`
  over the file including its trailing newline. An implementation MUST verify
  this hash over its embedded copy before use.
- Words are ASCII in the English list; BIP-39's NFKD normalisation requirement
  is therefore a no-op here, but an implementation MUST NOT substitute a
  different language's list, which would change every mnemonic.
- The ceremony emits the **mnemonic only**. It does **not** compute BIP-39's
  `mnemonic → seed` step (PBKDF2-HMAC-SHA512, 2048 iterations, salt
  `"mnemonic"` || passphrase), and it derives no addresses and touches no curve.
  Real wallet software owns everything downstream of the 24 words. This is the
  boundary that keeps the ceremony standard-library-only.
- **No BIP-39 passphrase.** A passphrase the operator can forget is a liability
  against the death threat, which is in scope.

## 8. Interface to share encoding

The encoding is specified separately. What this spec fixes is the interface:

- The master seed and every branch secret are **each exactly 256 bits** of
  opaque octets, directly usable as a SLIP-39 master secret (SLIP-39 requires a
  secret of at least 128 bits and a whole number of octets; 256 bits yields
  33-word shares).
- **Four separate secrets, four separate share sets.** The master at 3-of-5 and
  each branch at 2-of-3 are distinct SLIP-39 encodings of distinct secrets. They
  are *not* groups within one SLIP-39 share structure. Recovering a branch
  requires 2 of that branch's 3 shares and nothing else; recovering the master
  requires 3 of its 5 and nothing else.
- **No SLIP-39 passphrase** — the empty passphrase — at every level, for the
  same reason as 7.3.
- Leaf keys are never encoded as shares at all.

## 9. What an implementation must reject

Aborting is always correct. Guessing never is.

**Master seed**

- Any length other than exactly 32 octets.
- The ceremony (as distinct from the derivation library) MUST additionally
  refuse a master seed that is all-zero or all-`0xFF`, as evidence that entropy
  collection failed. The derivation library MUST NOT reject these, because
  vector A in section 11 depends on the all-zero master being derivable.

**Paths**

- Any component violating the charset of 3.1: uppercase, underscore, dot,
  space, non-ASCII, leading digit or hyphen, or empty.
- A component containing the separator `/`. This one is called out separately
  from the charset because it is the bug this section exists for.
- Leading `/`, trailing `/`, or `//`.
- A first component other than `fml`.
- A final component that is not a version, or a malformed version: `v0`, `v01`,
  `V1`, `v1.0`, `v`.
- Over 128 octets, or over 16 components.
- A branch path with a component count other than 3; a leaf path with fewer than
  5 components.
- A leaf path that is not a strict descendant of the branch path it is being
  derived under (3.4).

**Tree membership**

- The *ceremony* MUST refuse to mint any path not declared in section 6.2, and
  MUST refuse any path under a reserved branch name (`fml/kms`, `fml/ssh`).
- A *verifier* MAY derive any path that is well-formed under section 3, because
  refusing to check arithmetic is not a security property.
- A version higher than any declared in section 6 is, for the ceremony, simply
  an undeclared path: it is rejected until a revision of this document declares
  it. There is no implicit "latest".

**Key material**

- An `X25519(identity, basepoint)` result of all zeroes.
- A BIP-39 wordlist whose SHA-256 does not match 7.3, or that does not have
  exactly 2048 entries.
- An OKM whose length does not match the `L` declared for that leaf's key type.
- An `L` outside `1 <= L <= 8160` (section 5.2).

**Bech32, on decode**

- Mixed-case input.
- A bad checksum.
- A character outside the charset.
- Non-zero bits in the 5-to-8 conversion padding.

## 10. Reference self-checks

Every non-stdlib mapping in this spec is pinned against its own standard's
published vectors. An implementation SHOULD run all of these before trusting
section 11.

| Check | Source | Expected |
| --- | --- | --- |
| HKDF Extract/Expand and Go's argument order | RFC 5869 test case 1 | `PRK = 077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5`, `OKM = 3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865` |
| Bech32 + X25519 + age encoding | age spec's own example pair | `AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX` decodes to `0x42` × 32 and re-encodes to itself; its recipient is `age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj` |
| BIP-39 mnemonic, 128-bit | BIP-39 vectors | entropy `00`×16 → `abandon` × 11 + `about` |
| BIP-39 mnemonic, 256-bit | BIP-39 vectors | entropy `ff`×32 → `zoo` × 23 + `vote` |
| Wordlist identity | BIP-39 `english.txt` | `SHA-256 = 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` |

## 11. Test vectors

Computed with Go 1.27's `crypto/hkdf`, `crypto/ed25519` and `crypto/ecdh`. All
hex is lowercase. Every intermediate PRK is published so that a disagreeing
implementation can be localised to a level rather than merely declared wrong.

Three masters:

- **A** — all zero. `0000...00`.
- **B** — the octets `0x00` through `0x1f` in order.
- **C** — `SHA-256("Folly Mountain Laboratories")`, the 27 ASCII octets with no
  trailing newline. Reproduce with
  `printf 'Folly Mountain Laboratories' | sha256sum`.

### Vector A

```
master        = 0000000000000000000000000000000000000000000000000000000000000000
PRK_master    = f1257b2cebf618f4c697b1a723f037dfa14cfac1bb89236402297e664040cca8

branch        = fml/infra/v1
branchSecret  = 4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37
PRK_branch    = 901e641ec9454662ec61507b972302100676d267e0aea42b9398007fe7998001

  leaf        = fml/infra/v1/pki/root/v1            (ed25519)
  okm/seed    = 08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c
  public      = 58fee0971a0cf4be8361f5e71f0533ece06be735c93405e9917640f532ff5b03

  leaf        = fml/infra/v1/pki/intermediate/v1    (ed25519)
  okm/seed    = 81686d1cb25f96f91efdb5158468278dab9e5c88fb6073e2bccf51da31bf6087
  public      = 5f017b89fc0875aa4f481e5a2e04f7afb9b246ae5bab905832f2ae126f9a20fd

  leaf        = fml/infra/v1/age/operator/v1        (x25519/age)
  okm         = 83d4f8384416a6993ec33a14bf8de272c2b9b34ff094ccab2d371c8100a55882
  identity    = AGE-SECRET-KEY-1S020SWZYZ6NFJ0KR8G2TLR0ZWTPTNV607Z2VE2EDXUWGZQ99TZPQ7YF972
  recipient   = age1uzf08nsuz0gwuz9ue0f80re672nfawute7ln8g2ys4vpyg60uu7skcqfru

branch        = fml/wallet/v1
branchSecret  = c5c1acdd22bc15d597a801efed2838e5cebcdfd6040fb6f98afc55e5f752c2c7
PRK_branch    = bea86c6ff6eb3a2bb79924bd5866994c8f8ae4fa823adc374f24cf0b010d2203

  leaf        = fml/wallet/v1/cold/v1               (bip39)
  okm/entropy = f1c1bd731a859764071fc6b24f3a92f0ef8c6a5da771f2b48aa68774f825e6e1
  checksum    = af
  mnemonic    = vault assume fresh crush floor rare broccoli web rather keep
                pigeon tide web cry isolate until verify picture predict
                auction exhibit base oppose curious
```

### Vector B

```
master        = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
PRK_master    = 6ad4324095d92137144e6d005e03a3e85dfec5b448e01994012d968ea8b63763

branch        = fml/infra/v1
branchSecret  = 64068319837cf282608f2591bfc2a06ef3ed574549ddb2c05e92cc0e509aa0ac
PRK_branch    = 2bc82a4f391257d687fe8997a79016cd0f3914e6f382e0db607948c010c56739

  leaf        = fml/infra/v1/pki/root/v1            (ed25519)
  okm/seed    = 128626be41ea7cc72968ae4ffd408e44af8e359e157ebb7cebd6eab4d2672c78
  public      = e1e0bde2195e3af2b40d5eb7bd33925ecf2d3a60db090c90748fea120b1542cd

  leaf        = fml/infra/v1/pki/intermediate/v1    (ed25519)
  okm/seed    = 3d763a5a094e39d6bcf2b56f7dbd1e3579b1a6fd825790815e146c638f6b924a
  public      = 7cbbbf893f9767b2bbb8a00c150ea2f03d4b378c188bf61a799405294d00f453

  leaf        = fml/infra/v1/age/operator/v1        (x25519/age)
  okm         = 2b2cb7e8e7293387b1dbdeead25ccee5828ee22f088a93010f8455c03d0fa0a8
  identity    = AGE-SECRET-KEY-19VKT06889YEC0VWMMM4DYHXWUKPGAC30PZ9FXQG0S32UQ0G05Z5Q5MQXGD
  recipient   = age13m7cc6eqq0q9782gf50nwz8h3x98a34dmd0z0s6w6n9ma5lqdq7s63dskq

branch        = fml/wallet/v1
branchSecret  = a587058479d177408f09e760a881c4e9d601d723bceff34f004ba1e4a853d7c7
PRK_branch    = 9d10a15bd4454e25e8485eb34a00c4f8a232304d75aab31dc14362ff24cd5e8d

  leaf        = fml/wallet/v1/cold/v1               (bip39)
  okm/entropy = e0f1446937b7d348afe56d366619c673a07443cd1610132dd901d332b1c06745
  checksum    = ca
  mnemonic    = thought mechanic bottom hunt large picture sauce pumpkin cushion
                cotton immense trap also capable crowd search basket human
                document please climb then other rich
```

### Vector C

```
master        = 2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218
PRK_master    = 12ef3be531acf418a8c669e434829467187a634592b09419261b0bd57805e1b9

branch        = fml/infra/v1
branchSecret  = 52b1d2a60af03b5490ea254d7c6a785a0bab666128ed0158f4f751327b059e1f
PRK_branch    = a8ab63348be55acea783f1a3b7c2a06534810964e9efd2d7aa44f8b8271d7a7c

  leaf        = fml/infra/v1/pki/root/v1            (ed25519)
  okm/seed    = 51d6c44753154c34be5f3fb95a6dccfb7112a3070578ee04ce2b6e5d03ea89e1
  public      = 4f429415399f473734c0270446f230319fdaae57b7400155b3dee5dad6cd0fc9

  leaf        = fml/infra/v1/pki/intermediate/v1    (ed25519)
  okm/seed    = 511b5c46f3ed7108d20ef17baec1a4f0a2bdbf3985e4900774141231d5045ee9
  public      = 30896637ac0c877c581d6a8eaef286e01ec293442a453d9eeac6c668899747cd

  leaf        = fml/infra/v1/age/operator/v1        (x25519/age)
  okm         = 86d0b56b74fe1c89a76b6144b9a4aa98b851d2164f7afedf832c99fcd1ebc1d9
  identity    = AGE-SECRET-KEY-1SMGT26M5LCWGNFMTV9ZTNF92NZU9R5SKFAA0AHUR9JVLE50TC8VSYJVA0W
  recipient   = age1865h20ytnw8alu2852f9mzjcym7z6eu6pz2n9zjfsq3a9x76937svpvhyx

branch        = fml/wallet/v1
branchSecret  = f9cd778a71b3515d96c1b666cc3f1a7c99c1dc57e13ab3a3e12ba263e9178329
PRK_branch    = 04c8287d8dfd833e2e328b49953627fb774d745c9333dc91baf5b058fbd3defa

  leaf        = fml/wallet/v1/cold/v1               (bip39)
  okm/entropy = d0840ec01b864a053f846e7c8856abc4123687025e6b36aa3acf07b7d94543f2
  checksum    = 08
  mnemonic    = spatial call quote damage gorilla action wrap miss lady dress
                priority market casino drum annual sniff cute fade record author
                laugh pencil average donate
```

A mnemonic is wrapped here for the page width. It is **one line**: twenty-four
words joined by single spaces, with no newline and no trailing space.

### Vector D — versioning and length behaviour

Master A, showing that a version bump actually rotates and that section 4.3 is
real rather than theoretical.

```
master                              = 0000...00 (as vector A)

branch fml/infra/v1  branchSecret   = 4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37
branch fml/infra/v2  branchSecret   = 5879f6d9b2990dfff021c69b368076922714324a960ad13b3a7089543ec50772

under PRK_branch of fml/infra/v1:
  fml/infra/v1/pki/root/v1  okm     = 08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c
  fml/infra/v1/pki/root/v1  public  = 58fee0971a0cf4be8361f5e71f0533ece06be735c93405e9917640f532ff5b03
  fml/infra/v1/pki/root/v2  okm     = b18d6a4889e2a49c71d6f16ba23a54b6b809c5f4118ad87f3e9d923c1c80b1b8
  fml/infra/v1/pki/root/v2  public  = 6ffa17c288136cfe8a72612beea298ae52ded45a6259ce751f974d6ba2775807

  fml/infra/v1/pki/root/v1 at L=64  = 08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c
                                      81257eabe32ce08b6e97f5f5806897fa13c59c084670e6d71af5cedc64f72500
```

The `L = 64` output has the `L = 32` output as its exact prefix. That is RFC
5869 behaving correctly and section 4.3 being necessary.
