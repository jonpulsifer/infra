# fml-derive-rs

An independent Rust implementation of `../fml-ceremony/SPEC.md`, the FML
derivation spec. It exists so that a bug in the Go ceremony tool shows up as a
disagreement rather than as a key nobody can reproduce.

## The rule that makes it worth anything

**This crate is written from `SPEC.md` and the standards it cites. Nothing
else.** Not the Go source, not to "check a constant", not to resolve an
ambiguity. An implementation that reads the code it is meant to check is an
echo of it and verifies nothing.

If the spec is ambiguous, implement the honest reading and sharpen the spec.
A disagreement traced to an ambiguous spec is the check working.

## Scope

The labelled derivation tree (SPEC §3–§5) and the key-type mappings (§7):
Ed25519, X25519 as an age identity, and the BIP-39 mnemonic. Path validation
and rejection (§9) come with it.

SLIP-39 share encoding (§8) is **out of scope**: it has official test vectors,
which are its own differential check.

## Run it

```
mise run rust:test        # this crate's own vectors
mise run pki:crosscheck   # this crate against the Go one, byte for byte
```

`cargo test` alone works wherever a C linker is on PATH; the mise task routes
through `nix develop` because the repo's toolchain does not otherwise ship one.

`pki:crosscheck` builds this crate's CLI and hands it to
`apps/fml-ceremony/derive`'s differential test, which runs both implementations
over the spec's vectors and several hundred generated cases and compares stdout.
Both trees route to it in `.github/workflows/rust.yml`, so it runs whichever
side moves.

## Cross-check CLI

One derived value per invocation on stdout, so a harness can diff the two
implementations without linking either to the other.

```
fml-derive <master-hex> <path> [--len N] [--as FORM]
```

A 3-component path is a branch and prints the branch secret; 5 or more is a
leaf and prints its OKM. `FORM` is `hex` (default), `prk`, `ed25519-pub`,
`age-identity`, `age-recipient` or `bip39`.

```
$ fml-derive 2d85...0218 fml/infra/v1/pki/root/v1 --as ed25519-pub
4f429415399f473734c0270446f230319fdaae57b7400155b3dee5dad6cd0fc9
```

## Dependencies

Rust's `std` ships no crypto, so the primitives come from RustCrypto and dalek,
pinned exactly in `Cargo.toml`. The spec's own logic — path syntax, the HKDF
chaining, Bech32, the BIP-39 bit packing — is implemented here, because that is
the part with no published vectors and therefore the part worth checking.

## Embedded wordlist

`wordlist/english.txt` is the BIP-39 English list from `bitcoin/bips`
`bip-0039/english.txt`, fetched 2026-08-26. Verify it by the hash SPEC §7.3
pins, not by re-download — `2f5eed53…3b24dbda` over the file including its
trailing newline. The crate re-checks that hash at runtime before using the
list, so a swapped file fails loudly rather than minting different mnemonics.
