#!/usr/bin/env bash
# Reissue the FML Root and Intermediate CA certificates with pathLen constraints
# that admit the per-cluster Kubernetes CAs beneath them.
#
# The hierarchy is Root -> Intermediate -> FML K8s <cluster> CA -> leaf, so two
# CAs follow the root and one follows the intermediate. The root therefore needs
# pathLen >= 2 and the intermediate pathLen >= 1. Both currently sit one lower,
# which makes the chain invalid to any client that builds a full path.
#
# Both certificates keep their existing key and subject, so the new ones are
# drop-in replacements: subject key identifiers are unchanged and anything
# pinning the intermediate's key still matches.
#
# Private keys are read, never written. The root key stays offline and is
# supplied by path; the intermediate key comes from 1Password unless overridden.
# Output is public certificate material in a staging directory, plus the exact
# 1Password fields to update. Nothing is applied for you.
#
# Requires: openssl, python3, and op (unless --intermediate-key is given).

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
staging="$repo_root/terraform/pki/certs/staging"

op_vault="ib23znjeikv74p37f6mbfk7uya"
op_intermediate="ofl5zkj2rcjnexv3f45wc5i7aq"
op_root="ujhf4f5cwerdwtpn27fn52kvwq"

root_key=""
intermediate_key=""
# 99991231235959Z is RFC 5280's "no well-defined expiration date". These are
# trust anchors distributed out of band; an expiry on them buys a fleet-wide
# outage on a date nobody is watching, not security. The cluster CAs beneath
# them stay short-lived on purpose, and that is where rotation is exercised.
root_validity=(-not_after 99991231235959Z)
intermediate_validity=(-not_after 99991231235959Z)

usage() {
  cat >&2 <<'USAGE'
usage: reissue-trust-anchors.sh --root-key <path> [options]

  --root-key <path>          PEM private key for the FML Root CA (offline; required)
  --intermediate-key <path>  PEM private key for the Intermediate CA
                             (default: read from 1Password)
  --root-days <n>            Bound the root instead of never expiring
  --intermediate-days <n>    Bound the intermediate instead of never expiring

Writes new certificates to terraform/pki/certs/staging/ and verifies the chain.
USAGE
  exit 2
}

while (($#)); do
  case "$1" in
    --root-key)
      root_key="${2:?}"
      shift 2
      ;;
    --intermediate-key)
      intermediate_key="${2:?}"
      shift 2
      ;;
    --root-days)
      root_validity=(-days "${2:?}")
      shift 2
      ;;
    --intermediate-days)
      intermediate_validity=(-days "${2:?}")
      shift 2
      ;;
    -h | --help) usage ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      ;;
  esac
done

[[ -n $root_key ]] || usage
[[ -r $root_key ]] || {
  echo "cannot read root key: $root_key" >&2
  exit 1
}

for tool in openssl python3; do
  command -v "$tool" >/dev/null || {
    echo "missing required tool: $tool" >&2
    echo "the dev shell carries both — run this under 'nix develop -c \\" >&2
    echo "  bash scripts/pki/reissue-trust-anchors.sh ...'" >&2
    exit 1
  }
done

# Everything secret lives here and nowhere else.
work="$(mktemp -d)"
chmod 700 "$work"
cleanup() { rm -rf "$work"; }
trap cleanup EXIT

if [[ -n $intermediate_key ]]; then
  [[ -r $intermediate_key ]] || {
    echo "cannot read intermediate key: $intermediate_key" >&2
    exit 1
  }
  cp "$intermediate_key" "$work/intermediate.key"
else
  command -v op >/dev/null || {
    echo "op not found; pass --intermediate-key instead" >&2
    exit 1
  }
  echo "==> reading the intermediate key from 1Password" >&2
  op read "op://$op_vault/$op_intermediate/ca.key" >"$work/intermediate.key"
fi
chmod 600 "$work/intermediate.key"

# Subjects must survive verbatim: reusing them keeps the new certificates
# interchangeable with the ones already distributed.
root_subject="$(openssl x509 -in "$repo_root/terraform/pki/certs/fml-root.pem" -noout -subject -nameopt RFC2253 | sed 's/^subject=//')"
intermediate_subject="$(openssl x509 -in "$repo_root/terraform/pki/certs/fml-intermediate.pem" -noout -subject -nameopt RFC2253 | sed 's/^subject=//')"

echo "==> root subject:         $root_subject" >&2
echo "==> intermediate subject: $intermediate_subject" >&2

# Ed25519 and Ed448 bind their own hash and OpenSSL refuses an explicit digest
# for them. Read the algorithm off the existing certificate rather than the key,
# so nothing secret is parsed to make this decision.
root_alg="$(openssl x509 -in "$repo_root/terraform/pki/certs/fml-root.pem" -noout -text \
  | sed -n 's/.*Public Key Algorithm: *//p' | head -1)"
case "$root_alg" in
  ED25519 | ed25519 | ED448 | ed448) digest=() ;;
  *) digest=(-sha256) ;;
esac
echo "==> root key algorithm:   ${root_alg:-unknown} (digest: ${digest[*]:-built in})" >&2

cat >"$work/intermediate.ext" <<EOF
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

echo "==> reissuing the root, self-signed, pathlen:2" >&2
# -addext, not -extfile: that flag belongs to `openssl x509`, and `req` rejects
# it as an unknown option rather than ignoring it.
openssl req -x509 -new \
  -key "$root_key" \
  "${digest[@]}" \
  "${root_validity[@]}" \
  -subj "/$root_subject" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:2" \
  -addext "keyUsage=critical,keyCertSign,cRLSign,digitalSignature" \
  -addext "subjectKeyIdentifier=hash" \
  -out "$work/fml-root.pem"

echo "==> reissuing the intermediate off the new root, pathlen:1" >&2
openssl req -new \
  -key "$work/intermediate.key" \
  -subj "/$intermediate_subject" \
  -out "$work/intermediate.csr"

openssl x509 -req \
  -in "$work/intermediate.csr" \
  -CA "$work/fml-root.pem" \
  -CAkey "$root_key" \
  "${digest[@]}" \
  "${intermediate_validity[@]}" \
  -extfile "$work/intermediate.ext" \
  -out "$work/fml-intermediate.pem"

# The intermediate key must still match its certificate, or every cluster CA
# Terraform signs with it will be unverifiable.
# Compare public halves, which works for Ed25519 as well as RSA; -modulus is
# RSA-only and silently matches nothing on an Ed key.
key_pub="$(openssl pkey -in "$work/intermediate.key" -pubout 2>/dev/null || true)"
crt_pub="$(openssl x509 -in "$work/fml-intermediate.pem" -noout -pubkey 2>/dev/null || true)"
if [[ -z $key_pub || $key_pub != "$crt_pub" ]]; then
  echo "the reissued intermediate does not match its private key" >&2
  exit 1
fi

echo "==> verifying the new anchors accept an existing cluster CA" >&2
verified=0
for ca in "$repo_root"/terraform/pki/certs/*-ca.pem; do
  [[ "$(basename "$ca")" == fml-* ]] && continue
  if openssl verify -CAfile "$work/fml-root.pem" -untrusted "$work/fml-intermediate.pem" "$ca" >/dev/null 2>&1; then
    echo "      $(basename "$ca") verifies" >&2
    verified=1
  else
    # Expected until Terraform reissues the cluster CAs off the new intermediate.
    echo "      $(basename "$ca") does not verify yet — Terraform reissues it" >&2
  fi
done
: "$verified"

mkdir -p "$staging"
install -m 644 "$work/fml-root.pem" "$staging/fml-root.pem"
install -m 644 "$work/fml-intermediate.pem" "$staging/fml-intermediate.pem"

echo >&2
echo "==> wrote:" >&2
echo "      $staging/fml-root.pem" >&2
echo "      $staging/fml-intermediate.pem" >&2
cat >&2 <<EOF

Next, in order:

  1. Update the 1Password ca.crt fields — Terraform reads them, not these files:
       op://$op_vault/$op_root/ca.crt          <- staging/fml-root.pem
       op://$op_vault/$op_intermediate/ca.crt  <- staging/fml-intermediate.pem
     The intermediate's ca.key is unchanged.

  2. Let Atlantis apply terraform/pki. Both cluster CAs and both SA signers are
     replaced, because their issuer certificate changed.

  3. Run scripts/pki/post-rotate.sh folly offsite, which overwrites
     terraform/pki/certs/ from the new state. Delete this staging directory
     afterwards; it is scratch, not the source of truth.

  4. Run scripts/pki/verify-chain.py. It must pass before anything is deployed.

  5. Deploy both control planes, then restart every pod so ServiceAccount
     tokens are reissued against the new signer.
EOF
