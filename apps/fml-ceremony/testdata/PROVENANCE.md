# Vendored assets and test vectors

Fetched 2026-08-26. Verify by hash, not by re-download: upstream moving is a
change we want to notice, not absorb. Every hash below is over the file
including its trailing newline.

## Embedded assets

These are not test data. They are required at run time and live inside the
package that `go:embed`s them, because an embed pattern cannot reach outside its
own directory. Each package verifies the hash over its embedded copy before use.

| File | Upstream | Upstream commit | SHA-256 |
| --- | --- | --- | --- |
| `../slip39/wordlist.txt` | `satoshilabs/slips` `slip-0039/wordlist.txt` | `1524583213f1392321109b0ff0a91330836ecb32` | `bcc4555340332d169718aed8bf31dd9d5248cb7da6e5d355140ef4f1e601eec3` |
| `../derive/bip39-english.txt` | `bitcoin/bips` `bip-0039/english.txt` | pinned by content, not by revision | `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda` |

The BIP-39 hash is the one SPEC.md section 7.3 pins, so the wordlist is checked
against the specification rather than against wherever the octets came from.

## Test vectors

| File | Upstream | Upstream commit | SHA-256 |
| --- | --- | --- | --- |
| `slip39-vectors.json` | `trezor/python-shamir-mnemonic` `vectors.json` | `1525df19df504b1f69b49179140119959f317f24` | `13ebecebdd869dd2bc2cdf69e7ce3a158cf106cac76c39d17682b1c6cdabbdc4` |
| `jcs/input/*.json`, `jcs/output/*.json` | `cyberphone/json-canonicalization` `testdata/` | `dc406ceaf94b5fa554fcabb92c091089c2357e83` | see below |

`slip39-vectors.json` holds 45 quadruples `[description, mnemonics, secret,
xprv]`. 15 have a non-empty secret and MUST recover it; 30 have an empty secret
and MUST be rejected. Every valid set uses the passphrase `TREZOR` — the empty
passphrase this repo uses is not covered by any official vector, and neither is
a 3-of-5 set at any passphrase, so round-trip tests carry those cases
themselves. The `xprv` column is BIP-32 and is out of scope here; ignore it.

The JCS pairs are six inputs and their canonical forms. Between them they cover
number serialization, string escaping, recursive property sorting, and sorting
by UTF-16 code units rather than UTF-8 bytes — `weird.json` is the one that
distinguishes the two orders, and an implementation that sorts UTF-8 passes the
other five.

```
e503b6d71d1afa595b1c74b1016445c944cd89f90418066b23de1aeda7d17563  jcs/input/arrays.json
03676a951cd8753ac62589f72eb2105cc782c33425418cfe1d517c111f6e5d5a  jcs/input/french.json
d66893805be1784116af50af3110d08766c70a6b4aad93374723f72346e7aaa6  jcs/input/structures.json
4621864e014d4a805a563f55b9ea20aba4a2d2dc09c7394f625496998c00702c  jcs/input/unicode.json
c4a041b503d6bc236036ef44db4dac499272f60fc22c40dc3b7a54870ba6f1c3  jcs/input/values.json
a3a905266bd4a49a969274ea69baa14ee0c4af0ead926d6fa2b7612b4af75387  jcs/input/weird.json
099601b171cafed97c333f8878d68e7f8c8f795412adb34b2fdcf0e7c7beac42  jcs/output/arrays.json
d99d0ebdcb0033cb858cfa830ae46bc0fb3309413b271f1da828c89901a27ed5  jcs/output/french.json
605f65004ec2db7692522a0852c22f1c989e036d547e88963d1a3143cf3195d5  jcs/output/structures.json
0d99aad92a125196ff887876643fd3206786a84ddce2cee52ba4ad256d2381d3  jcs/output/unicode.json
2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb  jcs/output/values.json
6af595a9aa80110b964b4de3f82a05fa6ae7423005019bacfa2620dddc4e94d1  jcs/output/weird.json
```

RFC 8785's own Appendix B number table and section 3.2.4 octet sequence are
transcribed directly into `jcs/jcs_test.go` rather than vendored: they are part
of the RFC's text, not a separate file.
