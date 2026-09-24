# fml-derive-rs

fml-derive-rs is a second, independent Rust implementation of the FML
derivation spec, `../fml-ceremony/SPEC.md`. A differential test compares it
with the Go ceremony tool, so a bug in either one shows up as a disagreement.
See [PKI](https://wiki.lolwtf.ca/platform/pki/).

## Rule

Write this crate from `SPEC.md` and the standards it cites. Do not read the Go
source, not even to check a constant. An implementation that copies the code it
checks finds no bugs in it. If the spec is ambiguous, implement the plain
reading and make the spec clearer.

## Scope

The crate implements the labelled derivation tree, the key-type mappings
(Ed25519, X25519 as an age identity, and the BIP-39 mnemonic) and path
rejection. SLIP-39 share encoding is out of scope, because its official test
vectors check it.

## Test

```bash
mise run rust:test        # this crate against the spec vectors
mise run pki:crosscheck   # this crate against the Go implementation, byte for byte
```

`cargo test` works where a C linker is on `PATH`. The mise tasks run through
`nix develop`, which supplies one. `pki:crosscheck` builds the CLI and runs the
differential test in `apps/fml-ceremony/derive/` over the spec vectors and
several hundred generated cases. `.github/workflows/rust.yml` runs both on each
change to either implementation.

## CLI

The CLI prints one derived value on stdout, so a harness can compare the two
implementations without linking them.

```bash
fml-derive <master-hex> <path> [--len N] [--as FORM]
```

A path with 3 components is a branch and prints the branch secret. A path with
5 or more is a leaf and prints its output key material. `FORM` is `hex` (the
default), `prk`, `ed25519-pub`, `age-identity`, `age-recipient` or `bip39`.

## Dependencies and wordlist

RustCrypto and dalek supply the primitives, pinned in `Cargo.toml`. The crate
implements the rest of the spec itself: the path syntax, the HKDF chaining,
Bech32 and the BIP-39 bit packing. These parts have no published vectors.

`wordlist/english.txt` is the BIP-39 English list from `bitcoin/bips`. To check
it, compare its SHA-256 with the hash that `SPEC.md` pins (`2f5eed53…3b24dbda`,
trailing newline included). The crate checks the hash before it uses the list.
