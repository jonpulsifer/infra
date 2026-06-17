#!/usr/bin/env bash
set -euo pipefail

# disko-partlabel-migrate — relabel a pre-disko host's GPT partitions in place so
# they resolve at /dev/disk/by-partlabel/disk-main-{ESP,nixos,storage}, matching
# the fileSystems disko generates (nix/disko/default.nix).
#
# NON-DESTRUCTIVE: this only rewrites the GPT partition NAME field via `sgdisk`.
# It does not touch any filesystem, its data, or its filesystem LABEL — so the
# rolled-back (by-label) generations stay bootable too. You can't brick yourself.
#
# Run it while booted on a known-good generation. Dry-run by default:
#   sudo bash disko-partlabel-migrate.sh            # show the plan, change nothing
#   sudo bash disko-partlabel-migrate.sh --apply    # rename, then reboot to verify
#
# After --apply, reboot and let the host boot its current (by-partlabel) generation.

usage() { sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; }

apply=0
assume_yes=0
disk_override=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)   apply=1; shift ;;
    --yes|-y)  assume_yes=1; shift ;;   # skip the confirm prompt (needed when piped via `bash -s`)
    --disk)    disk_override="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

declare -A EXPECT=(
  ["/boot"]="disk-main-ESP"
  ["/"]="disk-main-nixos"
  ["/mnt/disks"]="disk-main-storage"
)
declare -A OPTIONAL=( ["/mnt/disks"]=1 )

# Helpers must never fail under `set -e` — an absent/empty mount is a normal,
# handled case, not a script-aborting error.
source_of()    { findmnt -no SOURCE "$1" 2>/dev/null | head -n1 || true; }
partlabel_of() { lsblk -no PARTLABEL "$1" 2>/dev/null | head -n1 || true; }
parent_of()    { lsblk -no PKNAME "$1" 2>/dev/null | head -n1 || true; }
partnum_of()   { cat "/sys/class/block/$(basename "$1")/partition" 2>/dev/null || true; }
is_partition() { [[ -r "/sys/class/block/$(basename "$1")/partition" ]]; }

sgdisk_run() {
  if command -v sgdisk >/dev/null 2>&1; then sgdisk "$@"
  else nix shell nixpkgs#gptfdisk --command sgdisk "$@"; fi
}

host="$(hostname)"
echo ">> Host: ${host}  (mode: $([[ $apply -eq 1 ]] && echo APPLY || echo dry-run))"

# Build the rename plan from live mounts.
declare -a plan_num plan_label plan_dev
disk=""
for mnt in /boot / /mnt/disks; do
  want="${EXPECT[$mnt]}"
  src="$(source_of "$mnt")"
  if [[ -z "${src}" ]]; then
    [[ -n "${OPTIONAL[$mnt]:-}" ]] && { echo "   ${mnt}: absent (optional) — skipping"; continue; }
    echo "!! ${mnt} is not mounted; refusing to guess. Aborting." >&2; exit 2
  fi
  dev="$(realpath "$src" 2>/dev/null || echo "$src")"
  is_partition "$dev" || { echo "!! ${mnt} -> ${dev} is not a plain GPT partition; aborting." >&2; exit 2; }

  d="$(parent_of "$dev")"
  if [[ -z "$disk" ]]; then disk="$d"; elif [[ "$disk" != "$d" ]]; then
    echo "!! ${mnt} lives on /dev/${d}, expected /dev/${disk}; mounts span disks. Aborting." >&2; exit 2
  fi

  cur="$(partlabel_of "$dev")"
  if [[ "${cur}" == "${want}" ]]; then
    echo "   ${mnt}: ${dev} already labelled '${want}' — ok"
  else
    echo "   ${mnt}: ${dev} '${cur:-<none>}' -> '${want}'"
    plan_num+=("$(partnum_of "$dev")"); plan_label+=("$want"); plan_dev+=("$dev")
  fi
done

target_disk="/dev/${disk}"
[[ -n "$disk_override" ]] && target_disk="$disk_override"

if [[ ${#plan_num[@]} -eq 0 ]]; then
  echo ">> Nothing to do — partition labels already match disko. Exiting."
  exit 0
fi

# Assemble: sgdisk -c N:label -c N:label ... /dev/<disk>
sgargs=()
for i in "${!plan_num[@]}"; do sgargs+=(-c "${plan_num[$i]}:${plan_label[$i]}"); done

echo ""
echo ">> Planned command:"
echo "   sgdisk ${sgargs[*]} ${target_disk}"

if [[ $apply -ne 1 ]]; then
  echo ""
  echo ">> Dry-run only. Re-run with --apply to perform the rename."
  exit 0
fi

[[ "$(id -u)" -eq 0 ]] || { echo "!! --apply must run as root." >&2; exit 1; }
echo ""
echo "!! This rewrites GPT partition names on ${target_disk} (no data is touched)."
if [[ $assume_yes -ne 1 ]]; then
  read -rp "Type the host name '${host}' to continue: " confirm
  [[ "${confirm}" == "${host}" ]] || { echo "Aborted."; exit 1; }
fi

echo ">> Relabelling ..."
sgdisk_run "${sgargs[@]}" "${target_disk}"

echo ">> Refreshing kernel/udev view ..."
partprobe "${target_disk}" 2>/dev/null || true
udevadm trigger --subsystem-match=block 2>/dev/null || true
udevadm settle 2>/dev/null || true

echo ">> Verifying by-partlabel symlinks ..."
ok=1
for i in "${!plan_label[@]}"; do
  link="/dev/disk/by-partlabel/${plan_label[$i]}"
  if [[ -e "$link" ]] && [[ "$(realpath "$link")" == "$(realpath "${plan_dev[$i]}")" ]]; then
    echo "   ok: ${link} -> ${plan_dev[$i]}"
  else
    echo "   !! ${link} not resolving yet (will be recreated by udev at next boot)"
    ok=0
  fi
done

echo ""
if [[ $ok -eq 1 ]]; then
  echo ">> Done. Partlabels in place. Reboot to boot the current (by-partlabel) generation."
else
  echo ">> GPT updated on disk, but live symlinks lagged (disk busy). This is expected"
  echo "   while mounted — the initrd recreates them at boot. Reboot to verify."
fi
