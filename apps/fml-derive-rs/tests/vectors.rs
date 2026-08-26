//! Every published vector in SPEC.md §10 and §11, transcribed from the spec
//! text. If one of these fails, the spec and this implementation disagree, and
//! that is the entire point of this crate.

use fml_derive::*;

fn hx(s: &str) -> Vec<u8> {
    hex_decode(s).expect("test vector hex")
}

fn s32(v: Vec<u8>) -> [u8; 32] {
    v.try_into().expect("32 octets")
}

// ---------------------------------------------------------------------------
// §11 — the FML vectors
// ---------------------------------------------------------------------------

struct Leaf {
    path: &'static str,
    okm: &'static str,
    /// Ed25519 public key, age recipient, or the mnemonic — whichever §6.2
    /// declares for this leaf.
    mapped: &'static str,
    /// Only the age leaf publishes an identity string.
    identity: &'static str,
}

struct Vector {
    name: &'static str,
    master: &'static str,
    prk_master: &'static str,
    branches: &'static [(&'static str, &'static str, &'static str, &'static [Leaf])],
}

const VECTORS: &[Vector] = &[
    Vector {
        name: "A",
        master: "0000000000000000000000000000000000000000000000000000000000000000",
        prk_master: "f1257b2cebf618f4c697b1a723f037dfa14cfac1bb89236402297e664040cca8",
        branches: &[
            (
                "fml/infra/v1",
                "4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37",
                "901e641ec9454662ec61507b972302100676d267e0aea42b9398007fe7998001",
                &[
                    Leaf {
                        path: "fml/infra/v1/pki/root/v1",
                        okm: "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c",
                        mapped: "58fee0971a0cf4be8361f5e71f0533ece06be735c93405e9917640f532ff5b03",
                        identity: "",
                    },
                    Leaf {
                        path: "fml/infra/v1/pki/intermediate/v1",
                        okm: "81686d1cb25f96f91efdb5158468278dab9e5c88fb6073e2bccf51da31bf6087",
                        mapped: "5f017b89fc0875aa4f481e5a2e04f7afb9b246ae5bab905832f2ae126f9a20fd",
                        identity: "",
                    },
                    Leaf {
                        path: "fml/infra/v1/age/operator/v1",
                        okm: "83d4f8384416a6993ec33a14bf8de272c2b9b34ff094ccab2d371c8100a55882",
                        mapped: "age1uzf08nsuz0gwuz9ue0f80re672nfawute7ln8g2ys4vpyg60uu7skcqfru",
                        identity: "AGE-SECRET-KEY-1S020SWZYZ6NFJ0KR8G2TLR0ZWTPTNV607Z2VE2EDXUWGZQ99TZPQ7YF972",
                    },
                ],
            ),
            (
                "fml/wallet/v1",
                "c5c1acdd22bc15d597a801efed2838e5cebcdfd6040fb6f98afc55e5f752c2c7",
                "bea86c6ff6eb3a2bb79924bd5866994c8f8ae4fa823adc374f24cf0b010d2203",
                &[Leaf {
                    path: "fml/wallet/v1/cold/v1",
                    okm: "f1c1bd731a859764071fc6b24f3a92f0ef8c6a5da771f2b48aa68774f825e6e1",
                    mapped: "vault assume fresh crush floor rare broccoli web rather keep pigeon tide web cry isolate until verify picture predict auction exhibit base oppose curious",
                    identity: "af",
                }],
            ),
        ],
    },
    Vector {
        name: "B",
        master: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        prk_master: "6ad4324095d92137144e6d005e03a3e85dfec5b448e01994012d968ea8b63763",
        branches: &[
            (
                "fml/infra/v1",
                "64068319837cf282608f2591bfc2a06ef3ed574549ddb2c05e92cc0e509aa0ac",
                "2bc82a4f391257d687fe8997a79016cd0f3914e6f382e0db607948c010c56739",
                &[
                    Leaf {
                        path: "fml/infra/v1/pki/root/v1",
                        okm: "128626be41ea7cc72968ae4ffd408e44af8e359e157ebb7cebd6eab4d2672c78",
                        mapped: "e1e0bde2195e3af2b40d5eb7bd33925ecf2d3a60db090c90748fea120b1542cd",
                        identity: "",
                    },
                    Leaf {
                        path: "fml/infra/v1/pki/intermediate/v1",
                        okm: "3d763a5a094e39d6bcf2b56f7dbd1e3579b1a6fd825790815e146c638f6b924a",
                        mapped: "7cbbbf893f9767b2bbb8a00c150ea2f03d4b378c188bf61a799405294d00f453",
                        identity: "",
                    },
                    Leaf {
                        path: "fml/infra/v1/age/operator/v1",
                        okm: "2b2cb7e8e7293387b1dbdeead25ccee5828ee22f088a93010f8455c03d0fa0a8",
                        mapped: "age13m7cc6eqq0q9782gf50nwz8h3x98a34dmd0z0s6w6n9ma5lqdq7s63dskq",
                        identity: "AGE-SECRET-KEY-19VKT06889YEC0VWMMM4DYHXWUKPGAC30PZ9FXQG0S32UQ0G05Z5Q5MQXGD",
                    },
                ],
            ),
            (
                "fml/wallet/v1",
                "a587058479d177408f09e760a881c4e9d601d723bceff34f004ba1e4a853d7c7",
                "9d10a15bd4454e25e8485eb34a00c4f8a232304d75aab31dc14362ff24cd5e8d",
                &[Leaf {
                    path: "fml/wallet/v1/cold/v1",
                    okm: "e0f1446937b7d348afe56d366619c673a07443cd1610132dd901d332b1c06745",
                    mapped: "thought mechanic bottom hunt large picture sauce pumpkin cushion cotton immense trap also capable crowd search basket human document please climb then other rich",
                    identity: "ca",
                }],
            ),
        ],
    },
    Vector {
        name: "C",
        master: "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218",
        prk_master: "12ef3be531acf418a8c669e434829467187a634592b09419261b0bd57805e1b9",
        branches: &[
            (
                "fml/infra/v1",
                "52b1d2a60af03b5490ea254d7c6a785a0bab666128ed0158f4f751327b059e1f",
                "a8ab63348be55acea783f1a3b7c2a06534810964e9efd2d7aa44f8b8271d7a7c",
                &[
                    Leaf {
                        path: "fml/infra/v1/pki/root/v1",
                        okm: "51d6c44753154c34be5f3fb95a6dccfb7112a3070578ee04ce2b6e5d03ea89e1",
                        mapped: "4f429415399f473734c0270446f230319fdaae57b7400155b3dee5dad6cd0fc9",
                        identity: "",
                    },
                    Leaf {
                        path: "fml/infra/v1/pki/intermediate/v1",
                        okm: "511b5c46f3ed7108d20ef17baec1a4f0a2bdbf3985e4900774141231d5045ee9",
                        mapped: "30896637ac0c877c581d6a8eaef286e01ec293442a453d9eeac6c668899747cd",
                        identity: "",
                    },
                    Leaf {
                        path: "fml/infra/v1/age/operator/v1",
                        okm: "86d0b56b74fe1c89a76b6144b9a4aa98b851d2164f7afedf832c99fcd1ebc1d9",
                        mapped: "age1865h20ytnw8alu2852f9mzjcym7z6eu6pz2n9zjfsq3a9x76937svpvhyx",
                        identity: "AGE-SECRET-KEY-1SMGT26M5LCWGNFMTV9ZTNF92NZU9R5SKFAA0AHUR9JVLE50TC8VSYJVA0W",
                    },
                ],
            ),
            (
                "fml/wallet/v1",
                "f9cd778a71b3515d96c1b666cc3f1a7c99c1dc57e13ab3a3e12ba263e9178329",
                "04c8287d8dfd833e2e328b49953627fb774d745c9333dc91baf5b058fbd3defa",
                &[Leaf {
                    path: "fml/wallet/v1/cold/v1",
                    okm: "d0840ec01b864a053f846e7c8856abc4123687025e6b36aa3acf07b7d94543f2",
                    mapped: "spatial call quote damage gorilla action wrap miss lady dress priority market casino drum annual sniff cute fade record author laugh pencil average donate",
                    identity: "08",
                }],
            ),
        ],
    },
];

#[test]
fn spec_11_vectors() {
    for v in VECTORS {
        let master = hx(v.master);
        assert_eq!(
            hex_encode(&prk_master(&master).unwrap()),
            v.prk_master,
            "vector {} PRK_master",
            v.name
        );

        for (branch_path, want_secret, want_prk_branch, leaves) in v.branches {
            let secret = derive_branch(&master, branch_path).unwrap();
            assert_eq!(
                hex_encode(&secret),
                *want_secret,
                "vector {} branch {branch_path} secret",
                v.name
            );
            assert_eq!(
                hex_encode(&prk_branch(&secret)),
                *want_prk_branch,
                "vector {} branch {branch_path} PRK_branch",
                v.name
            );

            for leaf in *leaves {
                let okm = derive_leaf(&secret, branch_path, leaf.path, 32).unwrap();
                assert_eq!(
                    hex_encode(&okm),
                    leaf.okm,
                    "vector {} leaf {} okm",
                    v.name,
                    leaf.path
                );
                // The whole chain from the master must agree with the two steps.
                assert_eq!(
                    derive_leaf_from_master(&master, leaf.path, 32).unwrap(),
                    okm,
                    "vector {} leaf {} chained",
                    v.name,
                    leaf.path
                );

                if leaf.path.contains("/pki/") {
                    assert_eq!(
                        hex_encode(&ed25519_public(&okm).unwrap()),
                        leaf.mapped,
                        "vector {} leaf {} ed25519 public",
                        v.name,
                        leaf.path
                    );
                } else if leaf.path.contains("/age/") {
                    assert_eq!(
                        age_recipient(&okm).unwrap(),
                        leaf.mapped,
                        "vector {} leaf {} age recipient",
                        v.name,
                        leaf.path
                    );
                    assert_eq!(
                        age_identity(&okm).unwrap(),
                        leaf.identity,
                        "vector {} leaf {} age identity",
                        v.name,
                        leaf.path
                    );
                } else {
                    assert_eq!(
                        bip39_mnemonic(&okm).unwrap(),
                        leaf.mapped,
                        "vector {} leaf {} mnemonic",
                        v.name,
                        leaf.path
                    );
                    assert_eq!(
                        format!("{:02x}", bip39_checksum_byte(&okm)),
                        leaf.identity,
                        "vector {} leaf {} bip39 checksum",
                        v.name,
                        leaf.path
                    );
                    assert_eq!(
                        bip39_mnemonic(&okm).unwrap().split(' ').count(),
                        24,
                        "vector {} leaf {} word count",
                        v.name,
                        leaf.path
                    );
                }
            }
        }
    }
}

/// §11 vector C's master is `SHA-256("Folly Mountain Laboratories")`.
#[test]
fn spec_11_vector_c_master_provenance() {
    use sha2::{Digest, Sha256};
    assert_eq!(
        hex_encode(&Sha256::digest(b"Folly Mountain Laboratories")),
        "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218"
    );
}

/// §11 vector D — a version bump rotates, and §4.3's length-prefix property is real.
#[test]
fn spec_11_vector_d() {
    let master = hx("0000000000000000000000000000000000000000000000000000000000000000");

    assert_eq!(
        hex_encode(&derive_branch(&master, "fml/infra/v1").unwrap()),
        "4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37"
    );
    assert_eq!(
        hex_encode(&derive_branch(&master, "fml/infra/v2").unwrap()),
        "5879f6d9b2990dfff021c69b368076922714324a960ad13b3a7089543ec50772"
    );

    let secret = s32(hx(
        "4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37",
    ));
    let v1 = derive_leaf(&secret, "fml/infra/v1", "fml/infra/v1/pki/root/v1", 32).unwrap();
    let v2 = derive_leaf(&secret, "fml/infra/v1", "fml/infra/v1/pki/root/v2", 32).unwrap();
    assert_eq!(
        hex_encode(&v1),
        "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c"
    );
    assert_eq!(
        hex_encode(&ed25519_public(&v1).unwrap()),
        "58fee0971a0cf4be8361f5e71f0533ece06be735c93405e9917640f532ff5b03"
    );
    assert_eq!(
        hex_encode(&v2),
        "b18d6a4889e2a49c71d6f16ba23a54b6b809c5f4118ad87f3e9d923c1c80b1b8"
    );
    assert_eq!(
        hex_encode(&ed25519_public(&v2).unwrap()),
        "6ffa17c288136cfe8a72612beea298ae52ded45a6259ce751f974d6ba2775807"
    );

    let l64 = derive_leaf(&secret, "fml/infra/v1", "fml/infra/v1/pki/root/v1", 64).unwrap();
    assert_eq!(
        hex_encode(&l64),
        "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c\
         81257eabe32ce08b6e97f5f5806897fa13c59c084670e6d71af5cedc64f72500"
    );
    assert_eq!(
        &l64[..32],
        &v1[..],
        "§4.3: L=32 is the exact prefix of L=64"
    );
}

// ---------------------------------------------------------------------------
// §10 — reference self-checks against the standards themselves
// ---------------------------------------------------------------------------

/// RFC 5869 test case 1. Pins HKDF and, crucially, the salt/IKM argument order.
#[test]
fn spec_10_rfc5869_case_1() {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let ikm = [0x0bu8; 22];
    let salt = hx("000102030405060708090a0b0c");
    let info = hx("f0f1f2f3f4f5f6f7f8f9");

    let (prk, hk) = Hkdf::<Sha256>::extract(Some(&salt), &ikm);
    assert_eq!(
        hex_encode(&prk),
        "077709362c2e32df0ddc3f0dc47bba6390b6c73bb50f9c3122ec844ad7c2b3e5"
    );
    let mut okm = vec![0u8; 42];
    hk.expand(&info, &mut okm).unwrap();
    assert_eq!(
        hex_encode(&okm),
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
}

/// The age specification's own example pair.
///
/// Only the encode direction is exercised: this crate implements the
/// derivation direction and has no Bech32 decoder. `encode(0x42 * 32)`
/// reproducing the published identity pins the same charset, HRP, bit
/// conversion and checksum that a decode-then-re-encode would.
#[test]
fn spec_10_age_example_pair() {
    let identity = [0x42u8; 32];
    assert_eq!(
        age_identity(&identity).unwrap(),
        "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX"
    );
    assert_eq!(
        age_recipient(&identity).unwrap(),
        "age1zvkyg2lqzraa2lnjvqej32nkuu0ues2s82hzrye869xeexvn73equnujwj"
    );
}

/// BIP-39's own vectors at both ends of the entropy range.
#[test]
fn spec_10_bip39_reference_vectors() {
    let want12 = format!("{} about", ["abandon"; 11].join(" "));
    assert_eq!(bip39_mnemonic(&[0x00u8; 16]).unwrap(), want12);

    let want24 = format!("{} vote", ["zoo"; 23].join(" "));
    assert_eq!(bip39_mnemonic(&[0xffu8; 32]).unwrap(), want24);
}

/// §7.3: the wordlist is pinned by content and MUST be verified before use.
#[test]
fn spec_10_wordlist_identity() {
    let w = wordlist().unwrap();
    assert_eq!(w.len(), 2048);
    assert_eq!(w[0], "abandon");
    assert_eq!(w[2047], "zoo");
}

// ---------------------------------------------------------------------------
// §9 — what an implementation must reject
// ---------------------------------------------------------------------------

#[test]
fn spec_9_rejects_bad_paths() {
    let bad = [
        // charset
        "fml/Infra/v1",
        "fml/in_fra/v1",
        "fml/in.fra/v1",
        "fml/in fra/v1",
        "fml/inf\u{00e9}ra/v1",
        "fml/1nfra/v1",
        "fml/-infra/v1",
        // separators
        "/fml/infra/v1",
        "fml/infra/v1/",
        "fml//infra/v1",
        "",
        // root component
        "not-fml/infra/v1",
        // versions
        "fml/infra/v0",
        "fml/infra/v01",
        "fml/infra/V1",
        "fml/infra/v1.0",
        "fml/infra/v",
        "fml/infra/infra",
    ];
    for p in bad {
        assert!(components(p).is_err(), "expected {p:?} to be rejected");
    }

    // Bounds.
    let long = format!("fml/{}/v1", "a".repeat(125));
    assert!(
        components(&long).is_err(),
        "over 128 octets must be rejected"
    );
    let deep = format!("fml/{}/v1", ["a"; 15].join("/"));
    assert!(
        components(&deep).is_err(),
        "over 16 components must be rejected"
    );

    // Shape.
    assert!(validate_branch_path("fml/infra/v1/pki/root/v1").is_err());
    assert!(validate_branch_path("fml/v1").is_err());
    assert!(validate_leaf_path("fml/infra/v1").is_err());
    assert!(
        validate_leaf_path("fml/infra/v1/root/v1").is_ok(),
        "5 components is the minimum leaf and is legal"
    );
}

/// §3.4 — a leaf must descend from the branch secret deriving it.
#[test]
fn spec_3_4_leaf_must_descend_from_branch() {
    let secret = [0u8; 32];
    assert!(derive_leaf(&secret, "fml/wallet/v1", "fml/infra/v1/pki/root/v1", 32).is_err());
    // A sibling prefix that shares a string prefix but not a component boundary.
    assert!(derive_leaf(&secret, "fml/infra/v1", "fml/infra/v11/pki/root/v1", 32).is_err());
    assert!(derive_leaf(&secret, "fml/infra/v1", "fml/infra/v1/pki/root/v1", 32).is_ok());
}

/// §9 — master seed length is the only length check the *library* makes.
/// All-zero and all-0xff are the ceremony's business, not the library's:
/// vector A depends on the all-zero master deriving.
#[test]
fn spec_9_master_seed_length() {
    assert!(derive_branch(&[0u8; 31], "fml/infra/v1").is_err());
    assert!(derive_branch(&[0u8; 33], "fml/infra/v1").is_err());
    assert!(derive_branch(&[0u8; 32], "fml/infra/v1").is_ok());
    assert!(derive_branch(&[0xffu8; 32], "fml/infra/v1").is_ok());
}

#[test]
fn hex_decode_rejects_junk() {
    assert!(hex_decode("abc").is_err());
    assert!(hex_decode("0xff").is_err());
    assert!(hex_decode("zz").is_err());
    assert_eq!(hex_decode("00FF").unwrap(), vec![0x00, 0xff]);
}
