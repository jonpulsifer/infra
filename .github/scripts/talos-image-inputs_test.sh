#!/usr/bin/env bash
# Tests talos-image-inputs.sh against fixtures and folly's real talos.tf.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/talos-image-inputs.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

expect() {
  local name=$1 want=$2 got
  got=$(bash "$script" "$work/$name.tf" | jq -c .) || fail "$name: exited non-zero"
  [[ "$got" == "$want" ]] || fail "$name: got $got, want $want"
}

expect_error() {
  local name=$1
  if bash "$script" "$work/$name.tf" >/dev/null 2>&1; then
    fail "$name: want an error"
  fi
}

cat >"$work/multiline.tf" <<'HCL'
module "talos" {
  # renovate: datasource=github-releases depName=siderolabs/talos
  talos_version  = "v1.14.2"
  talos_contract = "v1.14"

  # Order is part of the schematic ID.
  extensions = [
    "siderolabs/gvisor", # the sandbox runtime
    // "siderolabs/commented-out",
    "siderolabs/i915",
  ]
  extra_kernel_args = [
    "talos.config=https://example.invalid/c?a=1#frag",
    "-console", "net.ifnames=0",
  ]
}
HCL
expect multiline '{"talos_version":"v1.14.2","extensions":["siderolabs/gvisor","siderolabs/i915"],"extra_kernel_args":["talos.config=https://example.invalid/c?a=1#frag","-console","net.ifnames=0"]}'

cat >"$work/oneline.tf" <<'HCL'
module "talos" {
  talos_version = "v1.15.0"
  extensions    = ["siderolabs/intel-ucode", "siderolabs/realtek-firmware"]
}
HCL
expect oneline '{"talos_version":"v1.15.0","extensions":["siderolabs/intel-ucode","siderolabs/realtek-firmware"],"extra_kernel_args":[]}'

cat >"$work/no-extensions.tf" <<'HCL'
talos_version = "v1.14.2"
HCL
expect_error no-extensions

cat >"$work/two-versions.tf" <<'HCL'
talos_version = "v1.14.2"
talos_version = "v1.14.3"
extensions = ["siderolabs/gvisor"]
HCL
expect_error two-versions

cat >"$work/bad-version.tf" <<'HCL'
talos_version = "1.14"
extensions = ["siderolabs/gvisor"]
HCL
expect_error bad-version

cat >"$work/bad-extension.tf" <<'HCL'
talos_version = "v1.14.2"
extensions = ["gvisor"]
HCL
expect_error bad-extension

cat >"$work/duplicate-list.tf" <<'HCL'
talos_version = "v1.14.2"
extensions = ["siderolabs/gvisor"]
extensions = ["siderolabs/i915"]
HCL
expect_error duplicate-list

real=$(bash "$script" "$here/../../clusters/folly/talos/talos.tf") || fail "folly: exited non-zero"
jq -e '(.talos_version | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and (.extensions | length > 0)' <<<"$real" >/dev/null \
  || fail "folly: unexpected inputs $real"

echo "talos-image-inputs: ok"
