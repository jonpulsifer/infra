//! Cross-check CLI for the FML derivation spec. It prints one derived value per
//! invocation, so a harness can diff it against another implementation.
//!
//! ```text
//! fml-derive <master-hex> <path> [--len N] [--as FORM]
//! ```
//!
//! `--as prk` prints the HKDF-Extract PRK of the level that produced the value.

use fml_derive::*;

const USAGE: &str = "usage: fml-derive <master-hex> <path> [--len N] [--as hex|prk|ed25519-pub|age-identity|age-recipient|bip39]";

fn main() {
    match run() {
        Ok(s) => println!("{s}"),
        Err(e) => {
            eprintln!("fml-derive: {e}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut positional: Vec<&str> = Vec::new();
    let mut len: Option<usize> = None;
    let mut form = "hex";

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--len" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| "--len needs a value".to_string())?;
                len = Some(v.parse().map_err(|_| format!("bad --len {v:?}"))?);
                i += 2;
            }
            "--as" => {
                form = args
                    .get(i + 1)
                    .ok_or_else(|| "--as needs a value".to_string())?;
                i += 2;
            }
            "-h" | "--help" => return Ok(USAGE.to_string()),
            other => {
                positional.push(other);
                i += 1;
            }
        }
    }
    if positional.len() != 2 {
        return Err(USAGE.to_string());
    }

    let master = hex_decode(positional[0])?;
    let path = positional[1];
    let n = components(path)?.len();

    // A branch secret is 32 octets and a sharding input, never a key, so neither
    // --len nor a key mapping applies.
    if n == 3 {
        if len.is_some() {
            return Err("--len does not apply to a branch path: §5.1 fixes it at 32".to_string());
        }
        let secret = derive_branch(&master, path)?;
        return match form {
            "hex" => Ok(hex_encode(&secret)),
            "prk" => Ok(hex_encode(&prk_master(&master)?)),
            _ => Err(format!("--as {form} does not apply to a branch path")),
        };
    }

    let branch_path = branch_of(path)?;
    let branch_secret = derive_branch(&master, &branch_path)?;
    if form == "prk" {
        return Ok(hex_encode(&prk_branch(&branch_secret)));
    }
    let okm = derive_leaf(&branch_secret, &branch_path, path, len.unwrap_or(32))?;

    match form {
        "hex" => Ok(hex_encode(&okm)),
        "ed25519-pub" => Ok(hex_encode(&ed25519_public(&okm)?)),
        "age-identity" => age_identity(&okm),
        "age-recipient" => age_recipient(&okm),
        "bip39" => bip39_mnemonic(&okm),
        _ => Err(format!("unknown --as {form:?}\n{USAGE}")),
    }
}
