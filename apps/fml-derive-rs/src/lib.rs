//! An independent Rust implementation of `apps/fml-ceremony/SPEC.md` v1.
//!
//! Written from the spec text alone, deliberately without sight of the Go
//! implementation it exists to disagree with. Section numbers in comments refer
//! to that document.
//!
//! Scope is the labelled derivation tree (§3–§5) and the key-type mappings
//! (§7). SLIP-39 share encoding (§8) is out of scope here — it has official
//! vectors of its own.

use hkdf::Hkdf;
use sha2::{Digest, Sha256};

/// §5. Fixed salts, ASCII, no version component in either.
pub const SALT_MASTER: &[u8] = b"fml-derive-master";
pub const SALT_BRANCH: &[u8] = b"fml-derive-branch";

/// §2. The master seed is exactly 32 octets. No other length is a master seed.
pub const MASTER_LEN: usize = 32;

/// §3.1. Bounds on a well-formed path.
pub const MAX_PATH_OCTETS: usize = 128;
pub const MAX_COMPONENTS: usize = 16;

pub type Result<T> = std::result::Result<T, String>;

// ---------------------------------------------------------------------------
// §3 — paths and labels
// ---------------------------------------------------------------------------

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

/// `version = "v" nonzero-digit *digit`. `v0`, `v01`, `V1`, `v1.0` and `v` are not versions.
fn is_version(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() >= 2
        && b[0] == b'v'
        && b[1].is_ascii_digit()
        && b[1] != b'0'
        && b[2..].iter().all(u8::is_ascii_digit)
}

/// §3.1 + §3.3. Split a path into its components, rejecting — never
/// sanitising — anything that does not satisfy the syntax.
///
/// The empty string is not a valid component, which is what makes a single
/// pass over the `/`-split parts reject leading `/`, trailing `/` and `//`
/// without special-casing any of them.
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

/// §3.1. A branch path has exactly 3 components: `fml` / name / version.
pub fn validate_branch_path(path: &str) -> Result<()> {
    let n = components(path)?.len();
    if n != 3 {
        return Err(format!(
            "branch path must have exactly 3 components, {path:?} has {n}"
        ));
    }
    Ok(())
}

/// §3.1. A leaf path is a branch path plus at least two more components, so at
/// least 5 in total, the last a version.
pub fn validate_leaf_path(path: &str) -> Result<()> {
    let n = components(path)?.len();
    if n < 5 {
        return Err(format!(
            "leaf path must have at least 5 components, {path:?} has {n}"
        ));
    }
    Ok(())
}

/// §3.1/§3.4. The branch path a leaf path descends from: its first 3 components.
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

// ---------------------------------------------------------------------------
// §5 — derivation
// ---------------------------------------------------------------------------

fn extract(salt: &[u8], ikm: &[u8]) -> ([u8; 32], Hkdf<Sha256>) {
    let (prk, hk) = Hkdf::<Sha256>::extract(Some(salt), ikm);
    (prk.into(), hk)
}

fn check_master(master: &[u8]) -> Result<()> {
    // §9: any length other than exactly 32 octets is invalid. The all-zero and
    // all-0xff masters are explicitly NOT rejected here — that check belongs to
    // the ceremony, and vector A depends on the all-zero master deriving.
    if master.len() != MASTER_LEN {
        return Err(format!(
            "master seed must be exactly {MASTER_LEN} octets, got {}",
            master.len()
        ));
    }
    Ok(())
}

/// §5.1. `PRK_master = HKDF-Extract(SHA-256, salt = saltMaster, IKM = masterSeed)`.
pub fn prk_master(master: &[u8]) -> Result<[u8; 32]> {
    check_master(master)?;
    Ok(extract(SALT_MASTER, master).0)
}

/// §5.2. `PRK_branch = HKDF-Extract(SHA-256, salt = saltBranch, IKM = branchSecret)`.
pub fn prk_branch(branch_secret: &[u8; 32]) -> [u8; 32] {
    extract(SALT_BRANCH, branch_secret).0
}

/// §5.1. Level 1 — master seed to branch secret. Always 32 octets.
pub fn derive_branch(master: &[u8], branch_path: &str) -> Result<[u8; 32]> {
    check_master(master)?;
    validate_branch_path(branch_path)?;
    let (_, hk) = extract(SALT_MASTER, master);
    let mut out = [0u8; 32];
    hk.expand(branch_path.as_bytes(), &mut out)
        .map_err(|e| format!("HKDF-Expand failed: {e}"))?;
    Ok(out)
}

/// §5.2. Level 2 — branch secret to leaf key material.
///
/// Takes the branch path as well as the secret because §3.4: 32 opaque octets
/// carry no evidence of which branch they are, and a leaf derived under the
/// wrong branch is well-formed, silent and unreproducible.
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
    // §5.2: 1 <= L <= 255 * HashLen. The ceiling is RFC 5869's and `expand`
    // enforces it; the floor is not RFC 5869's, and expanding to the empty
    // string would otherwise succeed and return something that is not a key.
    if l == 0 {
        return Err("L must be at least 1 octet".to_string());
    }
    let (_, hk) = extract(SALT_BRANCH, branch_secret);
    let mut out = vec![0u8; l];
    hk.expand(leaf_path.as_bytes(), &mut out)
        .map_err(|e| format!("HKDF-Expand failed: {e}"))?;
    Ok(out)
}

/// The whole chain: master seed and a leaf path to that leaf's OKM.
pub fn derive_leaf_from_master(master: &[u8], leaf_path: &str, l: usize) -> Result<Vec<u8>> {
    let branch_path = branch_of(leaf_path)?;
    let branch_secret = derive_branch(master, &branch_path)?;
    derive_leaf(&branch_secret, &branch_path, leaf_path, l)
}

// ---------------------------------------------------------------------------
// §7.1 — Ed25519
// ---------------------------------------------------------------------------

/// §7.1. The OKM *is* the Ed25519 seed; the public key is RFC 8032 §5.1.5.
pub fn ed25519_public(okm: &[u8]) -> Result<[u8; 32]> {
    let seed: [u8; 32] = okm
        .try_into()
        .map_err(|_| format!("ed25519 seed must be 32 octets, got {}", okm.len()))?;
    Ok(ed25519_dalek::SigningKey::from_bytes(&seed)
        .verifying_key()
        .to_bytes())
}

// ---------------------------------------------------------------------------
// §7.2 — X25519 as an age identity, and the Bech32 it is encoded in
// ---------------------------------------------------------------------------

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
/// §7.2 requires the checksum to be computed over the lowercase form even when
/// the string is presented uppercased.
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

/// §7.2. The OKM is the age X25519 identity verbatim, stored unclamped.
/// Built lowercase and then wholly uppercased, so the checksum characters are
/// the uppercase of the lowercase charset.
pub fn age_identity(okm: &[u8]) -> Result<String> {
    if okm.len() != 32 {
        return Err(format!("age identity must be 32 octets, got {}", okm.len()));
    }
    Ok(bech32_encode("age-secret-key-", okm).to_uppercase())
}

/// §7.2. `recipient = X25519(identity, basepoint)`, Bech32 with HRP `age`.
pub fn age_recipient(okm: &[u8]) -> Result<String> {
    let identity: [u8; 32] = okm
        .try_into()
        .map_err(|_| format!("age identity must be 32 octets, got {}", okm.len()))?;
    // RFC 7748 clamps inside X25519; the identity octets themselves stay unclamped.
    let public = x25519_dalek::x25519(identity, x25519_dalek::X25519_BASEPOINT_BYTES);
    // §9: an all-zero shared output means a low-order result. Abort, never emit.
    if public == [0u8; 32] {
        return Err("X25519(identity, basepoint) is all zero".to_string());
    }
    Ok(bech32_encode("age", &public))
}

// ---------------------------------------------------------------------------
// §7.3 — BIP-39 mnemonic
// ---------------------------------------------------------------------------

const WORDLIST: &str = include_str!("../wordlist/english.txt");

/// §7.3. The English list is pinned by content, not by URL, over the file
/// including its trailing newline.
pub const WORDLIST_SHA256: &str =
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

/// §7.3. MUST verify the embedded list before use.
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

/// §7.3. `ENT || CS` split into 11-bit groups, most-significant bit first.
///
/// Generalised over the BIP-39 entropy sizes rather than fixed at 256 bits so
/// that §10's published 128-bit reference vector runs against the same code
/// path as the 256-bit leaf.
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

/// §7.3. `CS`, the checksum octet the mnemonic's trailing bits come from.
pub fn bip39_checksum_byte(entropy: &[u8]) -> u8 {
    Sha256::digest(entropy)[0]
}

// ---------------------------------------------------------------------------
// hex, at the CLI trust boundary
// ---------------------------------------------------------------------------

pub fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|c| format!("{c:02x}")).collect()
}

/// Strict: lowercase or uppercase hex, even length, nothing else. No `0x`
/// prefix, no whitespace, no separators — §3.3's reject-don't-sanitise applied
/// to the one other operator-supplied input.
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
                // Report by byte, not by slicing `s`: a non-ASCII input would
                // panic on a str slice that lands mid-codepoint.
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
