//! An independent Rust implementation of `apps/fml-ceremony/SPEC.md` v1, written
//! from the spec alone: the derivation tree and the key-type mappings, without
//! SLIP-39 share encoding.

use hkdf::Hkdf;
use sha2::{Digest, Sha256};

/// Fixed ASCII salts, with no version component.
pub const SALT_MASTER: &[u8] = b"fml-derive-master";
pub const SALT_BRANCH: &[u8] = b"fml-derive-branch";

/// The only valid master seed length, in octets.
pub const MASTER_LEN: usize = 32;

/// Bounds on a well-formed path.
pub const MAX_PATH_OCTETS: usize = 128;
pub const MAX_COMPONENTS: usize = 16;

pub type Result<T> = std::result::Result<T, String>;

/// `component = lowercase-letter *( lowercase-letter / digit / "-" )`
fn is_component(c: &str) -> bool {
    let b = c.as_bytes();
    match b.first() {
        Some(f) if f.is_ascii_lowercase() => {}
        _ => return false,
    }
    b[1..]
        .iter()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `version = "v" nonzero-digit *digit`
fn is_version(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() >= 2
        && b[0] == b'v'
        && b[1].is_ascii_digit()
        && b[1] != b'0'
        && b[2..].iter().all(u8::is_ascii_digit)
}

/// Splits a path into components and never sanitises. An empty component is
/// invalid, so a leading, trailing or doubled `/` fails.
pub fn components(path: &str) -> Result<Vec<&str>> {
    if path.len() > MAX_PATH_OCTETS {
        return Err(format!(
            "path is {} octets, limit is {MAX_PATH_OCTETS}",
            path.len()
        ));
    }
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() > MAX_COMPONENTS {
        return Err(format!(
            "path has {} components, limit is {MAX_COMPONENTS}",
            parts.len()
        ));
    }
    for p in &parts {
        if !is_component(p) {
            return Err(format!("invalid path component {p:?} in {path:?}"));
        }
    }
    if parts[0] != "fml" {
        return Err(format!(
            "path must start with component \"fml\", got {:?}",
            parts[0]
        ));
    }
    let last = parts[parts.len() - 1];
    if !is_version(last) {
        return Err(format!("final component {last:?} is not a version"));
    }
    Ok(parts)
}

/// A branch path has 3 components: `fml` / name / version.
pub fn validate_branch_path(path: &str) -> Result<()> {
    let n = components(path)?.len();
    if n != 3 {
        return Err(format!(
            "branch path must have exactly 3 components, {path:?} has {n}"
        ));
    }
    Ok(())
}

/// A leaf path has at least 5 components, the last a version.
pub fn validate_leaf_path(path: &str) -> Result<()> {
    let n = components(path)?.len();
    if n < 5 {
        return Err(format!(
            "leaf path must have at least 5 components, {path:?} has {n}"
        ));
    }
    Ok(())
}

/// The branch path a leaf path descends from: its first 3 components.
pub fn branch_of(leaf_path: &str) -> Result<String> {
    let parts = components(leaf_path)?;
    if parts.len() < 5 {
        return Err(format!(
            "leaf path must have at least 5 components, {leaf_path:?} has {}",
            parts.len()
        ));
    }
    Ok(parts[..3].join("/"))
}

fn extract(salt: &[u8], ikm: &[u8]) -> ([u8; 32], Hkdf<Sha256>) {
    let (prk, hk) = Hkdf::<Sha256>::extract(Some(salt), ikm);
    (prk.into(), hk)
}

fn check_master(master: &[u8]) -> Result<()> {
    // Constant masters are not rejected here: vector A uses the all-zero master,
    // and the ceremony rejects constants itself.
    if master.len() != MASTER_LEN {
        return Err(format!(
            "master seed must be exactly {MASTER_LEN} octets, got {}",
            master.len()
        ));
    }
    Ok(())
}

/// `PRK_master = HKDF-Extract(SHA-256, salt = saltMaster, IKM = masterSeed)`.
pub fn prk_master(master: &[u8]) -> Result<[u8; 32]> {
    check_master(master)?;
    Ok(extract(SALT_MASTER, master).0)
}

/// `PRK_branch = HKDF-Extract(SHA-256, salt = saltBranch, IKM = branchSecret)`.
pub fn prk_branch(branch_secret: &[u8; 32]) -> [u8; 32] {
    extract(SALT_BRANCH, branch_secret).0
}

/// Master seed to branch secret, always 32 octets.
pub fn derive_branch(master: &[u8], branch_path: &str) -> Result<[u8; 32]> {
    check_master(master)?;
    validate_branch_path(branch_path)?;
    let (_, hk) = extract(SALT_MASTER, master);
    let mut out = [0u8; 32];
    hk.expand(branch_path.as_bytes(), &mut out)
        .map_err(|e| format!("HKDF-Expand failed: {e}"))?;
    Ok(out)
}

/// Branch secret to leaf key material. A secret does not identify its branch,
/// so the branch path is passed in and checked.
pub fn derive_leaf(
    branch_secret: &[u8; 32],
    branch_path: &str,
    leaf_path: &str,
    l: usize,
) -> Result<Vec<u8>> {
    validate_branch_path(branch_path)?;
    validate_leaf_path(leaf_path)?;
    if !leaf_path.starts_with(&format!("{branch_path}/")) {
        return Err(format!(
            "leaf path {leaf_path:?} does not descend from branch {branch_path:?}"
        ));
    }
    // 1 <= L <= 255 * HashLen. `expand` enforces RFC 5869's ceiling; without the
    // floor, an empty expansion would succeed and return no key.
    if l == 0 {
        return Err("L must be at least 1 octet".to_string());
    }
    let (_, hk) = extract(SALT_BRANCH, branch_secret);
    let mut out = vec![0u8; l];
    hk.expand(leaf_path.as_bytes(), &mut out)
        .map_err(|e| format!("HKDF-Expand failed: {e}"))?;
    Ok(out)
}

/// The full chain: master seed and a leaf path to that leaf's OKM.
pub fn derive_leaf_from_master(master: &[u8], leaf_path: &str, l: usize) -> Result<Vec<u8>> {
    let branch_path = branch_of(leaf_path)?;
    let branch_secret = derive_branch(master, &branch_path)?;
    derive_leaf(&branch_secret, &branch_path, leaf_path, l)
}

/// The OKM is the Ed25519 seed.
pub fn ed25519_public(okm: &[u8]) -> Result<[u8; 32]> {
    let seed: [u8; 32] = okm
        .try_into()
        .map_err(|_| format!("ed25519 seed must be 32 octets, got {}", okm.len()))?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes())
}

const BECH32_CHARSET: &[u8] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

fn bech32_polymod(values: &[u8]) -> u32 {
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ u32::from(*v);
        for (i, g) in BECH32_GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn bech32_hrp_expand(hrp: &str) -> Vec<u8> {
    let b = hrp.as_bytes();
    let mut v: Vec<u8> = b.iter().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(b.iter().map(|c| c & 31));
    v
}

/// `convertbits(data, 8, 5, pad = true)`.
fn convert_8_to_5(data: &[u8]) -> Vec<u8> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(data.len() * 8 / 5 + 1);
    for b in data {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        out.push(((acc << (5 - bits)) & 31) as u8);
    }
    out
}

/// BIP-173 Bech32 (checksum constant 1, not Bech32m). `hrp` must be lowercase:
/// the checksum covers the lowercase form even when presented uppercase.
fn bech32_encode(hrp: &str, payload: &[u8]) -> String {
    debug_assert!(hrp.bytes().all(|c| !c.is_ascii_uppercase()));
    let data = convert_8_to_5(payload);
    let mut values = bech32_hrp_expand(hrp);
    values.extend(&data);
    values.extend([0u8; 6]);
    let checksum = bech32_polymod(&values) ^ 1;

    let mut s = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    s.push_str(hrp);
    s.push('1');
    for d in &data {
        s.push(BECH32_CHARSET[*d as usize] as char);
    }
    for i in 0..6 {
        s.push(BECH32_CHARSET[((checksum >> (5 * (5 - i))) & 31) as usize] as char);
    }
    s
}

/// The OKM is the age X25519 identity, unclamped. It is encoded lowercase, then
/// uppercased.
pub fn age_identity(okm: &[u8]) -> Result<String> {
    if okm.len() != 32 {
        return Err(format!("age identity must be 32 octets, got {}", okm.len()));
    }
    Ok(bech32_encode("age-secret-key-", okm).to_uppercase())
}

/// `recipient = X25519(identity, basepoint)`, Bech32 with HRP `age`.
pub fn age_recipient(okm: &[u8]) -> Result<String> {
    let identity: [u8; 32] = okm
        .try_into()
        .map_err(|_| format!("age identity must be 32 octets, got {}", okm.len()))?;
    // RFC 7748 clamps inside X25519; the identity octets stay unclamped.
    let public = x25519_dalek::x25519(identity, x25519_dalek::X25519_BASEPOINT_BYTES);
    // An all-zero public key is a low-order result.
    if public == [0u8; 32] {
        return Err("X25519(identity, basepoint) is all zero".to_string());
    }
    Ok(bech32_encode("age", &public))
}

const WORDLIST: &str = include_str!("../wordlist/english.txt");

/// Pins the English list by content, trailing newline included.
pub const WORDLIST_SHA256: &str =
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

/// Returns the embedded list after verifying its digest.
pub fn wordlist() -> Result<Vec<&'static str>> {
    let got = hex_encode(&Sha256::digest(WORDLIST.as_bytes()));
    if got != WORDLIST_SHA256 {
        return Err(format!(
            "embedded BIP-39 wordlist SHA-256 is {got}, expected {WORDLIST_SHA256}"
        ));
    }
    let words: Vec<&str> = WORDLIST.lines().collect();
    if words.len() != 2048 {
        return Err(format!(
            "BIP-39 wordlist has {} entries, expected 2048",
            words.len()
        ));
    }
    Ok(words)
}

/// `ENT || CS` in 11-bit groups, MSB first. Every BIP-39 entropy size is accepted,
/// so the 128-bit reference vector runs the same code as the 256-bit leaf.
pub fn bip39_mnemonic(entropy: &[u8]) -> Result<String> {
    if entropy.len() < 16 || entropy.len() > 32 || !entropy.len().is_multiple_of(4) {
        return Err(format!(
            "BIP-39 entropy must be 16..=32 octets and a multiple of 4, got {}",
            entropy.len()
        ));
    }
    let words = wordlist()?;
    let cs_bits = entropy.len() * 8 / 32;
    let mut buf = entropy.to_vec();
    buf.push(Sha256::digest(entropy)[0]);

    let n_words = (entropy.len() * 8 + cs_bits) / 11;
    let mut out = Vec::with_capacity(n_words);
    for i in 0..n_words {
        let mut idx = 0usize;
        for j in 0..11 {
            let bit = i * 11 + j;
            idx = (idx << 1) | usize::from((buf[bit / 8] >> (7 - bit % 8)) & 1);
        }
        out.push(words[idx]);
    }
    Ok(out.join(" "))
}

/// `CS`, the checksum octet the mnemonic's trailing bits come from.
pub fn bip39_checksum_byte(entropy: &[u8]) -> u8 {
    Sha256::digest(entropy)[0]
}

pub fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|c| format!("{c:02x}")).collect()
}

/// Strict hex in either case and of even length, with no `0x` prefix,
/// whitespace or separators.
pub fn hex_decode(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return Err(format!("hex string has odd length {}", s.len()));
    }
    let b = s.as_bytes();
    (0..b.len() / 2)
        .map(|i| {
            let hi = (b[2 * i] as char).to_digit(16);
            let lo = (b[2 * i + 1] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => Ok((h * 16 + l) as u8),
                // Report by byte: slicing `s` panics mid-codepoint on non-ASCII input.
                _ => Err(format!(
                    "invalid hex at offset {}: {:#04x} {:#04x}",
                    2 * i,
                    b[2 * i],
                    b[2 * i + 1]
                )),
            }
        })
        .collect()
}
