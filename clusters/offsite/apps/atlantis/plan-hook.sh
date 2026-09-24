#!/bin/bash
# Atlantis runs hooks inside the pull request's clone. Running conftest from the
# read-only policy mount keeps a conftest.toml in the pull request from changing
# the verdict.
set -euo pipefail
cd /home/atlantis/policies
printf '{"user":"%s"}' "${USER_NAME:-}" \
  | conftest test --no-color --no-fail=false --namespace hooks -p only-me.rego -
