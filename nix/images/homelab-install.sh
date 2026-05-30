flake_default="github:jonpulsifer/infra"

usage() {
  cat <<EOF
homelab-install — partition, format, and install a homelab host with disko

Usage: homelab-install <host> [flake-ref]

  <host>       NixOS host name (optiplex, riptide, shale, oldschool, retrofit)
  [flake-ref]  Flake to install from (default: ${flake_default})
                 branch: github:jonpulsifer/infra/my-branch
                 local:  /mnt/infra  or  .

DESTROYS all data on the target disk (homelab.disko.device in the host config),
partitions GPT boot/nixos/storage, formats, mounts at /mnt, and installs NixOS.
You will be asked to confirm.
EOF
}

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 0
fi

host="$1"
flake="${2:-$flake_default}"
target="${flake}#${host}"

echo ">> Host:  ${host}"
echo ">> Flake: ${flake}"
echo ">> Resolving target disk from the host config ..."
device="$(nix eval --raw "${flake}#nixosConfigurations.${host}.config.homelab.disko.device" 2>/dev/null || true)"
if [[ -n "${device}" ]]; then
  echo ">> Target disk: ${device}"
  lsblk "${device}" || true
else
  echo "!! Could not read homelab.disko.device; disko will use the configured device."
fi

echo ""
echo "!! This DESTROYS all data on the target disk and installs NixOS."
read -rp "Type the host name '${host}' to continue: " confirm
if [[ "${confirm}" != "${host}" ]]; then
  echo "Aborted."
  exit 1
fi

echo ">> Partitioning + formatting + mounting with disko ..."
disko --mode destroy,format,mount --flake "${target}"

echo ">> Installing NixOS to /mnt ..."
nixos-install --flake "${target}" --no-root-passwd

echo ">> Done. Reboot when ready:  sudo reboot"
