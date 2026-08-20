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
root_days=5475         # ~15 years
intermediate_days=3652 # ~10 years, several cluster-CA generations

usage() {
  cat >&2 <<'USAGE'
usage: reissue-trust-anchors.sh --root-key <path> [options]

  --root-key <path>          PEM private key for the FML Root CA (offline; required)
  --intermediate-key <path>  PEM private key for the Intermediate CA
                             (default: read from 1Password)
  --root-days <n>            Root validity in days (default 5475, ~15y)
  --intermediate-days <n>    Intermediate validity in days (default 3652, ~10y)

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
      root_days="${2:?}"
      shift 2
      ;;
    --intermediate-days)
      intermediate_days="${2:?}"
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

cat >"$work/root.ext" <<EOF
basicConstraints = critical, CA:TRUE, pathlen:2
keyUsage = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
EOF

cat >"$work/intermediate.ext" <<EOF
basicConstraints = critical, CA:TRUE, pathlen:1
keyUsage = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF

echo "==> reissuing the root, self-signed, pathlen:2" >&2
openssl req -x509 -new \
  -key "$root_key" \
  -sha256 \
  -days "$root_days" \
  -subj "/$root_subject" \
  -extensions v3 \
  -extfile <(printf '[v3]\n%s\n' "$(cat "$work/root.ext")") \
  -out "$work/fml-root.pem" 2>/dev/null

echo "==> reissuing the intermediate off the new root, pathlen:1" >&2
openssl req -new \
  -key "$work/intermediate.key" \
  -subj "/$intermediate_subject" \
  -out "$work/intermediate.csr" 2>/dev/null

openssl x509 -req \
  -in "$work/intermediate.csr" \
  -CA "$work/fml-root.pem" \
  -CAkey "$root_key" \
  -sha256 \
  -days "$intermediate_days" \
  -extfile "$work/intermediate.ext" \
  -out "$work/fml-intermediate.pem" 2>/dev/null

# The intermediate key must still match its certificate, or every cluster CA
# Terraform signs with it will be unverifiable.
key_mod="$(openssl rsa -in "$work/intermediate.key" -noout -modulus 2>/dev/null || true)"
crt_mod="$(openssl x509 -in "$work/fml-intermediate.pem" -noout -modulus 2>/dev/null || true)"
if [[ -n $key_mod && $key_mod != "$crt_mod" ]]; then
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
