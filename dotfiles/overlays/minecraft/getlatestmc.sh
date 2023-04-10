#!/usr/bin/env bash

set -xeuo pipefail -o errexit
shopt -s inherit_errexit

ensure_dependencies() {
  local -r deps="curl jq"
  for dep in ${deps}; do
    hash "${dep}" || { echo -e "${dep} not found.\nEnsure ${dep} is installed and in your PATH">&2; exit 1; };
  done
}

get_latest_release_url() {
  local -r url="https://launchermeta.mojang.com/mc/game/version_manifest.json"
  curl -s "${url}" | jq -r '.latest.release as $latest | .versions[] | select(.id==$latest).url'
}

get_server_jar_url() {
  local -r url=$(get_latest_release_url)
  [[ -n "${url}" ]] || { echo "Could not retrieve latest release url"; exit 1; };
  curl -s "${url}" | jq -r '.downloads.server.url'
}

ensure_dependencies

url="$(get_server_jar_url)"

echo "${url}"

# uncomment to download the server jar
# curl -sSL -o server.jar "${url}"

# for nix
# nix store prefetch-file "${url}"
