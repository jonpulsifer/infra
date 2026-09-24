#!/usr/bin/env bash
# Reissues the FML Root and Intermediate certificates at pathLen 2 and 1, keeping
# each key, subject and subject key ID, so the cluster CAs below them verify.
# The root key stays offline; the intermediate key defaults to 1Password.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"

op_vault="ib23znjeikv74p37f6mbfk7uya"
op_intermediate="ofl5zkj2rcjnexv3f45wc5i7aq"
op_root="ujhf4f5cwerdwtpn27fn52kvwq"

root_key=""
intermediate_key=""
declare -a bounds=()

usage() {
  cat >&2 <<'USAGE'
usage: reissue-trust-anchors.sh --root-key <path> [options]

  --root-key <path>          PEM private key for the FML Root CA (offline; required)
  --intermediate-key <path>  PEM private key for the Intermediate CA
                             (default: read from 1Password)
  --root-days <n>            Bound the root instead of never expiring
  --intermediate-days <n>    Bound the intermediate instead of never expiring

Writes new certificates to terraform/pki/certs/staging/ and verifies that the
existing cluster CAs still chain through them.
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
      bounds+=(--root-days "${2:?}")
      shift 2
      ;;
    --intermediate-days)
      bounds+=(--intermediate-days "${2:?}")
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

command -v go >/dev/null || {
  echo "missing required tool: go" >&2
  exit 1
}

# Holds this run's copy of the intermediate key, and is removed on exit.
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

(
  cd "$repo_root"
  go -C apps/fml-pki run . reissue \
    --root-key "$root_key" \
    --intermediate-key "$work/intermediate.key" \
    ${bounds[@]+"${bounds[@]}"}
)

cat >&2 <<EOF

Next, in order:

  1. Update the 1Password ca.crt fields — Terraform reads them, not these files:
       op://$op_vault/$op_root/ca.crt          <- staging/fml-root.pem
       op://$op_vault/$op_intermediate/ca.crt  <- staging/fml-intermediate.pem
     The intermediate's ca.key is unchanged.

  2. Plan and apply terraform/pki. The 1Password edit is not a git change, so
     nothing autoplans on its own — open a PR that touches terraform/pki/*.tf,
     or comment: atlantis plan -d terraform/pki
     Read the plan before applying. It must replace exactly four resources,
     all tls_locally_signed_cert (both cluster CAs, both SA signers), because
     their issuer certificate changed. Every tls_private_key must show no
     change: a diff there marks the 1Password key escrow for replacement, and
     its prevent_destroy fails the apply.

  3. Run scripts/pki/post-rotate.sh folly offsite, which overwrites
     terraform/pki/certs/ from the new state. Delete the staging directory
     afterwards; it is scratch, not the source of truth.

  4. Delete any *-ca-prev.pem and *-sa-signer-prev.pem it wrote, then rerun it.
     Those are overlap artifacts for a key rotation. This is not one — the keys
     survive, so the previous certificates protect nothing, and a duplicate
     signer certificate publishes the same JWKS kid twice.

  5. Run mise run pki:verify. It must pass before anything is deployed.

  6. Distribute the chain. certs/<cluster>-ca-chain.pem is the file pods need:
     kube-controller-manager publishes it through --root-ca-file, which becomes
     every pod's ca.crt, and it carries the cluster CA up to the self-signed
     root that an OpenSSL client can anchor on.

     Never merge the anchors into certs/<cluster>-ca-bundle.pem. That file
     feeds services.kubernetes.caFile, which also backs clientCaFile and
     kubeletClientCaFile: anything issued anywhere under the FML Root would
     then authenticate to the API server.

  7. Restart cfssl and kube-controller-manager on each control plane after the
     rebuild. sops-nix compares decrypted plaintext to decide restarts and the
     keys are unchanged, so neither unit bounces on its own — cfssl keeps
     serving the old CA and kube-root-ca.crt is never republished.
EOF
